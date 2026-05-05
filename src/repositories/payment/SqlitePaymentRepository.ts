/**
 * SQLite-backed payment repository.
 *
 * Uses better-sqlite3 directly (synchronous). Returns resolved promises
 * to conform to the async PaymentRepository interface.
 *
 * Scope columns are persisted — a future multi-tenant deployment can
 * share one DB across tenants by filtering on tenant_id+configuration_id.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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

interface PaymentRow {
  payment_id: string;
  tenant_id: string;
  configuration_id: string;
  product_id: string;
  amount: number;
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
  created_at: string;
  updated_at: string;
  expires_at: string;
  paid_at: string | null;
}

function rowToDomain(row: PaymentRow): Payment {
  return {
    paymentId: row.payment_id,
    tenantId: row.tenant_id,
    configurationId: row.configuration_id,
    productId: row.product_id,
    amount: row.amount,
    // SQLite returns INTEGER columns as JS numbers; coerce to string so
    // the domain shape is consistent with the postgres adapter and 18-
    // decimal amounts above 2^53 are preserved end-to-end.
    amountBaseUnits: String(row.amount_base_units),
    assetId: row.asset_id,
    recipientAddress: row.recipient_address,
    fromAddress: row.from_address,
    status: row.status,
    transferMechanism: row.transfer_mechanism,
    error: row.error,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number,
    fireblocksTxId: row.fireblocks_tx_id,
    authorizationHash: row.authorization_hash ?? null,
    refundTxHash: row.refund_tx_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
  };
}

export interface SqlitePaymentRepositoryOptions {
  dbPath?: string;
}

export class SqlitePaymentRepository implements PaymentRepository {
  private db: Database.Database;

  constructor(opts: SqlitePaymentRepositoryOptions = {}) {
    const dbPath =
      opts.dbPath ||
      process.env.DB_PATH ||
      path.resolve(process.cwd(), 'data', 'facilitator.db');
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        configuration_id TEXT NOT NULL DEFAULT 'default',
        product_id TEXT NOT NULL,
        amount REAL NOT NULL,
        -- TEXT (decimal-string of token base units) preserves precision for
        -- 18-decimal tokens above 2^53 / 2^63 boundaries.
        amount_base_units TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        from_address TEXT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending','verified','settling','settled','completed',
          'refunding','refunded','refund_failed','expired','failed'
        )),
        transfer_mechanism TEXT NULL,
        error TEXT NULL,
        transaction_hash TEXT NULL,
        block_number INTEGER NULL,
        fireblocks_tx_id TEXT NULL,
        authorization_hash TEXT NULL,
        refund_tx_hash TEXT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        paid_at TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payments_scope ON payments(tenant_id, configuration_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_payments_product ON payments(product_id);
      CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_hash);
      CREATE TRIGGER IF NOT EXISTS trg_payments_updated_at
      AFTER UPDATE ON payments
      FOR EACH ROW
      BEGIN
        UPDATE payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
      END;
    `);
    // Idempotent migrations for older DBs.
    this.tryAddColumn('fireblocks_tx_id TEXT NULL');
    this.tryAddColumn('authorization_hash TEXT NULL');
    this.tryAddColumn('refund_tx_hash TEXT NULL');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_payments_fireblocks_tx_id ON payments(fireblocks_tx_id)',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_payments_authorization_hash ON payments(authorization_hash)',
    );
    // Authoritative replay protection: at most one non-failed row per
    // (scope, authorization_hash). NULL hashes are unconstrained
    // (SQLite UNIQUE allows multiple NULLs); failed rows are excluded
    // so a verify error doesn't permanently lock a re-signed
    // authorization out.
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_authorization_hash
       ON payments(tenant_id, configuration_id, authorization_hash)
       WHERE authorization_hash IS NOT NULL AND status != 'failed'`,
    );
  }

  private tryAddColumn(definition: string): void {
    try {
      this.db.exec(`ALTER TABLE payments ADD COLUMN ${definition}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }

  async create(scope: TenantScope, input: CreatePaymentInput): Promise<Payment> {
    const paymentId = randId('pay');
    try {
      this.db
        .prepare(
          `INSERT INTO payments (
             payment_id, tenant_id, configuration_id, product_id, amount, amount_base_units,
             asset_id, recipient_address, transfer_mechanism, authorization_hash, status, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          paymentId,
          scope.tenantId,
          scope.configurationId,
          input.productId,
          input.amount,
          input.amountBaseUnits,
          input.assetId,
          input.recipientAddress,
          input.transferMechanism ?? null,
          input.authorizationHash ?? null,
          input.expiresAt,
        );
    } catch (err) {
      const msg = (err as Error).message;
      // better-sqlite3 surfaces unique-constraint violations as
      // SQLITE_CONSTRAINT_UNIQUE with a message naming the index.
      if (
        input.authorizationHash &&
        /UNIQUE constraint failed/i.test(msg) &&
        /authorization_hash|uniq_payments_authorization_hash/i.test(msg)
      ) {
        throw new DuplicateAuthorizationError(input.authorizationHash);
      }
      throw err;
    }
    const row = this.db
      .prepare(
        'SELECT * FROM payments WHERE payment_id = ? AND tenant_id = ? AND configuration_id = ?',
      )
      .get(paymentId, scope.tenantId, scope.configurationId) as PaymentRow | undefined;
    if (!row) throw new Error('Failed to create payment');
    return rowToDomain(row);
  }

  async get(scope: TenantScope, paymentId: string): Promise<Payment | undefined> {
    const row = this.db
      .prepare(
        'SELECT * FROM payments WHERE payment_id = ? AND tenant_id = ? AND configuration_id = ?',
      )
      .get(paymentId, scope.tenantId, scope.configurationId) as PaymentRow | undefined;
    return row ? rowToDomain(row) : undefined;
  }

  async list(scope: TenantScope, filter?: ListPaymentsFilter): Promise<Payment[]> {
    const clauses: string[] = ['tenant_id = ?', 'configuration_id = ?'];
    const params: unknown[] = [scope.tenantId, scope.configurationId];
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    let sql = `SELECT * FROM payments WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`;
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }
    const rows = this.db.prepare(sql).all(...params) as PaymentRow[];
    return rows.map(rowToDomain);
  }

  /**
   * Atomic status-gated UPDATE. Returns true if a row was changed,
   * throws InvalidStateTransitionError if zero rows matched (the row
   * exists but is in the wrong state, or doesn't exist). The status
   * predicate is the load-bearing TOCTOU guard — callers do NOT need
   * to read the row first.
   */
  private guardedTransition(
    paymentId: string,
    scope: TenantScope,
    target: PaymentStatus | 'attach_fireblocks_tx_id',
    allowedFrom: ReadonlyArray<PaymentStatus>,
    setExpr: string,
    setParams: ReadonlyArray<unknown>,
    extraWhere = '',
  ): void {
    const allowedList = allowedFrom.map(() => '?').join(',');
    const sql =
      `UPDATE payments SET ${setExpr} ` +
      `WHERE payment_id = ? AND tenant_id = ? AND configuration_id = ? ` +
      `AND status IN (${allowedList})${extraWhere}`;
    const result = this.db
      .prepare(sql)
      .run(
        ...setParams,
        paymentId,
        scope.tenantId,
        scope.configurationId,
        ...allowedFrom,
      );
    if (result.changes === 0) {
      throw new InvalidStateTransitionError(paymentId, target, allowedFrom);
    }
  }

  async markVerified(scope: TenantScope, paymentId: string, fromAddress: string): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'verified',
      ['pending'],
      `status = 'verified', from_address = ?`,
      [fromAddress],
    );
  }

  async markSettling(scope: TenantScope, paymentId: string): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'settling',
      ['verified'],
      `status = 'settling'`,
      [],
    );
  }

  /**
   * Idempotent attach — only writes when fireblocks_tx_id IS NULL.
   * Prevents accidental overwrite of an existing handle (e.g. the
   * reconciler reading a stale row while a fresh settle attaches a
   * new id).
   */
  async attachFireblocksTxId(
    scope: TenantScope,
    paymentId: string,
    fireblocksTxId: string,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE payments SET fireblocks_tx_id = ? ` +
          `WHERE payment_id = ? AND tenant_id = ? AND configuration_id = ? ` +
          `AND fireblocks_tx_id IS NULL`,
      )
      .run(fireblocksTxId, paymentId, scope.tenantId, scope.configurationId);
    if (result.changes === 0) {
      // Either row missing, wrong scope, or already has a tx id. Treat
      // "already attached" as a no-op so callers can retry safely;
      // distinguish via a get() if the caller cares.
      const existing = this.db
        .prepare(
          `SELECT fireblocks_tx_id FROM payments WHERE payment_id = ? AND tenant_id = ? AND configuration_id = ?`,
        )
        .get(paymentId, scope.tenantId, scope.configurationId) as
        | { fireblocks_tx_id: string | null }
        | undefined;
      if (!existing) {
        throw new InvalidStateTransitionError(
          paymentId,
          'attach_fireblocks_tx_id',
          [],
        );
      }
      // existing.fireblocks_tx_id is non-null — already attached. No-op.
    }
  }

  async markSettled(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'settled',
      ['settling'],
      `status = 'settled', transaction_hash = ?, from_address = ?, block_number = ?`,
      [transactionHash, fromAddress, blockNumber ?? null],
    );
  }

  async markComplete(
    scope: TenantScope,
    paymentId: string,
    transactionHash: string,
    fromAddress: string,
    blockNumber?: number,
  ): Promise<void> {
    // `failed` is allowed for the reconciler's legacy-heal path: rows
    // preempted to `failed` by an older settle-route branch can be lifted
    // back to `completed` once Fireblocks confirms the on-chain landing.
    this.guardedTransition(
      paymentId,
      scope,
      'completed',
      ['settling', 'settled', 'failed'],
      `status = 'completed', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ` +
        `transaction_hash = ?, from_address = ?, block_number = ?`,
      [transactionHash, fromAddress, blockNumber ?? null],
    );
  }

  async markRefunding(scope: TenantScope, paymentId: string): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'refunding',
      ['completed', 'settled'],
      `status = 'refunding'`,
      [],
    );
  }

  async markRefunded(scope: TenantScope, paymentId: string, refundTxHash: string): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'refunded',
      ['refunding'],
      // Persist the refund tx hash in `refund_tx_hash`; SAST F-2 called
      // out that the previous implementation silently dropped it.
      `status = 'refunded', error = 'Upstream failed — funds refunded', refund_tx_hash = ?`,
      [refundTxHash],
    );
  }

  async markRefundFailed(scope: TenantScope, paymentId: string, error: string): Promise<void> {
    this.guardedTransition(
      paymentId,
      scope,
      'refund_failed',
      ['refunding'],
      `status = 'refund_failed', error = ?`,
      [error],
    );
  }

  async markFailed(scope: TenantScope, paymentId: string, error?: string): Promise<void> {
    // pending/verified/settling are the pre-terminal states the settle
    // and verify routes can hit on an error path. `failed` is allowed
    // for idempotent retries from outer catch blocks.
    this.guardedTransition(
      paymentId,
      scope,
      'failed',
      ['pending', 'verified', 'settling', 'failed'],
      `status = 'failed', error = ?`,
      [error ?? null],
    );
  }

  async markExpired(scope: TenantScope): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE payments SET status = 'expired' WHERE status = 'pending' AND tenant_id = ? AND configuration_id = ? AND datetime(expires_at) < datetime('now')`,
      )
      .run(scope.tenantId, scope.configurationId);
    return result.changes;
  }

  async isTransactionUsed(scope: TenantScope, transactionHash: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT payment_id FROM payments WHERE transaction_hash = ? AND status = 'completed' AND tenant_id = ? AND configuration_id = ?`,
      )
      .get(transactionHash, scope.tenantId, scope.configurationId);
    return !!row;
  }

  async isAuthorizationUsed(
    scope: TenantScope,
    authorizationHash: string,
  ): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT payment_id FROM payments
         WHERE authorization_hash = ? AND status != 'failed'
         AND tenant_id = ? AND configuration_id = ?`,
      )
      .get(authorizationHash, scope.tenantId, scope.configurationId);
    return !!row;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }
}
