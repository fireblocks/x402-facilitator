/**
 * Payment repository — the one mutable-at-runtime repository.
 * Multiple adapters: in-memory, sqlite, postgres (SQL).
 *
 * All methods are scope-qualified. Single-tenant adapters ignore the
 * scope; multi-tenant adapters filter by tenantId + configurationId.
 */

import { TenantScope } from '../../core/tenantScope';

export type PaymentStatus =
  | 'pending'
  | 'verified'
  | 'settling'
  | 'settled'
  | 'completed'
  | 'refunding'
  | 'refunded'
  | 'refund_failed'
  | 'expired'
  | 'failed';

export interface Payment {
  paymentId: string;
  tenantId: string;
  configurationId: string;
  productId: string;
  /** USD-denominated quoted price; nullable for non-priced flows. */
  amount: number;
  /**
   * Token base units (e.g. 6-decimal USDC, 18-decimal ETH). Stored and
   * surfaced as a decimal string so 18-decimal amounts above 2^53 don't
   * silently lose precision.
   */
  amountBaseUnits: string;
  assetId: string;
  recipientAddress: string;
  fromAddress: string | null;
  status: PaymentStatus;
  transferMechanism: string | null;
  error: string | null;
  transactionHash: string | null;
  blockNumber: number | null;
  /**
   * Fireblocks-internal transaction id (UUID), persisted as soon as
   * Fireblocks accepts the `createTransaction` call. Stable primary key
   * for reconciling `settling` rows against the Fireblocks workspace
   * after a crash — the on-chain hash only becomes available later.
   */
  fireblocksTxId: string | null;
  /**
   * SHA-256 of the canonical-JSON signed authorization payload. Indexed
   * for replay protection — `/settle` rejects an authorization that has
   * already been processed by a non-failed row in the same scope.
   */
  authorizationHash: string | null;
  /**
   * On-chain hash of the refund transaction submitted via Fireblocks.
   * Populated by `markRefunded`; null until then.
   */
  refundTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  paidAt: string | null;
}

export interface CreatePaymentInput {
  productId: string;
  amount: number;
  amountBaseUnits: string;
  assetId: string;
  recipientAddress: string;
  transferMechanism?: string;
  authorizationHash?: string;
  expiresAt: string;
}

/**
 * Thrown by `create()` when the inserted row would violate the unique
 * constraint on `(tenantId, configurationId, authorizationHash)` for
 * non-failed rows. The constraint is the authoritative replay-protection
 * gate — `isAuthorizationUsed()` is a non-authoritative read that races
 * under concurrent traffic. Routes should catch this and return 409.
 */
export class DuplicateAuthorizationError extends Error {
  constructor(public readonly authorizationHash: string) {
    super(`Duplicate authorization hash in scope: ${authorizationHash}`);
    this.name = 'DuplicateAuthorizationError';
  }
}

/**
 * Thrown by `mark*` methods when the row's current status does not
 * permit the requested transition. Each adapter must enforce the
 * transition with an atomic `UPDATE ... WHERE status IN (<allowed>)`
 * and throw this when the rowsAffected is zero (i.e. the row exists
 * but is in the wrong state, or doesn't exist at all). Routes should
 * catch this and return 409 — it prevents TOCTOU patterns like
 * double-refund where two concurrent requests both pass a separate
 * pre-flight status read.
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly attempted: PaymentStatus | 'attach_fireblocks_tx_id',
    public readonly allowedFrom: ReadonlyArray<PaymentStatus>,
  ) {
    super(
      `Cannot transition payment ${paymentId} to ${attempted} ` +
        `(allowed from: ${allowedFrom.join(', ')}). ` +
        `Row may already be in a terminal state or another concurrent ` +
        `request beat this one.`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export interface ListPaymentsFilter {
  status?: PaymentStatus;
  limit?: number;
  offset?: number;
}

export interface PaymentRepository {
  create(scope: TenantScope, input: CreatePaymentInput): Promise<Payment>;
  get(scope: TenantScope, paymentId: string): Promise<Payment | undefined>;
  list(scope: TenantScope, filter?: ListPaymentsFilter): Promise<Payment[]>;

  markVerified(scope: TenantScope, paymentId: string, fromAddress: string): Promise<void>;
  markSettling(scope: TenantScope, paymentId: string): Promise<void>;
  attachFireblocksTxId(scope: TenantScope, paymentId: string, fireblocksTxId: string): Promise<void>;
  markSettled(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void>;
  markComplete(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void>;
  markRefunding(scope: TenantScope, paymentId: string): Promise<void>;
  markRefunded(scope: TenantScope, paymentId: string, refundTxHash: string): Promise<void>;
  markRefundFailed(scope: TenantScope, paymentId: string, error: string): Promise<void>;
  markFailed(scope: TenantScope, paymentId: string, error?: string): Promise<void>;
  markExpired(scope: TenantScope): Promise<number>;

  isTransactionUsed(scope: TenantScope, transactionHash: string): Promise<boolean>;

  /**
   * Non-authoritative replay-protection lookup. Returns true if any
   * payment in this scope is already tracking the same authorization
   * hash and has not failed. Useful for read APIs and pre-flight checks
   * — but **not** safe to rely on for write-side uniqueness, which is
   * enforced by `create()` throwing `DuplicateAuthorizationError`
   * (backed by a unique constraint in the DB adapters).
   */
  isAuthorizationUsed(scope: TenantScope, authorizationHash: string): Promise<boolean>;

  close?(): Promise<void>;
}
