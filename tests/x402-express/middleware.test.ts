import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { x402Middleware } from '../../packages/x402-express/src/middleware';
import type { FacilitatorClient } from '../../packages/x402-express/src/facilitatorClient';
import type { PaymentRequired } from '../../packages/x402-express/src/types';

const quote: PaymentRequired = {
  x402Version: 2,
  resource: { url: 'http://placeholder/premium' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x0000000000000000000000000000000000000001',
      payTo: '0x0000000000000000000000000000000000000002',
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
};

function buildApp(): express.Express {
  const clientOverride = {
    createForProduct: async () => quote,
  } as unknown as FacilitatorClient;

  const app = express();
  app.use(
    x402Middleware({
      facilitatorUrl: 'http://facilitator.invalid',
      apiKey: 'test-key',
      products: [{ endpoint: '/premium', productId: 'prod_test' }],
      clientOverride,
    }),
  );
  app.get('/premium', (_req, res) => res.json({ paid: true }));
  app.get('/hello', (_req, res) => res.json({ free: true }));
  return app;
}

describe('x402Middleware path matching', () => {
  it.each([
    '/premium',
    '/premium/',
    '/premium//',
    '/PREMIUM',
    '/Premium/',
    '/premium/?x=1',
  ])('requires payment for %s', async (path) => {
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(402);
    expect(res.body.paid).toBeUndefined();
  });

  it('does not gate unrelated paths', async () => {
    const res = await request(buildApp()).get('/hello');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ free: true });
  });
});
