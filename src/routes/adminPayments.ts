/**
 * Admin-side payments API — used by dashboards / operators.
 *
 *   GET  /api/admin/payments                       payments:read
 *   GET  /api/admin/payments/:id                   payments:read
 *   POST /api/admin/payments/:id/mark-failed       payments:write
 *   POST /api/admin/payments/:id/refund            payments:write  (on-chain via Fireblocks)
 *   POST /api/admin/payments/:id/sync              payments:write  (reconcile one row)
 *   POST /api/admin/payments/sync-all              payments:write  (reconcile every settling row in scope)
 *   POST /api/admin/payments/sweep-expired         payments:write
 */

import { Router, Request, Response } from 'express';
import { PaymentRepository, PaymentStatus } from '../repositories/interfaces/PaymentRepository';
import { AssetRepository } from '../repositories/interfaces/AssetRepository';
import { ProductRepository } from '../repositories/interfaces/ProductRepository';
import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';
import { PaymentReconciler } from '../services/reconciliation/PaymentReconciler';
import { requireUserScope } from '../middleware/auth';
import { PAYMENTS_READ, PAYMENTS_WRITE } from '../auth/principals';

const VALID_STATUSES: ReadonlySet<string> = new Set<PaymentStatus>([
  'pending',
  'verified',
  'settling',
  'settled',
  'completed',
  'refunding',
  'refunded',
  'refund_failed',
  'expired',
  'failed',
]);

export function createAdminPaymentRoutes(
  payments: PaymentRepository,
  assets: AssetRepository,
  products: ProductRepository,
  fireblocksFactory: FireblocksSettlementFactory,
  reconciler: PaymentReconciler,
): Router {
  const router = Router();

  // ── Reads ────────────────────────────────────────────────────────────
  router.get('/', requireUserScope(PAYMENTS_READ), async (req: Request, res: Response) => {
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const status = (req.query.status as string | undefined) || undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;
      if (status && status !== 'all' && !VALID_STATUSES.has(status)) {
        res.status(400).json({
          error: `Invalid status filter '${status}'. Must be one of: ${[...VALID_STATUSES].join(', ')}, or 'all'.`,
        });
        return;
      }
      const filter =
        status && status !== 'all'
          ? { status: status as PaymentStatus, limit, offset }
          : { limit, offset };
      const rows = await payments.list(req.scope, filter);
      res.status(200).json(rows);
    } catch (err) {
      console.error('[admin/payments] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/:paymentId', requireUserScope(PAYMENTS_READ), async (req: Request, res: Response) => {
    try {
      if (!req.scope) {
        res.status(400).json({ error: 'Scope not resolved' });
        return;
      }
      const payment = await payments.get(req.scope, req.params.paymentId as string);
      if (!payment) {
        res.status(404).json({ error: 'Payment not found' });
        return;
      }
      const asset = assets.get(payment.assetId);
      const product = products.get(req.scope, payment.productId);
      res.status(200).json({
        ...payment,
        product: product ?? null,
        asset: asset ?? null,
      });
    } catch (err) {
      console.error('[admin/payments] get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Writes ───────────────────────────────────────────────────────────

  /**
   * Force a payment row into `failed` state with an operator-supplied
   * reason. Useful for unsticking rows that the happy-path transitions
   * never closed out (e.g. server crashed mid-settle, settlement poll
   * timed out). Does not touch the chain.
   */
  router.post(
    '/:paymentId/mark-failed',
    requireUserScope(PAYMENTS_WRITE),
    async (req: Request, res: Response) => {
      try {
        if (!req.scope) {
          res.status(400).json({ error: 'Scope not resolved' });
          return;
        }
        const paymentId = req.params.paymentId as string;
        const reason =
          typeof (req.body as { reason?: unknown })?.reason === 'string'
            ? ((req.body as { reason: string }).reason as string)
            : null;
        if (!reason || reason.trim().length === 0) {
          res.status(400).json({ error: 'Body must include { reason: string }' });
          return;
        }
        const existing = await payments.get(req.scope, paymentId);
        if (!existing) {
          res.status(404).json({ error: 'Payment not found' });
          return;
        }
        await payments.markFailed(req.scope, paymentId, reason);
        const updated = await payments.get(req.scope, paymentId);
        res.status(200).json(updated);
      } catch (err) {
        console.error('[admin/payments] mark-failed error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  /**
   * Refund a completed or settled payment back to the original payer.
   * Submits a CONTRACT_CALL to the token's transfer(to, amount) via
   * Fireblocks, tracking state through refunding → refunded (or
   * refund_failed). Refunds can only target rows whose on-chain leg
   * landed — otherwise there's nothing to return.
   */
  router.post(
    '/:paymentId/refund',
    requireUserScope(PAYMENTS_WRITE),
    async (req: Request, res: Response) => {
      try {
        if (!req.scope) {
          res.status(400).json({ error: 'Scope not resolved' });
          return;
        }
        const paymentId = req.params.paymentId as string;
        const payment = await payments.get(req.scope, paymentId);
        if (!payment) {
          res.status(404).json({ error: 'Payment not found' });
          return;
        }
        if (payment.status !== 'completed' && payment.status !== 'settled') {
          res.status(409).json({
            error: `Cannot refund payment in status '${payment.status}' — only 'completed' or 'settled' are refundable.`,
          });
          return;
        }
        if (!payment.fromAddress) {
          res.status(400).json({ error: 'Payment is missing fromAddress; cannot refund.' });
          return;
        }
        const asset = assets.get(payment.assetId);
        if (!asset) {
          res.status(400).json({
            error: `Asset ${payment.assetId} no longer in catalog — refund cannot be constructed.`,
          });
          return;
        }

        await payments.markRefunding(req.scope, paymentId);
        try {
          const svc = fireblocksFactory.get(req.scope, asset.chainId);
          const result = await svc.refund(
            asset.address,
            payment.fromAddress,
            BigInt(payment.amountBaseUnits),
          );
          await payments.markRefunded(req.scope, paymentId, result.txHash);
          const updated = await payments.get(req.scope, paymentId);
          res.status(200).json(updated);
        } catch (err) {
          const msg = (err as Error).message;
          await payments.markRefundFailed(req.scope, paymentId, msg);
          const updated = await payments.get(req.scope, paymentId);
          res.status(502).json({
            error: `Refund failed on-chain: ${msg}`,
            payment: updated,
          });
        }
      } catch (err) {
        console.error('[admin/payments] refund error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  /**
   * Reconcile a `settling` payment against Fireblocks. Reads the
   * persisted fireblocksTxId, asks Fireblocks what state the tx is in,
   * and transitions the row (completed / failed / no-op for in-flight).
   * Use after a process crash, or when the normal poll loop failed to
   * update the row for some reason.
   */
  router.post(
    '/:paymentId/sync',
    requireUserScope(PAYMENTS_WRITE),
    async (req: Request, res: Response) => {
      try {
        if (!req.scope) {
          res.status(400).json({ error: 'Scope not resolved' });
          return;
        }
        const paymentId = req.params.paymentId as string;
        const existing = await payments.get(req.scope, paymentId);
        if (!existing) {
          res.status(404).json({ error: 'Payment not found' });
          return;
        }
        const updated = await reconciler.reconcileOne(req.scope, paymentId);
        res.status(200).json(updated);
      } catch (err) {
        console.error('[admin/payments] sync error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  /**
   * Bulk reconcile: query Fireblocks for every `settling` row in the
   * caller's scope and drive each to its real terminal state. Returns
   * the same ReconcileSummary shape the boot log emits.
   */
  router.post(
    '/sync-all',
    requireUserScope(PAYMENTS_WRITE),
    async (req: Request, res: Response) => {
      try {
        if (!req.scope) {
          res.status(400).json({ error: 'Scope not resolved' });
          return;
        }
        const summary = await reconciler.reconcileOpen(req.scope);
        res.status(200).json(summary);
      } catch (err) {
        console.error('[admin/payments] sync-all error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  /**
   * Bulk-expire every pending payment whose expiresAt is in the past.
   * Safe to run on a schedule; idempotent per row.
   */
  router.post(
    '/sweep-expired',
    requireUserScope(PAYMENTS_WRITE),
    async (req: Request, res: Response) => {
      try {
        if (!req.scope) {
          res.status(400).json({ error: 'Scope not resolved' });
          return;
        }
        const expired = await payments.markExpired(req.scope);
        res.status(200).json({ expired });
      } catch (err) {
        console.error('[admin/payments] sweep-expired error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  return router;
}
