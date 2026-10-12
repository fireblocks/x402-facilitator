/**
 * HTTP-level coverage for what POST /settle returns when a payer
 * replays the same signed authorization. Exercises the real router
 * (`createPaymentRoutes`) over supertest — only the transfer
 * mechanism's `verify`/`settle` are stubbed, since signature
 * verification and the Fireblocks SDK are out of scope here. Everything
 * else (route logic, the real `InMemoryPaymentRepository`, the real
 * `DuplicateAuthorizationError` class, the real `getByAuthorizationHash`
 * lookup) is production code.
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createPaymentRoutes } from '../../src/routes/payments';
import { InMemoryPaymentRepository } from '../../src/repositories/payment/InMemoryPaymentRepository';
import { MechanismRegistry, TransferMechanism } from '../../src/mechanisms';
import { ApiTokenPrincipal } from '../../src/auth/principals';
import { V2PaymentPayload, V2PaymentRequirements } from '../../src/types/entities';

const SCOPE = { tenantId: 'default', configurationId: 'default' };
const ASSET_ADDRESS = '0x' + '7'.repeat(40);
const CHAIN_ID = 84532;
const PAYER = '0x' + '3'.repeat(40);
const RECIPIENT = '0x' + '4'.repeat(40);
const PRODUCT_ID = 'prod-1';

function buildApp(mechanismStub: TransferMechanism) {
  const assets = {
    list: () => [
      {
        assetId: 'usdc',
        address: ASSET_ADDRESS,
        chainId: CHAIN_ID,
        eip712Name: 'USDC',
        eip712Version: '2',
        transferMechanism: 'eip-3009',
      },
    ],
    get: (id: string) =>
      id === 'usdc'
        ? { assetId: 'usdc', chainId: CHAIN_ID, transferMechanism: 'eip-3009' }
        : undefined,
  } as any;

  const products = {
    get: (_scope: unknown, productId: string) =>
      productId === PRODUCT_ID
        ? { pricing: [{ assetId: 'usdc', transferMechanism: 'eip-3009' }] }
        : undefined,
  } as any;

  const payments = new InMemoryPaymentRepository();

  const mechanismRegistry: MechanismRegistry = {
    getMechanism: () => mechanismStub,
    getAvailable: () => ['eip-3009'],
  } as any;

  const app = express();
  app.use(express.json());
  // Stand-in for the real apiTokenAuth + apiTokenScope middleware chain —
  // sets req.principal/req.scope directly so the test hits the real
  // `requireScope('process-payments')` guard with a principal that
  // satisfies it, same as index.ts wires in production.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.principal = {
      kind: 'apiToken',
      tenantId: SCOPE.tenantId,
      configurationId: SCOPE.configurationId,
      keyId: 'test-key',
      scopes: ['process-payments'],
      label: null,
    } as ApiTokenPrincipal;
    req.scope = SCOPE;
    next();
  });
  app.use(
    '/api/payments',
    createPaymentRoutes({
      facilitator: {} as any,
      assets,
      products,
      payments,
      mechanismRegistry,
      fireblocksFactory: {} as any,
      pricing: {} as any,
      integrityFactory: {} as any,
      configFile: {} as any,
    }),
  );
  return { app, payments };
}

function settleBody(): { paymentPayload: V2PaymentPayload; paymentRequirements: V2PaymentRequirements } {
  const paymentRequirements: V2PaymentRequirements = {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    amount: '100000',
    asset: ASSET_ADDRESS,
    payTo: RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2', productId: PRODUCT_ID },
  };
  const paymentPayload: V2PaymentPayload = {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: {
      signature: '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b',
      authorization: {
        from: PAYER,
        to: RECIPIENT,
        value: '100000',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: '0x' + '22'.repeat(32),
      } as any,
    },
  };
  return { paymentPayload, paymentRequirements };
}

describe('POST /settle — enriched duplicate-authorization 409', () => {
  it('replay of the same authorization: 409 enriched with the original status + transaction hash', async () => {
    const happyMechanism: TransferMechanism = {
      verify: async () => ({ valid: true, signer: PAYER }),
      settle: async ({ onSettlementTxId }: any) => {
        await onSettlementTxId('fb-tx-first');
        return { success: true, transactionHash: '0x' + 'aa'.repeat(32), blockNumber: 1 };
      },
    } as any;

    const { app } = buildApp(happyMechanism);
    const body = settleBody();

    const first = await request(app).post('/api/payments/settle').send(body);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    const originalTxHash = first.body.transaction;
    expect(originalTxHash).toMatch(/^0xaa/);

    // Exact same authorization payload replayed.
    const second = await request(app).post('/api/payments/settle').send(body);

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: 'invalid_payload',
      details: 'This authorization has already been processed',
      status: 'completed',
      transaction: originalTxHash,
      fireblocksTxId: 'fb-tx-first',
    });
  });

  it('replay while the original is still settling: 409 carries status + fireblocksTxId, no transaction hash yet', async () => {
    // A fireblocksTxId gets attached before the mechanism reports failure —
    // same as a live poll timing out or a transient error mid-poll — which
    // is what leaves the row in `settling` for this test, independent of
    // how that failure is surfaced in the first response.
    const mechanismStub: TransferMechanism = {
      verify: async () => ({ valid: true, signer: PAYER }),
      settle: async ({ onSettlementTxId }: any) => {
        await onSettlementTxId('fb-tx-inflight');
        return { success: false, error: 'still polling' };
      },
    } as any;

    const { app } = buildApp(mechanismStub);
    const body = settleBody();

    const first = await request(app).post('/api/payments/settle').send(body);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(false);

    const second = await request(app).post('/api/payments/settle').send(body);

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: 'invalid_payload',
      details: 'This authorization has already been processed',
      status: 'settling',
      fireblocksTxId: 'fb-tx-inflight',
    });
  });
});
