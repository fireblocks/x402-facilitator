import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  x402Middleware,
} from '../../packages/x402-express/src';

function encodePayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

function makeQuote(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://merchant.test/premium' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '1000',
        asset: '0x0000000000000000000000000000000000000001',
        payTo: '0x0000000000000000000000000000000000000002',
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

function makePayload(accepted: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: {
      signature: '0xdeadbeef',
      authorization: { from: '0x0000000000000000000000000000000000000003' },
    },
  };
}

async function settleTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('x402Middleware optimistic settlement', () => {
  it('does not settle after a downstream 500 response', async () => {
    const quote = makeQuote();
    const verify = vi.fn().mockResolvedValue({ isValid: true, payer: '0xpayer' });
    const settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xsettled',
      network: quote.accepts[0].network,
      payer: '0xpayer',
    });
    const app = express();
    app.use(
      x402Middleware({
        facilitatorUrl: 'https://facilitator.test',
        apiKey: 'token',
        settlement: 'optimistic',
        products: [{ endpoint: '/premium', productId: 'prod_1' }],
        clientOverride: {
          createForProduct: vi.fn().mockResolvedValue(quote),
          verify,
          settle,
        } as any,
      }),
    );
    app.get('/premium', (_req, _res) => {
      throw new Error('boom');
    });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app)
      .get('/premium')
      .set('payment-signature', encodePayload(makePayload(quote.accepts[0])));

    expect(res.status).toBe(500);
    await settleTick();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not settle after a downstream 403 response', async () => {
    const quote = makeQuote();
    const settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xsettled',
      network: quote.accepts[0].network,
      payer: '0xpayer',
    });
    const app = express();
    app.use(
      x402Middleware({
        facilitatorUrl: 'https://facilitator.test',
        apiKey: 'token',
        settlement: 'optimistic',
        products: [{ endpoint: '/premium', productId: 'prod_1' }],
        clientOverride: {
          createForProduct: vi.fn().mockResolvedValue(quote),
          verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xpayer' }),
          settle,
        } as any,
      }),
    );
    app.get('/premium', (_req, res) => {
      res.status(403).json({ error: 'forbidden' });
    });

    const res = await request(app)
      .get('/premium')
      .set('payment-signature', encodePayload(makePayload(quote.accepts[0])));

    expect(res.status).toBe(403);
    await settleTick();
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles after a successful downstream response', async () => {
    const quote = makeQuote();
    const settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xsettled',
      network: quote.accepts[0].network,
      payer: '0xpayer',
    });
    const app = express();
    app.use(
      x402Middleware({
        facilitatorUrl: 'https://facilitator.test',
        apiKey: 'token',
        settlement: 'optimistic',
        products: [{ endpoint: '/premium', productId: 'prod_1' }],
        clientOverride: {
          createForProduct: vi.fn().mockResolvedValue(quote),
          verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xpayer' }),
          settle,
        } as any,
      }),
    );
    app.get('/premium', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .get('/premium')
      .set('payment-signature', encodePayload(makePayload(quote.accepts[0])));

    expect(res.status).toBe(200);
    await settleTick();
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
