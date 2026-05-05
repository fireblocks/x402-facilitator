/**
 * zod schema for config/facilitator.json.
 *
 * Top-level holds one tenant, a shared `assets[]` catalog (global —
 * token metadata doesn't vary by merchant), and one or more
 * configurations (per-merchant isolation: Fireblocks creds, API keys,
 * products, deposit-address cache).
 *
 * Products' `pricing[].asset_id` references the global catalog; there
 * is no per-configuration `assets` list. Products implicitly define
 * which assets a configuration accepts.
 *
 * Legacy configs with `configurations[].assets[]` are lifted to the
 * top-level catalog (first occurrence of an asset_id wins) on load.
 */

import { z } from 'zod';

const apiKeySchema = z.object({
  key_id: z.string().min(1),
  hash: z.string().min(1),
  scopes: z.array(z.string()),
  label: z.string().nullable().optional(),
});

const fireblocksBaseSchema = z.object({
  api_key: z.string(),
  api_secret_path: z.string(),
  receiver_vault: z.string(),
  base_url: z.string().url().default('https://api.fireblocks.io'),
  /**
   * Cached Fireblocks `getDepositAddresses(vault, asset_id)` results,
   * keyed by asset_id. Purely a cache — miss triggers a runtime SDK
   * call. Populated by `x402 fireblocks test`.
   */
  deposit_address_cache: z.record(z.string().min(1), z.string()).default({}),
});

const fireblocksSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const { receiver_address: _ra, receiver_addresses: _ras, ...rest } = obj;
  return { ...rest, deposit_address_cache: rest.deposit_address_cache ?? {} };
}, fireblocksBaseSchema);

const assetSchema = z.object({
  asset_id: z.string().min(1),
  /**
   * Fireblocks blockchain identifier (UUID). Canonical link to the
   * Fireblocks blockchains catalog. chain_id below is a cached EIP-155
   * derivation populated at import time.
   */
  blockchain_id: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 40-hex address'),
  decimals: z.number().int().min(0).max(36),
  /** Cached EIP-155 numeric chain id, derived from blockchain_id at import. */
  chain_id: z.number().int().positive(),
  eip712_name: z.string(),
  eip712_version: z.string(),
  transfer_mechanism: z.enum(['eip-3009', 'permit2', 'upto-permit2', 'erc7710']),
  /**
   * True for testnet chains (Sepolia, Base Sepolia, etc.); false for
   * production chains (Ethereum L1, Base, Polygon, …). Populated at
   * import time from Fireblocks' `blockchain.onchain.test` flag.
   * The server refuses to boot with `is_testnet: false` assets unless
   * the operator sets `X402_ALLOW_MAINNET=true`.
   */
  is_testnet: z.boolean(),
  /** If true, asset is pegged 1:1 to USD — no price-provider call needed. */
  stable: z.boolean().default(false),
  /**
   * Optional identifier for an external price oracle (e.g. CoinGecko id
   * "ethereum"). Required when `stable` is false AND any product prices
   * against this asset using usd_price conversion.
   */
  price_symbol: z.string().min(1).nullable().optional(),
});

const productPricingSchema = z.object({
  asset_id: z.string().min(1),
  amount: z.number().nonnegative().nullable().optional(),
  /**
   * Optional per-row override of the transfer mechanism. Lets a single
   * asset be offered through multiple mechanisms — e.g. the same USDC
   * contract advertised as both `eip-3009` and `permit2`. When omitted,
   * the asset's own `transfer_mechanism` is used.
   */
  transfer_mechanism: z
    .enum(['eip-3009', 'permit2', 'upto-permit2', 'erc7710'])
    .optional(),
});

const productNewShape = z.object({
  product_id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().startsWith('/'),
  scheme: z.enum(['exact', 'upto']).default('exact'),
  usd_price: z.number().nonnegative().nullable().optional(),
  pricing: z.array(productPricingSchema).min(1),
  description: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  is_discoverable: z.boolean().default(false),
});

const productSchema = z
  .preprocess((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj.asset_id === 'string' &&
      typeof obj.price === 'number' &&
      obj.pricing === undefined
    ) {
      const { asset_id, price, ...rest } = obj;
      return {
        ...rest,
        pricing: [{ asset_id, amount: price }],
      };
    }
    return obj;
  }, productNewShape)
  .superRefine((p, ctx) => {
    const needsUsd = p.pricing.some((row) => row.amount === null || row.amount === undefined);
    if (needsUsd && (p.usd_price === null || p.usd_price === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usd_price'],
        message:
          'usd_price is required when any pricing[].amount is omitted (needed for runtime conversion)',
      });
    }
    const seen = new Set<string>();
    for (const [i, row] of p.pricing.entries()) {
      // Uniqueness is per (asset_id, transfer_mechanism) pair — a single
      // asset can legitimately be offered under multiple mechanisms
      // (e.g. USDC via both eip-3009 and permit2). When transfer_mechanism
      // is omitted the asset's own default fills in at resolve time; at
      // schema-validation time we simply treat undefined as its own key.
      const key = `${row.asset_id}::${row.transfer_mechanism ?? ''}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pricing', i, 'asset_id'],
          message: `Duplicate pricing entry for ${row.asset_id}${
            row.transfer_mechanism ? ` (${row.transfer_mechanism})` : ''
          }`,
        });
      }
      seen.add(key);
    }
  });

/**
 * Payment Instruction Integrity (PII) signing config.
 *
 * When `enabled: true`, `/api/payments/create` attaches a signed
 * envelope (`integrity` field on the response body; also mirrored as
 * `X-402-Integrity` header by the merchant SDK) that wallets can
 * verify against the `did`'s public key. See the PII spec draft and
 * the README section for the canonical payload format.
 *
 * Entirely optional — configurations without this block run as before.
 */
const integritySchema = z.object({
  enabled: z.boolean().default(false),
  /** Path to the ES256 (P-256) private key PEM. */
  private_key_path: z.string().min(1),
  /** did:web identifier (e.g. "did:web:api.example.com"). */
  did: z.string().regex(/^did:web(vh)?:/, 'did must be a did:web or did:webvh identifier'),
  /** Key id within the DID document (e.g. "key-1"). */
  kid: z.string().min(1).default('key-1'),
  /** Signing algorithm. MVP supports only ES256. */
  alg: z.enum(['ES256']).default('ES256'),
  /** Envelope lifetime in seconds. Default 5 minutes. */
  ttl_seconds: z.number().int().positive().default(300),
  /**
   * If true, the facilitator exposes `GET /.well-known/did.json` for
   * the configuration (resolved by Host header against public_host).
   * If false, the operator is responsible for hosting the did.json at
   * whatever domain the `did:web:…` resolves to.
   */
  serve_did_document: z.boolean().default(false),
});

const configurationBaseSchema = z.object({
  configuration_id: z.string().min(1),
  public_host: z.string().url(),
  fireblocks: fireblocksSchema,
  api_keys: z.array(apiKeySchema).default([]),
  products: z.array(productSchema).default([]),
  integrity: integritySchema.optional(),
});

// Tolerate legacy `upstream_host` from the proxy-mode era.
const configurationSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const { upstream_host: _legacy, ...rest } = raw as Record<string, unknown>;
  return rest;
}, configurationBaseSchema);

/**
 * Top-level preprocess: lift any legacy `configurations[].assets[]`
 * into a shared `assets` array at the root, deduplicating by asset_id
 * (first occurrence wins). Keeps old configs loading without manual
 * migration.
 */
const configFileInputPreprocess = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const configurations = Array.isArray(obj.configurations) ? [...obj.configurations] : [];
  const assetsTop = Array.isArray(obj.assets) ? [...(obj.assets as unknown[])] : [];
  const seen = new Set<string>(
    assetsTop
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => String((a as any).asset_id))
      .filter(Boolean),
  );
  const liftedConfigurations = configurations.map((c) => {
    if (typeof c !== 'object' || c === null) return c;
    const cObj = c as Record<string, unknown>;
    if (!Array.isArray(cObj.assets)) return cObj;
    for (const a of cObj.assets as unknown[]) {
      if (typeof a !== 'object' || a === null) continue;
      const assetId = String((a as any).asset_id);
      if (!assetId || seen.has(assetId)) continue;
      seen.add(assetId);
      assetsTop.push(a);
    }
    const { assets: _removed, ...rest } = cObj;
    return rest;
  });
  return { ...obj, assets: assetsTop, configurations: liftedConfigurations };
}, z.object({
  tenant_id: z.string().min(1).default('default'),
  default_configuration_id: z.string().min(1).default('default'),
  assets: z.array(assetSchema).default([]),
  configurations: z.array(configurationSchema).min(1),
}));

export const configFileSchema = configFileInputPreprocess.superRefine((data, ctx) => {
  // Dedupe configuration_ids.
  const seen = new Set<string>();
  for (const [i, c] of data.configurations.entries()) {
    if (seen.has(c.configuration_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configurations', i, 'configuration_id'],
        message: `Duplicate configuration_id: ${c.configuration_id}`,
      });
    }
    seen.add(c.configuration_id);
  }
  if (!seen.has(data.default_configuration_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default_configuration_id'],
      message: `default_configuration_id '${data.default_configuration_id}' does not match any configurations[].configuration_id`,
    });
  }

  // Dedupe asset_ids at top level.
  const assetIds = new Set<string>();
  for (const [i, a] of data.assets.entries()) {
    if (assetIds.has(a.asset_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', i, 'asset_id'],
        message: `Duplicate asset_id at top level: ${a.asset_id}`,
      });
    }
    assetIds.add(a.asset_id);
  }

  // Cross-ref: every product.pricing[].asset_id must exist in top-level assets[].
  for (const [i, c] of data.configurations.entries()) {
    for (const [pIdx, p] of c.products.entries()) {
      for (const [rIdx, row] of p.pricing.entries()) {
        if (!assetIds.has(row.asset_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['configurations', i, 'products', pIdx, 'pricing', rIdx, 'asset_id'],
            message: `Product references unknown asset_id '${row.asset_id}' — add it under top-level assets[].`,
          });
        }
      }
    }
  }
});

export type ConfigFileShape = z.infer<typeof configFileSchema>;
export type ConfigurationShape = z.infer<typeof configurationSchema>;
export type ApiKeyShape = z.infer<typeof apiKeySchema>;
export type AssetShape = z.infer<typeof assetSchema>;
export type IntegrityShape = z.infer<typeof integritySchema>;
export type ProductShape = z.infer<typeof productSchema>;
export type ProductPricingShape = z.infer<typeof productPricingSchema>;
