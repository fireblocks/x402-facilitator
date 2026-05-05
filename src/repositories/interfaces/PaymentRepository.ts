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
   * Replay-protection lookup. Returns true if any payment in this scope
   * is already tracking the same authorization hash and has not failed
   * (i.e. it's pending / verified / settling / settled / completed /
   * refunding / refunded). Failed rows are excluded so a verify error
   * doesn't permanently lock a (re-signed) authorization out.
   */
  isAuthorizationUsed(scope: TenantScope, authorizationHash: string): Promise<boolean>;

  close?(): Promise<void>;
}
