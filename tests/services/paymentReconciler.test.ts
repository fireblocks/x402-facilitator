import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentReconciler } from '../../src/services/reconciliation/PaymentReconciler';
import { InMemoryPaymentRepository } from '../../src/repositories/payment/InMemoryPaymentRepository';
import type { PaymentRepository } from '../../src/repositories/interfaces/PaymentRepository';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';
import type {
  FireblocksSettlementService,
  FireblocksTxOutcome,
} from '../../src/services/fireblocksSettlement';
import type { TenantScope } from '../../src/core/tenantScope';

const SCOPE: TenantScope = { tenantId: 'default', configurationId: 'default' };

function makeFactoryStub(outcome: FireblocksTxOutcome | (() => FireblocksTxOutcome)) {
  const svc = {
    getTransactionOutcome: vi.fn().mockImplementation(async () => {
      return typeof outcome === 'function' ? outcome() : outcome;
    }),
  } as unknown as FireblocksSettlementService;
  return {
    get: vi.fn().mockReturnValue(svc),
  } as unknown as FireblocksSettlementFactory;
}

async function seedSettlingRow(
  repo: PaymentRepository,
  fireblocksTxId: string,
  fromAddress = '0xpayer',
): Promise<string> {
  const row = await repo.create(SCOPE, {
    productId: 'prod_test',
    amount: 0,
    amountBaseUnits: '100000',
    assetId: 'USDC_BASECHAIN_ETH_TEST5',
    recipientAddress: '0x' + '1'.repeat(40),
    transferMechanism: 'eip-3009',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  await repo.markVerified(SCOPE, row.paymentId, fromAddress);
  await repo.markSettling(SCOPE, row.paymentId);
  await repo.attachFireblocksTxId(SCOPE, row.paymentId, fireblocksTxId);
  return row.paymentId;
}

describe('PaymentReconciler.reconcileOne', () => {
  let repo: PaymentRepository;

  beforeEach(() => {
    repo = new InMemoryPaymentRepository();
  });

  it('settling + Fireblocks COMPLETED → completed', async () => {
    const factory = makeFactoryStub({
      kind: 'completed',
      txHash: '0xon-chain-hash',
      blockNumber: 42,
    });
    const reconciler = new PaymentReconciler(repo, factory);
    const id = await seedSettlingRow(repo, 'fb-1');

    const result = await reconciler.reconcileOne(SCOPE, id);
    expect(result?.status).toBe('completed');
    expect(result?.transactionHash).toBe('0xon-chain-hash');
    expect(result?.blockNumber).toBe(42);
    expect(result?.paidAt).toBeTruthy();
  });

  it('settling + Fireblocks FAILED → failed with Fireblocks: prefix', async () => {
    const factory = makeFactoryStub({ kind: 'failed', reason: 'BLOCKED (AML rule)' });
    const reconciler = new PaymentReconciler(repo, factory);
    const id = await seedSettlingRow(repo, 'fb-2');

    const result = await reconciler.reconcileOne(SCOPE, id);
    expect(result?.status).toBe('failed');
    expect(result?.error).toMatch(/^Fireblocks:/);
    expect(result?.error).toMatch(/BLOCKED \(AML rule\)/);
  });

  it('settling + Fireblocks in_flight → no-op (row stays settling)', async () => {
    const factory = makeFactoryStub({ kind: 'in_flight', status: 'BROADCASTING' });
    const reconciler = new PaymentReconciler(repo, factory);
    const id = await seedSettlingRow(repo, 'fb-3');

    const result = await reconciler.reconcileOne(SCOPE, id);
    expect(result?.status).toBe('settling');
    expect(result?.fireblocksTxId).toBe('fb-3');
  });

  it('legacy heal: failed + fireblocksTxId + Fireblocks COMPLETED → completed', async () => {
    // Simulate a row that the route preempted to `failed` before the
    // reconciler-ownership invariant was added.
    const factory = makeFactoryStub({
      kind: 'completed',
      txHash: '0xlanded-after-all',
      blockNumber: 99,
    });
    const reconciler = new PaymentReconciler(repo, factory);
    const id = await seedSettlingRow(repo, 'fb-legacy');
    await repo.markFailed(SCOPE, id, 'gave up too early');

    const result = await reconciler.reconcileOne(SCOPE, id);
    expect(result?.status).toBe('completed');
    expect(result?.transactionHash).toBe('0xlanded-after-all');
  });

  it('skips rows without fireblocksTxId (nothing to query)', async () => {
    const factory = makeFactoryStub({ kind: 'completed', txHash: '0x', blockNumber: 0 });
    const reconciler = new PaymentReconciler(repo, factory);
    const row = await repo.create(SCOPE, {
      productId: 'prod_test',
      amount: 0,
      amountBaseUnits: '100000',
      assetId: 'USDC_BASECHAIN_ETH_TEST5',
      recipientAddress: '0x' + '1'.repeat(40),
      transferMechanism: 'eip-3009',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    // Drive through the legal state machine (pending → verified →
    // settling) without ever attaching a fireblocksTxId.
    await repo.markVerified(SCOPE, row.paymentId, '0xpayer');
    await repo.markSettling(SCOPE, row.paymentId);

    const result = await reconciler.reconcileOne(SCOPE, row.paymentId);
    expect(result?.status).toBe('settling');
    expect(factory.get).not.toHaveBeenCalled();
  });

  it('does not touch terminal-merchant-managed states (completed, refunded, refund_failed)', async () => {
    const factory = makeFactoryStub({ kind: 'completed', txHash: '0x', blockNumber: 0 });
    const reconciler = new PaymentReconciler(repo, factory);
    const id = await seedSettlingRow(repo, 'fb-final');
    await repo.markComplete(SCOPE, id, '0xfinal', '0xpayer', 7);

    const result = await reconciler.reconcileOne(SCOPE, id);
    expect(result?.status).toBe('completed');
    expect(factory.get).not.toHaveBeenCalled();
  });

  it('returns undefined for unknown paymentId', async () => {
    const factory = makeFactoryStub({ kind: 'completed', txHash: '0x', blockNumber: 0 });
    const reconciler = new PaymentReconciler(repo, factory);
    const result = await reconciler.reconcileOne(SCOPE, 'pay_does_not_exist');
    expect(result).toBeUndefined();
  });
});

describe('PaymentReconciler.reconcileOpen', () => {
  it('summarises mixed outcomes across settling + legacy failed rows', async () => {
    const repo = new InMemoryPaymentRepository();
    const outcomes: Record<string, FireblocksTxOutcome> = {
      'fb-A': { kind: 'completed', txHash: '0xA', blockNumber: 1 },
      'fb-B': { kind: 'failed', reason: 'BLOCKED' },
      'fb-C': { kind: 'in_flight', status: 'BROADCASTING' },
      'fb-D': { kind: 'completed', txHash: '0xD', blockNumber: 4 },
    };
    const svc = {
      getTransactionOutcome: vi.fn().mockImplementation(async (id: string) => outcomes[id]),
    } as unknown as FireblocksSettlementService;
    const factory = {
      get: vi.fn().mockReturnValue(svc),
    } as unknown as FireblocksSettlementFactory;

    await seedSettlingRow(repo, 'fb-A');
    await seedSettlingRow(repo, 'fb-B');
    await seedSettlingRow(repo, 'fb-C');
    // legacy: failed + fireblocksTxId, should be lifted to completed
    const legacyId = await seedSettlingRow(repo, 'fb-D');
    await repo.markFailed(SCOPE, legacyId, 'preempted');

    const reconciler = new PaymentReconciler(repo, factory);
    const summary = await reconciler.reconcileOpen(SCOPE);
    expect(summary.scanned).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.inFlight).toBe(1);
  });
});
