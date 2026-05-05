/**
 * Payment reconciler.
 *
 * Talks to Fireblocks by tx id and transitions payment rows through the
 * repository. Mechanism-agnostic — every settlement path funnels through
 * Fireblocks CONTRACT_CALL, so one reconciler handles all of them.
 *
 * Used in two places:
 *   - Boot: scan `settling` rows for every configured scope, resume.
 *   - Admin: POST /api/admin/payments/:id/sync — on-demand per-row sync.
 */

import { PaymentRepository, Payment } from '../../repositories/interfaces/PaymentRepository';
import { FireblocksSettlementFactory } from '../fireblocksSettlementFactory';
import { TenantScope } from '../../core/tenantScope';

export interface ReconcileSummary {
  scanned: number;
  completed: number;
  failed: number;
  inFlight: number;
  skipped: number;
}

export class PaymentReconciler {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly fireblocksFactory: FireblocksSettlementFactory,
  ) {}

  async reconcileOne(scope: TenantScope, paymentId: string): Promise<Payment | undefined> {
    const payment = await this.payments.get(scope, paymentId);
    if (!payment) return undefined;
    // Reconciler owns any row where Fireblocks is the source of truth:
    // `settling` (normal case) plus `failed` when a tx id is attached
    // (route gave up prematurely — the tx may still have landed).
    // Other terminal states (`completed`, `refunded`, `refund_failed`)
    // are merchant-managed, not Fireblocks-managed; don't overwrite.
    const reconcilable =
      payment.status === 'settling' ||
      (payment.status === 'failed' && !!payment.fireblocksTxId);
    if (!reconcilable) return payment;
    if (!payment.fireblocksTxId) return payment;

    const settlement = this.fireblocksFactory.get(scope);
    const outcome = await settlement.getTransactionOutcome(payment.fireblocksTxId);

    if (outcome.kind === 'completed') {
      await this.payments.markComplete(
        scope,
        paymentId,
        outcome.txHash,
        payment.fromAddress ?? '',
        outcome.blockNumber || undefined,
      );
    } else if (outcome.kind === 'failed') {
      await this.payments.markFailed(scope, paymentId, `Fireblocks: ${outcome.reason}`);
    }
    // in_flight → leave the row alone; the original settle call (if still
    // running) will update it, or a future sync will pick it up again.

    return this.payments.get(scope, paymentId);
  }

  async reconcileOpen(scope: TenantScope): Promise<ReconcileSummary> {
    // `settling` is the normal case. `failed` rows with a fireblocksTxId
    // come from legacy behaviour before the reconciler-ownership invariant
    // was introduced — Fireblocks may still report them COMPLETED, in
    // which case reconcileOne lifts them back. Without including them
    // here, those rows would only heal via a manual /sync.
    const settling = await this.payments.list(scope, { status: 'settling' });
    const failedWithTx = (await this.payments.list(scope, { status: 'failed' })).filter(
      (r) => !!r.fireblocksTxId,
    );
    const rows = [...settling, ...failedWithTx];
    const summary: ReconcileSummary = {
      scanned: rows.length,
      completed: 0,
      failed: 0,
      inFlight: 0,
      skipped: 0,
    };

    for (const row of rows) {
      if (!row.fireblocksTxId) {
        summary.skipped += 1;
        continue;
      }
      try {
        const before = row.status;
        const after = await this.reconcileOne(scope, row.paymentId);
        if (!after) {
          summary.skipped += 1;
          continue;
        }
        if (after.status === 'completed') summary.completed += 1;
        else if (after.status === 'failed') summary.failed += 1;
        else if (after.status === before) summary.inFlight += 1;
      } catch (err) {
        console.error(
          `[reconciler] failed to reconcile ${row.paymentId} (${row.fireblocksTxId}):`,
          err,
        );
        summary.skipped += 1;
      }
    }

    return summary;
  }
}
