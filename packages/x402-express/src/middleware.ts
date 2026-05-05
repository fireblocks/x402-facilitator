/**
 * Express middleware implementing the merchant side of x402.
 *
 * The merchant side only needs to map a URL path to a facilitator
 * product id. All payment details — asset address, amount, decimals,
 * EIP-712 domain, receiver — come from the facilitator's
 * `/api/payments/create` endpoint, cached briefly per product.
 *
 * Usage:
 *   app.use(
 *     x402Middleware({
 *       facilitatorUrl: process.env.FACILITATOR_URL!,
 *       apiKey: process.env.FACILITATOR_API_KEY!,
 *       settlement: 'optimistic',
 *       products: [{ endpoint: '/premium', productId: 'prod_abc…' }],
 *     }),
 *   );
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { FacilitatorClient, FacilitatorClientOptions } from './facilitatorClient';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
} from './types';

export type SettlementOrder = 'optimistic' | 'settle-first';

export interface ProductBinding {
  /** URL path to gate (must start with '/'). */
  endpoint: string;
  /**
   * Facilitator product_id. The merchant only needs this — everything
   * else (asset, amount, EIP-712 domain, receiver) is fetched from the
   * facilitator on demand.
   */
  productId: string;
}

export interface SettlementOutcome {
  productId: string;
  endpoint: string;
  payer?: string;
  txHash?: string;
  network: string;
  success: boolean;
  error?: string;
}

export interface X402MiddlewareOptions {
  facilitatorUrl: string;
  apiKey: string;
  products: ProductBinding[];
  /**
   * When to submit the on-chain settlement.
   *   - 'optimistic' (default): serve first, settle in the background.
   *   - 'settle-first': settle synchronously before serving.
   */
  settlement?: SettlementOrder;
  /**
   * How long to cache facilitator `/api/payments/create` responses per
   * product, in ms. Shorter caches pick up price changes faster; longer
   * caches reduce facilitator load. Default 10s.
   */
  quoteCacheMs?: number;
  /** Called after each settlement completes (both success and failure). */
  onSettlement?: (outcome: SettlementOutcome) => void;
  /** Optional override for tests. */
  clientOverride?: FacilitatorClient;
  /** Request timeout for facilitator calls (default 30s). */
  timeoutMs?: number;
}

interface CachedQuote {
  body: PaymentRequired;
  fetchedAt: number;
}

export function x402Middleware(opts: X402MiddlewareOptions): RequestHandler {
  const client =
    opts.clientOverride ??
    new FacilitatorClient({
      baseUrl: opts.facilitatorUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
    } as FacilitatorClientOptions);
  const order = opts.settlement ?? 'optimistic';
  const quoteTtlMs = opts.quoteCacheMs ?? 10_000;

  const byEndpoint = new Map<string, ProductBinding>();
  for (const p of opts.products) {
    if (!p.endpoint.startsWith('/')) {
      throw new Error(`x402Middleware: endpoint must start with '/' (got ${p.endpoint})`);
    }
    if (!p.productId) {
      throw new Error(`x402Middleware: productId required for ${p.endpoint}`);
    }
    byEndpoint.set(p.endpoint, p);
  }

  const quoteCache = new Map<string, CachedQuote>();
  async function getQuote(productId: string): Promise<PaymentRequired> {
    const cached = quoteCache.get(productId);
    if (cached && Date.now() - cached.fetchedAt < quoteTtlMs) {
      return cached.body;
    }
    const body = await client.createForProduct(productId);
    quoteCache.set(productId, { body, fetchedAt: Date.now() });
    return body;
  }

  function requirementsMatch(
    clientAccepted: PaymentRequirements,
    merchantAccepts: PaymentRequirements[],
  ): PaymentRequirements | null {
    // Client must have accepted one of the options the merchant offered.
    // Amount: merchant accepts if client offered ≥ required.
    for (const candidate of merchantAccepts) {
      if (
        candidate.asset.toLowerCase() === clientAccepted.asset.toLowerCase() &&
        candidate.network === clientAccepted.network &&
        candidate.payTo.toLowerCase() === clientAccepted.payTo.toLowerCase() &&
        BigInt(clientAccepted.amount) >= BigInt(candidate.amount)
      ) {
        return candidate;
      }
    }
    return null;
  }

  return async function x402Handler(req: Request, res: Response, next: NextFunction) {
    const binding = byEndpoint.get(req.path);
    if (!binding) return next();

    let quote: PaymentRequired;
    try {
      quote = await getQuote(binding.productId);
    } catch (err) {
      res.status(502).json({ error: 'facilitator_error', details: (err as Error).message });
      return;
    }

    const sigHeader = req.headers['payment-signature'];
    if (typeof sigHeader !== 'string') {
      // No signature — respond 402 with the facilitator's quote, augmented
      // with the resource URL the client actually hit.
      const body: PaymentRequired = {
        ...quote,
        error: 'PAYMENT-SIGNATURE header is required',
        resource: {
          url: `${req.protocol}://${req.headers.host ?? 'localhost'}${req.originalUrl}`,
          description: quote.resource?.description,
          mimeType: quote.resource?.mimeType ?? 'application/json',
        },
      };
      const res402 = res
        .status(402)
        .header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
      // Mirror the integrity envelope onto the canonical spec header so
      // spec-compliant wallets can verify without parsing the body.
      if (body.integrity) res402.header('X-402-Integrity', body.integrity);
      res402.json(body);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = JSON.parse(Buffer.from(sigHeader, 'base64').toString('utf-8'));
    } catch {
      res
        .status(400)
        .json({ error: 'invalid_payload', details: 'payment-signature must be base64-encoded JSON' });
      return;
    }

    const matched = payload.accepted
      ? requirementsMatch(payload.accepted, quote.accepts)
      : null;
    if (!matched) {
      res.status(400).json({ error: 'invalid_payment_requirements' });
      return;
    }

    try {
      const verify = await client.verify(payload, matched);
      if (!verify.isValid) {
        res.status(402).json({ error: 'invalid_signature', details: verify.invalidReason });
        return;
      }

      if (order === 'settle-first') {
        const settle = await client.settle(payload, matched);
        if (!settle.success) {
          opts.onSettlement?.({
            productId: binding.productId,
            endpoint: binding.endpoint,
            network: matched.network,
            success: false,
            error: settle.errorReason,
            payer: settle.payer,
          });
          res.status(402).json({ error: 'settlement_failed', details: settle.errorReason });
          return;
        }
        opts.onSettlement?.({
          productId: binding.productId,
          endpoint: binding.endpoint,
          network: matched.network,
          success: true,
          txHash: settle.transaction,
          payer: settle.payer,
        });
        attachPaymentResponseHeader(res, settle);
        return next();
      }

      // Optimistic: serve next, settle in the background after response.
      attachBackgroundSettlement(res, async () => {
        try {
          const settle = await client.settle(payload, matched);
          opts.onSettlement?.({
            productId: binding.productId,
            endpoint: binding.endpoint,
            network: matched.network,
            success: settle.success,
            txHash: settle.transaction,
            payer: settle.payer,
            error: settle.errorReason,
          });
          if (!settle.success) {
            console.error(
              `[x402] background settlement failed: ${settle.errorReason ?? 'unknown'}`,
            );
          }
        } catch (err) {
          opts.onSettlement?.({
            productId: binding.productId,
            endpoint: binding.endpoint,
            network: matched.network,
            success: false,
            error: (err as Error).message,
          });
          console.error('[x402] background settlement error:', err);
        }
      });
      next();
    } catch (err) {
      res
        .status(502)
        .json({ error: 'facilitator_error', details: (err as Error).message });
    }
  };
}

function attachPaymentResponseHeader(res: Response, settle: SettlementResponse): void {
  res.setHeader(
    'PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(settle)).toString('base64'),
  );
}

function attachBackgroundSettlement(res: Response, run: () => Promise<void>): void {
  res.on('finish', () => {
    run().catch((err) => console.error('[x402] background task threw:', err));
  });
}
