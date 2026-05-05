import { randId } from '../../utils/randId';
import { TenantScope } from '../../core/tenantScope';
import {
  CreatePaymentInput,
  DuplicateAuthorizationError,
  InvalidStateTransitionError,
  ListPaymentsFilter,
  Payment,
  PaymentRepository,
  PaymentStatus,
} from '../interfaces/PaymentRepository';

export class InMemoryPaymentRepository implements PaymentRepository {
  private payments = new Map<string, Payment>();

  async create(scope: TenantScope, input: CreatePaymentInput): Promise<Payment> {
    // Mirror the DB-adapter unique partial index: at most one non-failed
    // row per (scope, authorization_hash). JS is single-threaded so the
    // check + set below is atomic — no TOCTOU here.
    if (input.authorizationHash) {
      for (const p of this.payments.values()) {
        if (
          sameScope(p, scope) &&
          p.authorizationHash === input.authorizationHash &&
          p.status !== 'failed'
        ) {
          throw new DuplicateAuthorizationError(input.authorizationHash);
        }
      }
    }
    const now = new Date().toISOString();
    const payment: Payment = {
      paymentId: randId('pay'),
      tenantId: scope.tenantId,
      configurationId: scope.configurationId,
      productId: input.productId,
      amount: input.amount,
      amountBaseUnits: input.amountBaseUnits,
      assetId: input.assetId,
      recipientAddress: input.recipientAddress,
      fromAddress: null,
      status: 'pending',
      transferMechanism: input.transferMechanism ?? null,
      error: null,
      transactionHash: null,
      blockNumber: null,
      fireblocksTxId: null,
      authorizationHash: input.authorizationHash ?? null,
      refundTxHash: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      paidAt: null,
    };
    this.payments.set(payment.paymentId, payment);
    return payment;
  }

  async get(scope: TenantScope, paymentId: string): Promise<Payment | undefined> {
    const p = this.payments.get(paymentId);
    if (!p || !sameScope(p, scope)) return undefined;
    return p;
  }

  async list(scope: TenantScope, filter?: ListPaymentsFilter): Promise<Payment[]> {
    let all = Array.from(this.payments.values())
      .filter((p) => sameScope(p, scope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.status) all = all.filter((p) => p.status === filter.status);
    const offset = filter?.offset ?? 0;
    if (offset > 0) all = all.slice(offset);
    if (filter?.limit !== undefined) all = all.slice(0, filter.limit);
    return all;
  }

  /**
   * Atomic-by-virtue-of-single-threaded-JS guarded transition.
   * Throws InvalidStateTransitionError when the row is missing or its
   * current status is not in `allowedFrom`. Mirrors the SQL-adapter
   * `UPDATE ... WHERE status IN (<allowed>)` pattern.
   */
  private guardedTransition(
    scope: TenantScope,
    paymentId: string,
    target: PaymentStatus | 'attach_fireblocks_tx_id',
    allowedFrom: ReadonlyArray<PaymentStatus>,
    updates: Partial<Payment>,
  ): void {
    const current = this.payments.get(paymentId);
    if (!current || !sameScope(current, scope) || !allowedFrom.includes(current.status)) {
      throw new InvalidStateTransitionError(paymentId, target, allowedFrom);
    }
    this.payments.set(paymentId, {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  }

  async markVerified(scope: TenantScope, paymentId: string, fromAddress: string): Promise<void> {
    this.guardedTransition(scope, paymentId, 'verified', ['pending'], {
      status: 'verified',
      fromAddress,
    });
  }

  async markSettling(scope: TenantScope, paymentId: string): Promise<void> {
    this.guardedTransition(scope, paymentId, 'settling', ['verified'], {
      status: 'settling',
    });
  }

  async attachFireblocksTxId(
    scope: TenantScope,
    paymentId: string,
    fireblocksTxId: string,
  ): Promise<void> {
    const current = this.payments.get(paymentId);
    if (!current || !sameScope(current, scope)) {
      throw new InvalidStateTransitionError(paymentId, 'attach_fireblocks_tx_id', []);
    }
    // Idempotent: only set when null.
    if (current.fireblocksTxId !== null) return;
    this.payments.set(paymentId, {
      ...current,
      fireblocksTxId,
      updatedAt: new Date().toISOString(),
    });
  }

  async markSettled(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    this.guardedTransition(scope, paymentId, 'settled', ['settling'], {
      status: 'settled',
      transactionHash,
      fromAddress,
      blockNumber: blockNumber ?? null,
    });
  }

  async markComplete(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    this.guardedTransition(
      scope,
      paymentId,
      'completed',
      ['settling', 'settled', 'failed'],
      {
        status: 'completed',
        transactionHash,
        fromAddress,
        blockNumber: blockNumber ?? null,
        paidAt: new Date().toISOString(),
      },
    );
  }

  async markRefunding(scope: TenantScope, paymentId: string): Promise<void> {
    this.guardedTransition(scope, paymentId, 'refunding', ['completed', 'settled'], {
      status: 'refunding',
    });
  }

  async markRefunded(scope: TenantScope, paymentId: string, refundTxHash: string): Promise<void> {
    this.guardedTransition(scope, paymentId, 'refunded', ['refunding'], {
      status: 'refunded',
      error: 'Upstream failed — funds refunded',
      refundTxHash,
    });
  }

  async markRefundFailed(scope: TenantScope, paymentId: string, error: string): Promise<void> {
    this.guardedTransition(scope, paymentId, 'refund_failed', ['refunding'], {
      status: 'refund_failed',
      error,
    });
  }

  async markFailed(scope: TenantScope, paymentId: string, error?: string): Promise<void> {
    this.guardedTransition(
      scope,
      paymentId,
      'failed',
      ['pending', 'verified', 'settling', 'failed'],
      { status: 'failed', error: error ?? null },
    );
  }

  async markExpired(scope: TenantScope): Promise<number> {
    const now = Date.now();
    let changed = 0;
    for (const payment of this.payments.values()) {
      if (!sameScope(payment, scope)) continue;
      if (payment.status === 'pending' && Date.parse(payment.expiresAt) < now) {
        this.patch(scope, payment.paymentId, { status: 'expired' });
        changed += 1;
      }
    }
    return changed;
  }

  async isTransactionUsed(scope: TenantScope, transactionHash: string): Promise<boolean> {
    for (const payment of this.payments.values()) {
      if (!sameScope(payment, scope)) continue;
      if (payment.transactionHash === transactionHash && payment.status === 'completed') {
        return true;
      }
    }
    return false;
  }

  async isAuthorizationUsed(scope: TenantScope, authorizationHash: string): Promise<boolean> {
    for (const payment of this.payments.values()) {
      if (!sameScope(payment, scope)) continue;
      if (payment.authorizationHash === authorizationHash && payment.status !== 'failed') {
        return true;
      }
    }
    return false;
  }

  private patch(scope: TenantScope, paymentId: string, updates: Partial<Payment>): void {
    const current = this.payments.get(paymentId);
    if (!current || !sameScope(current, scope)) return;
    this.payments.set(paymentId, {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  }
}

function sameScope(p: Payment, scope: TenantScope): boolean {
  return p.tenantId === scope.tenantId && p.configurationId === scope.configurationId;
}
