/**
 * Contract conformance tests for PaymentRepository.
 *
 * The same suite runs against every adapter — one bug in one impl that
 * the others don't have is exactly the failure mode this catches.
 *
 * Postgres adapter is skipped here (requires a live database); see
 * `e2e.ts` for integration coverage of the SQL path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InMemoryPaymentRepository } from '../../src/repositories/payment/InMemoryPaymentRepository';
import { SqlitePaymentRepository } from '../../src/repositories/payment/SqlitePaymentRepository';
import type {
  PaymentRepository,
  CreatePaymentInput,
} from '../../src/repositories/interfaces/PaymentRepository';
import type { TenantScope } from '../../src/core/tenantScope';

const SCOPE: TenantScope = { tenantId: 'default', configurationId: 'default' };
const OTHER_SCOPE: TenantScope = { tenantId: 'default', configurationId: 'other' };

function makeInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    productId: 'prod_test',
    amount: 0.1,
    amountBaseUnits: '100000',
    assetId: 'USDC_BASECHAIN_ETH_TEST5',
    recipientAddress: '0x' + '1'.repeat(40),
    transferMechanism: 'eip-3009',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

type Adapter = {
  name: string;
  build(): Promise<PaymentRepository>;
  teardown(repo: PaymentRepository): Promise<void>;
};

const adapters: Adapter[] = [
  {
    name: 'InMemoryPaymentRepository',
    build: async () => new InMemoryPaymentRepository(),
    teardown: async () => {},
  },
  {
    name: 'SqlitePaymentRepository',
    build: async () => {
      const dbPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'x402-tests-')),
        'test.db',
      );
      return new SqlitePaymentRepository({ dbPath });
    },
    teardown: async (repo) => {
      await repo.close?.();
    },
  },
];

for (const adapter of adapters) {
  describe(`PaymentRepository contract — ${adapter.name}`, () => {
    let repo: PaymentRepository;

    beforeEach(async () => {
      repo = await adapter.build();
    });

    afterEach(async () => {
      await adapter.teardown(repo);
    });

    it('create + get round-trip preserves amountBaseUnits as a string', async () => {
      const created = await repo.create(SCOPE, makeInput({ amountBaseUnits: '999999999999999999' }));
      expect(created.paymentId).toMatch(/^pay_/);
      expect(created.status).toBe('pending');
      expect(created.amountBaseUnits).toBe('999999999999999999');

      const got = await repo.get(SCOPE, created.paymentId);
      expect(got?.amountBaseUnits).toBe('999999999999999999');
    });

    it('happy-path transitions: pending → verified → settling → completed', async () => {
      const p = await repo.create(SCOPE, makeInput());

      await repo.markVerified(SCOPE, p.paymentId, '0xpayer');
      expect((await repo.get(SCOPE, p.paymentId))?.status).toBe('verified');

      await repo.markSettling(SCOPE, p.paymentId);
      expect((await repo.get(SCOPE, p.paymentId))?.status).toBe('settling');

      await repo.attachFireblocksTxId(SCOPE, p.paymentId, 'fb-tx-1');
      expect((await repo.get(SCOPE, p.paymentId))?.fireblocksTxId).toBe('fb-tx-1');

      await repo.markComplete(SCOPE, p.paymentId, '0xhash', '0xpayer', 12345);
      const final = await repo.get(SCOPE, p.paymentId);
      expect(final?.status).toBe('completed');
      expect(final?.transactionHash).toBe('0xhash');
      expect(final?.fromAddress).toBe('0xpayer');
      expect(final?.blockNumber).toBe(12345);
      expect(final?.paidAt).toBeTruthy();
    });

    it('markFailed records the error string', async () => {
      const p = await repo.create(SCOPE, makeInput());
      await repo.markFailed(SCOPE, p.paymentId, 'signature invalid');
      const got = await repo.get(SCOPE, p.paymentId);
      expect(got?.status).toBe('failed');
      expect(got?.error).toBe('signature invalid');
    });

    it('isAuthorizationUsed returns false when not seen', async () => {
      expect(await repo.isAuthorizationUsed(SCOPE, 'hash-never-seen')).toBe(false);
    });

    it('isAuthorizationUsed returns true for any non-failed row with that hash', async () => {
      await repo.create(SCOPE, makeInput({ authorizationHash: 'auth-1' }));
      expect(await repo.isAuthorizationUsed(SCOPE, 'auth-1')).toBe(true);
    });

    it('isAuthorizationUsed returns false for a failed row with that hash', async () => {
      const p = await repo.create(SCOPE, makeInput({ authorizationHash: 'auth-2' }));
      await repo.markFailed(SCOPE, p.paymentId, 'bad sig');
      expect(await repo.isAuthorizationUsed(SCOPE, 'auth-2')).toBe(false);
    });

    it('isAuthorizationUsed scope-isolates (auth in scope A invisible to scope B)', async () => {
      await repo.create(SCOPE, makeInput({ authorizationHash: 'auth-3' }));
      expect(await repo.isAuthorizationUsed(SCOPE, 'auth-3')).toBe(true);
      expect(await repo.isAuthorizationUsed(OTHER_SCOPE, 'auth-3')).toBe(false);
    });

    it('list filters by status and scope', async () => {
      const a = await repo.create(SCOPE, makeInput());
      await repo.create(SCOPE, makeInput());
      await repo.markSettling(SCOPE, a.paymentId);
      await repo.create(OTHER_SCOPE, makeInput()); // different scope

      const settlingInScope = await repo.list(SCOPE, { status: 'settling' });
      expect(settlingInScope).toHaveLength(1);
      expect(settlingInScope[0].paymentId).toBe(a.paymentId);

      const allInScope = await repo.list(SCOPE);
      expect(allInScope).toHaveLength(2); // does not leak OTHER_SCOPE
    });

    it('get/markX in the wrong scope is a no-op (cannot see or mutate)', async () => {
      const p = await repo.create(SCOPE, makeInput());
      expect(await repo.get(OTHER_SCOPE, p.paymentId)).toBeUndefined();

      // markFailed in wrong scope should not affect the row in SCOPE.
      await repo.markFailed(OTHER_SCOPE, p.paymentId, 'wrong scope');
      const original = await repo.get(SCOPE, p.paymentId);
      expect(original?.status).toBe('pending');
      expect(original?.error).toBeNull();
    });
  });
}
