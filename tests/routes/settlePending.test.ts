/**
 * HTTP-level coverage for what POST /settle returns when the live poll
 * cap is hit with a Fireblocks tx id already attached. Exercises the
 * real router (`createPaymentRoutes`) over supertest — only the
 * transfer mechanism's `verify`/`settle` are stubbed, since signature
 * verification and the Fireblocks SDK are out of scope here. Everything
 * else (route logic, the real `InMemoryPaymentRepository`) is
 * production code.
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

describe('POST /settle — pending poll-cap response', () => {
  it('poll-cap timeout: 200 + pending:true + fireblocksTxId, row left in `settling`', async () => {
    const fireblocksTxId = 'fb-tx-poll-cap';
    const mechanismStub: TransferMechanism = {
      verify: async () => ({ valid: true, signer: PAYER }),
      settle: async ({ onSettlementTxId }: any) => {
        // Mirrors contractCall() + the mechanism's own catch conversion:
        // attach the Fireblocks tx id *before* polling, then the poll
        // loop times out and the mechanism returns a pending result
        // (not a plain failure) per the FireblocksPollTimeoutError fix.
        await onSettlementTxId(fireblocksTxId);
        return {
          success: false,
          pending: true,
          fireblocksTxId,
          error:
            `Fireblocks transaction ${fireblocksTxId} did not reach terminal state after ` +
            `150 polls (last status: BROADCASTING). fireblocksTxId is persisted — reconcile via ` +
            `POST /api/admin/payments/<id>/sync.`,
        };
      },
    } as any;

    const { app, payments } = buildApp(mechanismStub);
    const res = await request(app).post('/api/payments/settle').send(settleBody());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.transaction).toBe('');
    expect(res.body.pending).toBe(true);
    expect(res.body.fireblocksTxId).toBe(fireblocksTxId);
    expect(res.body.errorReason).toContain('did not reach terminal state');

    const rows = await payments.list(SCOPE, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('settling');
    expect(rows[0].fireblocksTxId).toBe(fireblocksTxId);
  });

  it('a genuine (non-pending) settlement failure still reports plain success:false, no pending flag', async () => {
    const mechanismStub: TransferMechanism = {
      verify: async () => ({ valid: true, signer: PAYER }),
      settle: async ({ onSettlementTxId }: any) => {
        await onSettlementTxId('fb-tx-failed');
        return { success: false, error: 'Fireblocks transaction fb-tx-failed failed: FAILED (INSUFFICIENT_FUNDS)' };
      },
    } as any;

    const { app } = buildApp(mechanismStub);
    const res = await request(app).post('/api/payments/settle').send(settleBody());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.pending).toBeUndefined();
    expect(res.body.fireblocksTxId).toBeUndefined();
  });
});
