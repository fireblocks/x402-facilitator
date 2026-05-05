/**
 * Payment processing API — the agent/client-facing routes.
 *
 * - /supported          — public discovery of schemes/networks/extensions
 * - /create | /verify | /settle — require ApiTokenPrincipal with 'process-payments'
 *
 * Read-only listing lives under /api/admin/payments (see adminPayments.ts).
 */

import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { computeAuthorizationHash } from '../utils/authorizationHash';
import { FacilitatorRepository } from '../repositories/interfaces/FacilitatorRepository';
import { AssetRepository } from '../repositories/interfaces/AssetRepository';
import { ProductRepository } from '../repositories/interfaces/ProductRepository';
import {
  DuplicateAuthorizationError,
  InvalidStateTransitionError,
  PaymentRepository,
} from '../repositories/interfaces/PaymentRepository';
import { MechanismRegistry } from '../mechanisms';
import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';
import { PricingService, QuotedAsset } from '../services/pricing';
import { requireScope } from '../middleware/auth';
import { X402_EXACT_PERMIT2_PROXY } from '../mechanisms/Permit2Mechanism';
import { X402_UPTO_PERMIT2_PROXY } from '../mechanisms/UptoPermit2Mechanism';
import {
  MDF_DELEGATION_MANAGER,
  MDF_EIP7702_STATELESS_DELEGATOR,
} from '../mechanisms/Erc7710Mechanism';
import { TenantScope } from '../core/tenantScope';
import {
  V2PaymentPayload,
  V2PaymentRequired,
  V2PaymentRequirements,
  V2SettlementResponse,
  V2SupportedResponse,
  V2VerifyResponse,
  X402ErrorCode,
} from '../types/entities';
import { IntegritySignerFactory } from '../services/integrity/IntegritySigner';
import { ConfigFile } from '../config/configFile';

export interface PaymentRoutesDeps {
  facilitator: FacilitatorRepository;
  assets: AssetRepository;
  products: ProductRepository;
  payments: PaymentRepository;
  mechanismRegistry: MechanismRegistry;
  fireblocksFactory: FireblocksSettlementFactory;
  pricing: PricingService;
  integrityFactory: IntegritySignerFactory;
  configFile: ConfigFile;
}

export function createPaymentRoutes(deps: PaymentRoutesDeps): Router {
  const router = Router();

  async function resolveReceiverAddress(
    scope: TenantScope,
    asset: { assetId: string; chainId: number },
  ): Promise<string> {
    const cfg = deps.facilitator.get(scope);
    const cached = cfg.fireblocks.depositAddressCache[asset.assetId];
    if (cached) return cached;
    return deps.fireblocksFactory.get(scope, asset.chainId).getWalletAddress();
  }

  function quoteToRequirements(
    quote: QuotedAsset,
    productScheme: string,
    merchantAddress: string,
  ): V2PaymentRequirements {
    const asset = quote.asset;
    const mechanism = quote.mechanism;
    const assetTransferMethod = mechanism.replace(/-/g, '');
    const extra: Record<string, unknown> = {
      assetTransferMethod,
      name: asset.eip712Name,
      version: asset.eip712Version,
    };
    if (mechanism === 'permit2') {
      extra.permit2ProxyAddress = X402_EXACT_PERMIT2_PROXY;
      extra.permit2Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
    }
    if (productScheme === 'upto' || mechanism === 'upto-permit2') {
      extra.permit2ProxyAddress = X402_UPTO_PERMIT2_PROXY;
      extra.permit2Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
      extra.facilitatorAddress = merchantAddress;
    }
    if (mechanism === 'erc7710') {
      // MetaMask Delegation Framework addresses (identical across chains).
      // The client signs a Delegation EIP-712 against `delegationManager`'s
      // domain; for plain EOAs the signer must first upgrade via EIP-7702
      // to point its code at `eip7702StatelessDelegator`.
      extra.delegationManager = MDF_DELEGATION_MANAGER;
      extra.eip7702StatelessDelegator = MDF_EIP7702_STATELESS_DELEGATOR;
      extra.delegate = merchantAddress;
    }
    if (quote.priceUsd !== null) {
      extra.priceUsd = quote.priceUsd;
      extra.pricedAt = quote.pricedAt?.toISOString();
      extra.priceSource = quote.source;
    }
    return {
      scheme: productScheme,
      network: `eip155:${asset.chainId}`,
      amount: quote.amountBaseUnits.toString(),
      asset: asset.address,
      payTo: merchantAddress,
      maxTimeoutSeconds: 300,
      extra: extra as any,
    };
  }

  /**
   * POST /create — returns PaymentRequired for a configured product.
   * Quotes every asset in product.pricing; drops the ones that fail.
   */
  router.post('/create', requireScope('process-payments'), async (req: Request, res: Response) => {
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const scope = req.scope;
      const { product_id } = req.body;
      if (!product_id) {
        res.status(400).json({ error: 'Missing required field: product_id' });
        return;
      }
      const product = deps.products.get(scope, product_id);
      if (!product) {
        res.status(404).json({ error: `Product ${product_id} not found` });
        return;
      }

      const quoteResult = await deps.pricing.quoteProduct(scope, product);
      if (quoteResult.quotes.length === 0) {
        res.status(503).json({
          error: 'No payment options available',
          details: quoteResult.rejected,
        });
        return;
      }

      const assetReceivers = new Map<string, string>();
      for (const q of quoteResult.quotes) {
        if (!assetReceivers.has(q.asset.assetId)) {
          assetReceivers.set(q.asset.assetId, await resolveReceiverAddress(scope, q.asset));
        }
      }
      const accepts = quoteResult.quotes.map((q) => {
        const entry = quoteToRequirements(
          q,
          product.scheme,
          assetReceivers.get(q.asset.assetId)!,
        );
        // Thread the product_id through so /settle can persist a payment
        // row tied to the right product without a reverse lookup.
        (entry.extra as Record<string, unknown>).productId = product.productId;
        return entry;
      });

      const cfg = deps.facilitator.get(scope);
      const paymentRequired: V2PaymentRequired = {
        x402Version: 2,
        error: 'PAYMENT-SIGNATURE header is required',
        resource: {
          url: `${cfg.publicHost}${product.endpoint}`,
          description: product.description || product.name,
          mimeType: product.mimeType || 'application/json',
        },
        accepts,
        extensions: {},
      };

      // Payment Instruction Integrity — sign the entire body if the
      // configuration has a keypair configured. The signature covers
      // the canonical form of this exact object (before the envelope
      // is attached), so wallets can reconstruct and verify.
      const integrityConf = deps.configFile.getConfiguration(scope.configurationId).integrity;
      const signer = deps.integrityFactory.get(integrityConf);
      if (signer) {
        try {
          const signed = signer.sign(paymentRequired);
          paymentRequired.integrity = signed.envelope;
        } catch (err) {
          console.error('[payments] integrity sign failed (continuing without):', err);
        }
      }

      res.status(201).json(paymentRequired);
    } catch (err) {
      console.error('[payments] create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /supported — advertise schemes/networks/extensions.
   */
  router.get('/supported', (req: Request, res: Response) => {
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const allAssets = deps.assets.list();
      const kindsSet = new Set<string>();
      const kinds: Array<{ x402Version: 2; scheme: string; network: string }> = [];
      for (const a of allAssets) {
        const network = `eip155:${a.chainId}`;
        const schemes = new Set<string>(['exact']);
        if (a.transferMechanism === 'permit2' || a.transferMechanism === 'upto-permit2') {
          schemes.add('upto');
        }
        for (const scheme of schemes) {
          const key = `${scheme}:${network}`;
          if (!kindsSet.has(key)) {
            kindsSet.add(key);
            kinds.push({ x402Version: 2, scheme, network });
          }
        }
      }
      // Build signers map per-chain by grouping cached asset addresses.
      const signers: Record<string, string[]> = {};
      const cache = deps.facilitator.get(req.scope).fireblocks.depositAddressCache;
      for (const a of allAssets) {
        const addr = cache[a.assetId];
        if (!addr) continue;
        const key = `eip155:${a.chainId}`;
        if (!signers[key]) signers[key] = [];
        if (!signers[key].includes(addr)) signers[key].push(addr);
      }
      const response: V2SupportedResponse = {
        kinds,
        extensions: [
          'payment-identifier',
          'eip2612GasSponsoring',
          'erc20ApprovalGasSponsoring',
        ],
        signers,
      };
      res.status(200).json(response);
    } catch (err) {
      console.error('[payments] supported error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * Resolve an asset from the (address, network) pair that a client
   * sends in paymentRequirements. Used by verify/settle.
   */
  function findAssetByRequirements(scope: TenantScope, reqs: V2PaymentRequirements) {
    const all = deps.assets.list();
    return all.find(
      (a) =>
        a.address.toLowerCase() === reqs.asset.toLowerCase() &&
        `eip155:${a.chainId}` === reqs.network,
    );
  }

  /**
   * Defence in depth — the facilitator detects the mechanism from the
   * payload shape (permit2Authorization → permit2, delegation → erc7710,
   * else asset default). But the product may not have listed that
   * mechanism in its pricing rows. This helper cross-checks:
   *
   *   • Product must exist and be in this scope.
   *   • At least one pricing row must name the same (asset, mechanism)
   *     pair, resolving the row-level override against the asset's
   *     default when the row leaves it blank.
   *
   * Missing `extra.productId` is rejected: every legitimate flow comes
   * through a merchant that called /create, which injects it.
   */
  function validateProductMechanism(
    scope: TenantScope,
    paymentRequirements: V2PaymentRequirements,
    assetId: string,
    detectedMechanism: string,
  ): { ok: true } | { ok: false; status: number; error: string; details: string } {
    const productId = (paymentRequirements.extra as Record<string, unknown> | undefined)
      ?.productId;
    if (typeof productId !== 'string' || productId.length === 0) {
      return {
        ok: false,
        status: 400,
        error: X402ErrorCode.InvalidPaymentRequirements,
        details:
          'paymentRequirements.extra.productId is missing — this request did not originate from /api/payments/create',
      };
    }
    const product = deps.products.get(scope, productId);
    if (!product) {
      return {
        ok: false,
        status: 400,
        error: X402ErrorCode.InvalidPaymentRequirements,
        details: `Unknown product '${productId}' in this configuration`,
      };
    }
    const asset = deps.assets.get(assetId);
    const assetDefault = asset?.transferMechanism;
    const match = product.pricing.find(
      (row) =>
        row.assetId === assetId &&
        (row.transferMechanism ?? assetDefault) === detectedMechanism,
    );
    if (!match) {
      const offered = product.pricing
        .map((r) => `${r.assetId}:${r.transferMechanism ?? assetDefault ?? '?'}`)
        .join(', ');
      return {
        ok: false,
        status: 400,
        error: X402ErrorCode.UnsupportedScheme,
        details:
          `Product '${productId}' does not accept mechanism '${detectedMechanism}' for asset '${assetId}'. ` +
          `Offered: [${offered}].`,
      };
    }
    return { ok: true };
  }

  /**
   * Cap the merchant-claimed amount against the live product quote.
   *
   * For exact-amount schemes (eip-3009, permit2), the signed message
   * already binds the amount: if the merchant inflates
   * `paymentRequirements.amount` beyond what the user signed, the
   * mechanism's signature verification rejects it. No extra gate
   * needed.
   *
   * For `upto-permit2`, the user signs a *maximum* and the merchant
   * picks the actual charge within that ceiling. Signature alone does
   * not bind the claimed amount to the quoted price — a compromised
   * merchant API key could charge the full signed ceiling. This
   * function re-quotes the product at /settle time and rejects when
   * the claimed amount exceeds the live quote.
   *
   * Re-quoting (rather than persisting the /create quote) is
   * intentional: it keeps /create stateless and bounds the worst case
   * to "the live price at /settle" rather than letting a stale row
   * outlive the price's relevance.
   */
  async function validateClaimedAmount(
    scope: TenantScope,
    paymentRequirements: V2PaymentRequirements,
    assetId: string,
    detectedMechanism: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string; details: string }> {
    // Only enforce for variable-amount mechanisms. exact schemes are
    // covered by signature verification in the mechanism layer.
    if (detectedMechanism !== 'upto-permit2') return { ok: true };

    const productId = (paymentRequirements.extra as Record<string, unknown> | undefined)
      ?.productId as string;
    const product = deps.products.get(scope, productId);
    if (!product) return { ok: true }; // validateProductMechanism already rejected this case

    let claimed: bigint;
    try {
      claimed = BigInt(paymentRequirements.amount);
    } catch {
      return {
        ok: false,
        status: 400,
        error: X402ErrorCode.InvalidPaymentRequirements,
        details: `Invalid paymentRequirements.amount: ${paymentRequirements.amount}`,
      };
    }

    const quoteResult = await deps.pricing.quoteProduct(scope, product);
    const liveQuote = quoteResult.quotes.find(
      (q) => q.asset.assetId === assetId && q.mechanism === detectedMechanism,
    );
    if (!liveQuote) {
      return {
        ok: false,
        status: 503,
        error: X402ErrorCode.InvalidPaymentRequirements,
        details:
          `Could not re-quote product '${productId}' for asset '${assetId}' on '${detectedMechanism}'. ` +
          `Pricing oracle may be unavailable.`,
      };
    }
    if (claimed > liveQuote.amountBaseUnits) {
      return {
        ok: false,
        status: 400,
        error: X402ErrorCode.InvalidPaymentRequirements,
        details:
          `Claimed amount ${claimed} exceeds live quote ${liveQuote.amountBaseUnits} ` +
          `for product '${productId}' on '${detectedMechanism}'.`,
      };
    }
    return { ok: true };
  }

  router.post('/verify', requireScope('process-payments'), async (req: Request, res: Response) => {
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const scope = req.scope;
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload?: V2PaymentPayload;
        paymentRequirements?: V2PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({
          error: X402ErrorCode.InvalidPayload,
          details: 'Missing paymentPayload or paymentRequirements',
        });
        return;
      }

      const asset = findAssetByRequirements(scope, paymentRequirements);
      if (!asset) {
        res.status(400).json({
          error: X402ErrorCode.InvalidPaymentRequirements,
          details: 'No matching asset for (address, network)',
        });
        return;
      }

      const { authorization, permit2Authorization, delegation } = paymentPayload.payload;
      let mechanism = asset.transferMechanism;
      if (permit2Authorization) {
        mechanism = (permit2Authorization as any).witness?.facilitator ? 'upto-permit2' : 'permit2';
      }
      if (delegation) mechanism = 'erc7710';

      // Enforce that the product actually offers this mechanism on this asset.
      const productCheck = validateProductMechanism(
        scope,
        paymentRequirements,
        asset.assetId,
        mechanism,
      );
      if (!productCheck.ok) {
        res.status(productCheck.status).json({
          error: productCheck.error,
          details: productCheck.details,
        });
        return;
      }

      // For upto-permit2: cap merchant-claimed amount against the live
      // product quote. No-op for exact-amount schemes (their signature
      // already binds the amount).
      const amountCheck = await validateClaimedAmount(
        scope,
        paymentRequirements,
        asset.assetId,
        mechanism,
      );
      if (!amountCheck.ok) {
        res.status(amountCheck.status).json({
          error: amountCheck.error,
          details: amountCheck.details,
        });
        return;
      }

      const sigRaw = paymentPayload.payload.signature;
      let signature: any;
      if (typeof sigRaw === 'string') {
        const sig = ethers.Signature.from(sigRaw);
        signature = { v: sig.v, r: sig.r, s: sig.s };
      } else {
        signature = sigRaw;
      }

      const verifyMessage = permit2Authorization || delegation || authorization;
      const transferMechanism = deps.mechanismRegistry.getMechanism(mechanism);
      if (!transferMechanism) {
        res.status(400).json({
          error: X402ErrorCode.UnsupportedScheme,
          details: `Transfer mechanism '${mechanism}' not available`,
        });
        return;
      }

      const verificationResult = await transferMechanism.verify({
        tokenAddress: asset.address,
        tokenName: asset.eip712Name,
        tokenVersion: asset.eip712Version,
        chainId: asset.chainId,
        message: verifyMessage,
        signature,
        expectedAmount: BigInt(paymentRequirements.amount),
        expectedRecipient: paymentRequirements.payTo,
        provider: null,
      });

      const payer =
        verificationResult.signer ||
        (permit2Authorization?.from || authorization?.from || '').toLowerCase();

      if (!verificationResult.valid) {
        const out: V2VerifyResponse = {
          isValid: false,
          invalidReason: verificationResult.error || X402ErrorCode.InvalidSignature,
          payer,
        };
        res.status(200).json(out);
        return;
      }

      res.status(200).json({ isValid: true, payer } as V2VerifyResponse);
    } catch (err) {
      console.error('[payments] verify error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/settle', requireScope('process-payments'), async (req: Request, res: Response) => {
    let paymentId: string | null = null;
    const scopeForCatch = req.scope;
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const scope = req.scope;
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload?: V2PaymentPayload;
        paymentRequirements?: V2PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({
          error: X402ErrorCode.InvalidPayload,
          details: 'Missing paymentPayload or paymentRequirements',
        });
        return;
      }

      const asset = findAssetByRequirements(scope, paymentRequirements);
      if (!asset) {
        res.status(400).json({
          error: X402ErrorCode.InvalidPaymentRequirements,
          details: 'No matching asset for (address, network)',
        });
        return;
      }

      const { authorization, permit2Authorization, delegation } = paymentPayload.payload;
      let mechanism = asset.transferMechanism;
      if (permit2Authorization) {
        mechanism = (permit2Authorization as any).witness?.facilitator ? 'upto-permit2' : 'permit2';
      }
      if (delegation) mechanism = 'erc7710';

      // Enforce that the product actually offers this mechanism on this asset.
      const productCheck = validateProductMechanism(
        scope,
        paymentRequirements,
        asset.assetId,
        mechanism,
      );
      if (!productCheck.ok) {
        res.status(productCheck.status).json({
          error: productCheck.error,
          details: productCheck.details,
        });
        return;
      }

      // For upto-permit2: cap merchant-claimed amount against the live
      // product quote. No-op for exact-amount schemes (their signature
      // already binds the amount).
      const amountCheck = await validateClaimedAmount(
        scope,
        paymentRequirements,
        asset.assetId,
        mechanism,
      );
      if (!amountCheck.ok) {
        res.status(amountCheck.status).json({
          error: amountCheck.error,
          details: amountCheck.details,
        });
        return;
      }

      const sigRaw = paymentPayload.payload.signature;
      let signature: any;
      if (typeof sigRaw === 'string') {
        const sig = ethers.Signature.from(sigRaw);
        signature = { v: sig.v, r: sig.r, s: sig.s };
      } else {
        signature = sigRaw;
      }

      const verifyMessage = permit2Authorization || delegation || authorization;
      const transferMechanism = deps.mechanismRegistry.getMechanism(mechanism);
      if (!transferMechanism) {
        res.status(400).json({
          error: X402ErrorCode.UnsupportedScheme,
          details: `Transfer mechanism '${mechanism}' not available`,
        });
        return;
      }

      // Replay protection: a signed authorization is single-use.
      // The DB enforces uniqueness via a partial unique index on
      // (scope, authorization_hash) for non-failed rows — that's the
      // authoritative gate. A pre-flight `isAuthorizationUsed` check
      // would race under concurrent traffic (two requests both pass
      // the check, both insert), so we just let `create()` throw
      // `DuplicateAuthorizationError` and translate it to 409.
      const authorizationHash = computeAuthorizationHash(paymentPayload.payload);

      // Persist a payment row so operators can see in-flight settlements
      // via the admin API / CLI. product_id comes back via extra.productId
      // (set by /create) — fall back to 'unknown' for external callers.
      const productId =
        (paymentRequirements.extra as Record<string, unknown> | undefined)?.productId &&
        typeof (paymentRequirements.extra as Record<string, unknown>).productId === 'string'
          ? ((paymentRequirements.extra as Record<string, unknown>).productId as string)
          : 'unknown';
      // Keep base units as a string end-to-end — preserves precision for
      // 18-decimal tokens above the JS Number safe-integer boundary.
      const amountBaseUnits = String(paymentRequirements.amount);
      let persisted;
      try {
        persisted = await deps.payments.create(scope, {
          productId,
          amount: 0,
          amountBaseUnits,
          assetId: asset.assetId,
          recipientAddress: paymentRequirements.payTo,
          transferMechanism: mechanism,
          authorizationHash,
          expiresAt: new Date(Date.now() + paymentRequirements.maxTimeoutSeconds * 1000).toISOString(),
        });
      } catch (err) {
        if (err instanceof DuplicateAuthorizationError) {
          res.status(409).json({
            error: X402ErrorCode.InvalidPayload,
            details: 'This authorization has already been processed',
          });
          return;
        }
        throw err;
      }
      paymentId = persisted.paymentId;

      const verificationResult = await transferMechanism.verify({
        tokenAddress: asset.address,
        tokenName: asset.eip712Name,
        tokenVersion: asset.eip712Version,
        chainId: asset.chainId,
        message: verifyMessage,
        signature,
        expectedAmount: BigInt(paymentRequirements.amount),
        expectedRecipient: paymentRequirements.payTo,
        provider: null,
      });

      if (!verificationResult.valid) {
        const errMsg = verificationResult.error || 'Signature verification failed';
        const payer = (permit2Authorization?.from || authorization?.from || '').toLowerCase();
        // Row is `pending` at this point, but swallow state-guard
        // errors defensively — a concurrent admin mark-failed could
        // have moved it already.
        try {
          await deps.payments.markFailed(scope, paymentId, errMsg);
        } catch (err) {
          if (!(err instanceof InvalidStateTransitionError)) throw err;
        }
        const out: V2SettlementResponse = {
          success: false,
          transaction: '',
          network: paymentRequirements.network,
          payer,
          errorReason: errMsg,
        };
        res.status(200).json(out);
        return;
      }

      const expectedOwner =
        verificationResult.signer ||
        (permit2Authorization?.from || authorization?.from || '').toLowerCase();
      await deps.payments.markVerified(scope, paymentId, expectedOwner);
      await deps.payments.markSettling(scope, paymentId);
      const capturedPaymentId = paymentId;

      const fullSignature = {
        ...(permit2Authorization || delegation || authorization),
        ...signature,
      };
      const result = await transferMechanism.settle({
        scope,
        paymentId,
        from: expectedOwner,
        to: paymentRequirements.payTo,
        amount: BigInt(paymentRequirements.amount),
        tokenAddress: asset.address,
        signature: fullSignature,
        chainId: asset.chainId,
        onSettlementTxId: (fireblocksTxId) =>
          deps.payments.attachFireblocksTxId(scope, capturedPaymentId, fireblocksTxId),
      });

      if (!result.success) {
        const errMsg = result.error || 'Settlement failed';
        // Don't close the row as `failed` if a Fireblocks tx id is
        // attached — the on-chain settlement may still be in flight
        // (transient API / network error during polling). Leave it
        // `settling` and let the reconciler decide terminality against
        // Fireblocks's own truth.
        const curr = await deps.payments.get(scope, paymentId);
        if (!curr?.fireblocksTxId) {
          try {
            await deps.payments.markFailed(scope, paymentId, errMsg);
          } catch (err) {
            if (!(err instanceof InvalidStateTransitionError)) throw err;
          }
        } else {
          console.warn(
            `[payments] settle reported !success for ${paymentId} but fireblocksTxId=${curr.fireblocksTxId} is attached — leaving 'settling' for reconciler (${errMsg})`,
          );
        }
        const out: V2SettlementResponse = {
          success: false,
          transaction: '',
          network: paymentRequirements.network,
          payer: expectedOwner,
          errorReason: errMsg,
        };
        res.status(200).json(out);
        return;
      }

      await deps.payments.markComplete(
        scope,
        paymentId,
        result.transactionHash || '',
        expectedOwner,
        result.blockNumber ?? undefined,
      );
      const out: V2SettlementResponse = {
        success: true,
        transaction: result.transactionHash || '',
        network: paymentRequirements.network,
        payer: expectedOwner,
      };
      res.status(200).json(out);
    } catch (err) {
      console.error('[payments] settle error:', err);
      if (paymentId && scopeForCatch) {
        try {
          // Same invariant as the !result.success branch above: if
          // Fireblocks has accepted the tx, the on-chain settlement may
          // still land. Don't preempt the reconciler.
          const curr = await deps.payments.get(scopeForCatch, paymentId);
          if (!curr?.fireblocksTxId) {
            await deps.payments.markFailed(scopeForCatch, paymentId, (err as Error).message);
          } else {
            console.warn(
              `[payments] settle threw for ${paymentId} but fireblocksTxId=${curr.fireblocksTxId} is attached — leaving 'settling' for reconciler`,
            );
          }
        } catch (markErr) {
          console.error('[payments] failed to mark payment failed:', markErr);
        }
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
