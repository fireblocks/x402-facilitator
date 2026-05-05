#!/usr/bin/env node
/**
 * One-shot migration from the legacy multi-tenant SQLite schema into
 * the single-tenant facilitator.json shape.
 *
 * Local-only — reads a SQLite file directly off disk. The remote CLI
 * deliberately has no equivalent.
 *
 * Flags:
 *   --db <path>                 Legacy facilitator.db (default ./data/facilitator.db)
 *   --out <path>                Destination config (default $CONFIG_PATH)
 *   --configuration-id <id>     configuration_id to emit (default "default")
 *   --force                     Overwrite an existing destination
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ConfigFile, resolveConfigPath } from '../src/config/configFile';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(args.db || './data/facilitator.db');
if (!fs.existsSync(dbPath)) die(`SQLite file not found: ${dbPath}`);
const outPath = path.resolve(args.out || resolveConfigPath());
const force = args.force === 'true';
if (fs.existsSync(outPath) && !force) {
  die(`Refusing to overwrite ${outPath} (pass --force)`);
}
const configurationId = args['configuration-id'] || 'default';

const db = new Database(dbPath, { readonly: true });

const tenants = db.prepare('SELECT * FROM tenants LIMIT 1').all() as any[];
if (tenants.length === 0) die('No tenants in source DB');
const tenant = tenants[0];

const tokens = db.prepare('SELECT * FROM tokens').all() as any[];
const blockchains = new Map(
  (db.prepare('SELECT * FROM blockchains').all() as any[]).map((b) => [b.blockchain_id, b]),
);
const products = db
  .prepare('SELECT * FROM products WHERE tenant_id = ?')
  .all(tenant.tenant_id) as any[];

const assetIdFor = (tok: any, chainId: number): string => {
  const chainSuffix = chainId === 8453 ? 'BASE' : `CHAIN_${chainId}`;
  return `${tok.symbol}_${chainSuffix}`;
};

const outAssets = tokens.map((tok) => {
  const bc = blockchains.get(tok.blockchain_id);
  if (!bc) die(`Token ${tok.token_id} references unknown blockchain`);
  return {
    asset_id: assetIdFor(tok, bc.chain_id),
    blockchain_id: 'unknown',
    address: tok.address,
    decimals: tok.decimals,
    chain_id: bc.chain_id,
    eip712_name: tok.eip712_name ?? tok.name,
    eip712_version: tok.eip712_version ?? '2',
    transfer_mechanism: tok.transfer_mechanism ?? 'eip-3009',
  };
});

const outProducts = products.map((p) => {
  const tok = tokens.find((t) => t.token_id === p.payment_token_id);
  if (!tok) die(`Product ${p.product_id} references unknown token`);
  const bc = blockchains.get(tok.blockchain_id);
  return {
    product_id: p.product_id,
    name: p.name,
    endpoint: p.endpoint,
    asset_id: assetIdFor(tok, bc.chain_id),
    price: p.price,
    scheme: p.scheme ?? 'exact',
    description: p.description ?? null,
    mime_type: p.mime_type ?? 'application/json',
    category: p.category ?? null,
    is_discoverable: !!p.is_discoverable,
  };
});

const next = {
  tenant_id: tenant.tenant_id ?? 'default',
  default_configuration_id: configurationId,
  configurations: [
    {
      configuration_id: configurationId,
      public_host: tenant.public_host ?? 'http://localhost:3000',
      fireblocks: {
        api_key: tenant.fireblocks_api_key ?? '',
        api_secret_path: './secrets/fireblocks.pem',
        receiver_vault: tenant.fireblocks_receiver_vault ?? '0',
        base_url: tenant.fireblocks_base_url ?? 'https://api.fireblocks.io',
        deposit_address_cache: {},
      },
      api_keys: [],
      assets: outAssets,
      products: outProducts,
    },
  ],
};

const outFile = new ConfigFile(outPath);
outFile.write(next as never);
console.log(`✓ Wrote ${outPath}`);
console.log(`  tenant_id:       ${next.tenant_id}`);
console.log(`  configuration:   ${configurationId}`);
console.log(`  assets:          ${outAssets.length}`);
console.log(`  products:        ${outProducts.length}`);
console.log('');
console.log('Note: legacy fireblocks_api_secret is NOT migrated — set api_secret_path manually.');
console.log('Note: API keys need regeneration (x402 keys create).');
db.close();
