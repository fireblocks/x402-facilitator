/**
 * SQL-backed payment repository using Kysely.
 *
 * Primary target is PostgreSQL. Scope columns are always included so a
 * single DB can host many tenants + configurations in the future.
 */

import { Generated, Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
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

interface PaymentsTable {
  payment_id: string;
  tenant_id: string;
  configuration_id: string;
  product_id: string;
  amount: number;
  // NUMERIC(78,0) — preserves bigint precision; pg returns it as a string.
  amount_base_units: string;
  asset_id: string;
  recipient_address: string;
  from_address: string | null;
  status: PaymentStatus;
  transfer_mechanism: string | null;
  error: string | null;
  transaction_hash: string | null;
  block_number: number | null;
  fireblocks_tx_id: string | null;
  authorization_hash: string | null;
  refund_tx_hash: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  expires_at: string;
  paid_at: string | null;
}

type PaymentsRow = {
  [K in keyof PaymentsTable]: PaymentsTable[K] extends Generated<infer V> ? V : PaymentsTable[K];
};

interface Schema {
  payments: PaymentsTable;
}

function rowToDomain(row: PaymentsRow): Payment {
  return {
    paymentId: row.payment_id,
    tenantId: row.tenant_id,
    configurationId: row.configuration_id,
    productId: row.product_id,
    amount: Number(row.amount),
    amountBaseUnits: String(row.amount_base_units),
    assetId: row.asset_id,
    recipientAddress: row.recipient_address,
    fromAddress: row.from_address,
    status: row.status,
    transferMechanism: row.transfer_mechanism,
    error: row.error,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    fireblocksTxId: row.fireblocks_tx_id,
    authorizationHash: row.authorization_hash ?? null,
    refundTxHash: row.refund_tx_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
  };
}

export interface SqlPaymentRepositoryOptions {
  connectionString?: string;
  db?: Kysely<Schema>;
}

export class SqlPaymentRepository implements PaymentRepository {
  private db: Kysely<Schema>;
  private ownsConnection: boolean;

  constructor(opts: SqlPaymentRepositoryOptions = {}) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsConnection = false;
    } else {
      const connectionString = opts.connectionString || process.env.POSTGRES_URL;
      if (!connectionString) {
        throw new Error('SqlPaymentRepository requires POSTGRES_URL or options.connectionString');
      }
      this.db = new Kysely<Schema>({
        dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
      });
      this.ownsConnection = true;
    }
  }

  async init(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        configuration_id TEXT NOT NULL DEFAULT 'default',
        product_id TEXT NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        -- NUMERIC(78,0) preserves precision for 18-decimal tokens beyond
        -- BIGINT's 2^63 ceiling. pg-node returns this column as a string.
        amount_base_units NUMERIC(78,0) NOT NULL,
        asset_id TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        from_address TEXT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'pending','verified','settling','settled','completed',
          'refunding','refunded','refund_failed','expired','failed'
        )),
        transfer_mechanism TEXT NULL,
        error TEXT NULL,
        transaction_hash TEXT NULL,
        block_number BIGINT NULL,
        fireblocks_tx_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        paid_at TIMESTAMPTZ NULL
      );
    `.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_scope ON payments(tenant_id, configuration_id)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_product ON payments(product_id)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_hash)`.execute(
      this.db,
    );
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS fireblocks_tx_id TEXT NULL`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_fireblocks_tx_id ON payments(fireblocks_tx_id)`.execute(
      this.db,
    );
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS authorization_hash TEXT NULL`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_authorization_hash ON payments(authorization_hash)`.execute(
      this.db,
    );
    // Authoritative replay protection: at most one non-failed row per
    // (scope, authorization_hash). NULL hashes unconstrained (PG default
    // treats NULLs as distinct); failed rows excluded so a verify error
    // doesn't permanently lock a re-signed authorization out.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_authorization_hash
      ON payments(tenant_id, configuration_id, authorization_hash)
      WHERE authorization_hash IS NOT NULL AND status != 'failed'
    `.execute(this.db);
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT NULL`.execute(
      this.db,
    );
  }

  async create(scope: TenantScope, input: CreatePaymentInput): Promise<Payment> {
    const paymentId = randId('pay');
    try {
      const inserted = await this.db
        .insertInto('payments')
        .values({
          payment_id: paymentId,
          tenant_id: scope.tenantId,
          configuration_id: scope.configurationId,
          product_id: input.productId,
          amount: input.amount,
          amount_base_units: input.amountBaseUnits,
          asset_id: input.assetId,
          recipient_address: input.recipientAddress,
          transfer_mechanism: input.transferMechanism ?? null,
          authorization_hash: input.authorizationHash ?? null,
          status: 'pending',
          expires_at: input.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return rowToDomain(inserted as unknown as PaymentsRow);
    } catch (err) {
      // pg surfaces unique-violation as SQLSTATE 23505 with a constraint
      // name on the error object.
      const pgErr = err as { code?: string; constraint?: string };
      if (
        input.authorizationHash &&
        pgErr.code === '23505' &&
        (pgErr.constraint === 'uniq_payments_authorization_hash' ||
          /uniq_payments_authorization_hash/i.test((err as Error).message ?? ''))
      ) {
        throw new DuplicateAuthorizationError(input.authorizationHash);
      }
      throw err;
    }
  }

  async get(scope: TenantScope, paymentId: string): Promise<Payment | undefined> {
    const row = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .executeTakeFirst();
    return row ? rowToDomain(row as unknown as PaymentsRow) : undefined;
  }

  async list(scope: TenantScope, filter?: ListPaymentsFilter): Promise<Payment[]> {
    let q = this.db
      .selectFrom('payments')
      .selectAll()
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .orderBy('created_at', 'desc');
    if (filter?.status) q = q.where('status', '=', filter.status);
    if (filter?.limit !== undefined) q = q.limit(filter.limit);
    if (filter?.offset) q = q.offset(filter.offset);
    const rows = await q.execute();
    return rows.map((r) => rowToDomain(r as unknown as PaymentsRow));
  }

  /**
   * Atomic status-gated UPDATE. Mirrors the SQLite adapter — the
   * `status IN (...)` predicate is the load-bearing TOCTOU guard, and
   * a zero numUpdatedRows throws InvalidStateTransitionError. Routes
   * catch this and return 409.
   */
  private async guardedTransition(
    paymentId: string,
    scope: TenantScope,
    target: PaymentStatus | 'attach_fireblocks_tx_id',
    allowedFrom: ReadonlyArray<PaymentStatus>,
    updates: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.db
      .updateTable('payments')
      .set({ ...updates, updated_at: sql`NOW()` } as any)
      .where('payment_id', '=', paymentId)
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .where('status', 'in', allowedFrom as unknown as readonly PaymentStatus[])
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      throw new InvalidStateTransitionError(paymentId, target, allowedFrom);
    }
  }

  async markVerified(scope: TenantScope, paymentId: string, fromAddress: string): Promise<void> {
    await this.guardedTransition(paymentId, scope, 'verified', ['pending'], {
      status: 'verified',
      from_address: fromAddress,
    });
  }

  async markSettling(scope: TenantScope, paymentId: string): Promise<void> {
    await this.guardedTransition(paymentId, scope, 'settling', ['verified'], {
      status: 'settling',
    });
  }

  async attachFireblocksTxId(
    scope: TenantScope,
    paymentId: string,
    fireblocksTxId: string,
  ): Promise<void> {
    // Idempotent attach — only writes when fireblocks_tx_id IS NULL.
    const result = await this.db
      .updateTable('payments')
      .set({ fireblocks_tx_id: fireblocksTxId, updated_at: sql`NOW()` } as any)
      .where('payment_id', '=', paymentId)
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .where('fireblocks_tx_id', 'is', null)
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      const existing = await this.db
        .selectFrom('payments')
        .select('fireblocks_tx_id')
        .where('payment_id', '=', paymentId)
        .where('tenant_id', '=', scope.tenantId)
        .where('configuration_id', '=', scope.configurationId)
        .executeTakeFirst();
      if (!existing) {
        throw new InvalidStateTransitionError(
          paymentId,
          'attach_fireblocks_tx_id',
          [],
        );
      }
      // Already attached — treat as idempotent no-op.
    }
  }

  async markSettled(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    await this.guardedTransition(paymentId, scope, 'settled', ['settling'], {
      status: 'settled',
      transaction_hash: transactionHash,
      from_address: fromAddress,
      block_number: blockNumber ?? null,
    });
  }

  async markComplete(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    await this.guardedTransition(
      paymentId,
      scope,
      'completed',
      ['settling', 'settled', 'failed'],
      {
        status: 'completed',
        transaction_hash: transactionHash,
        from_address: fromAddress,
        block_number: blockNumber ?? null,
        paid_at: sql`NOW()`,
      },
    );
  }

  async markRefunding(scope: TenantScope, paymentId: string): Promise<void> {
    await this.guardedTransition(
      paymentId,
      scope,
      'refunding',
      ['completed', 'settled'],
      { status: 'refunding' },
    );
  }

  async markRefunded(scope: TenantScope, paymentId: string, refundTxHash: string): Promise<void> {
    await this.guardedTransition(paymentId, scope, 'refunded', ['refunding'], {
      status: 'refunded',
      error: 'Upstream failed — funds refunded',
      refund_tx_hash: refundTxHash,
    });
  }

  async markRefundFailed(scope: TenantScope, paymentId: string, error: string): Promise<void> {
    await this.guardedTransition(
      paymentId,
      scope,
      'refund_failed',
      ['refunding'],
      { status: 'refund_failed', error },
    );
  }

  async markFailed(scope: TenantScope, paymentId: string, error?: string): Promise<void> {
    await this.guardedTransition(
      paymentId,
      scope,
      'failed',
      ['pending', 'verified', 'settling', 'failed'],
      { status: 'failed', error: error ?? null },
    );
  }

  async markExpired(scope: TenantScope): Promise<number> {
    const result = await this.db
      .updateTable('payments')
      .set({ status: 'expired' })
      .where('status', '=', 'pending')
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .where('expires_at', '<', sql`NOW()` as any)
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0);
  }

  async isTransactionUsed(scope: TenantScope, transactionHash: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('payments')
      .select('payment_id')
      .where('transaction_hash', '=', transactionHash)
      .where('status', '=', 'completed')
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .executeTakeFirst();
    return !!row;
  }

  async isAuthorizationUsed(
    scope: TenantScope,
    authorizationHash: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('payments')
      .select('payment_id')
      .where('authorization_hash', '=', authorizationHash)
      .where('status', '!=', 'failed')
      .where('tenant_id', '=', scope.tenantId)
      .where('configuration_id', '=', scope.configurationId)
      .executeTakeFirst();
    return !!row;
  }

  async close(): Promise<void> {
    if (this.ownsConnection) {
      await this.db.destroy();
    }
  }
}
