/**
 * Example merchant server that uses @x402/express to gate a paid
 * endpoint. Talks to the local x402 facilitator for the quote
 * (/api/payments/create), verification, and settlement.
 *
 * Env:
 *   PORT                       default 3010
 *   FACILITATOR_URL            default http://localhost:3000
 *   FACILITATOR_API_KEY        required (mint with `x402 keys create --scopes process-payments`)
 *   PREMIUM_PRODUCT_ID         required — the product_id returned by `x402 products add`
 *   SETTLEMENT_MODE            optimistic | settle-first (default optimistic)
 */

import 'dotenv/config';
import express from 'express';
import { x402Middleware } from '@x402/express';

const PORT = Number(process.env.PORT || 3010);
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3000';
const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;
const PREMIUM_PRODUCT_ID = process.env.PREMIUM_PRODUCT_ID;
const SETTLEMENT_MODE = (process.env.SETTLEMENT_MODE || 'optimistic') as
  | 'optimistic'
  | 'settle-first';

if (!FACILITATOR_API_KEY) {
  console.error(
    'FACILITATOR_API_KEY is not set. Mint one with:\n' +
      '  npm run cli -- keys create --scopes process-payments --label merchant',
  );
  process.exit(1);
}
if (!PREMIUM_PRODUCT_ID) {
  console.error(
    'PREMIUM_PRODUCT_ID is not set. Add a product on the facilitator and copy its product_id:\n' +
      '  npm run cli -- products add --name Premium --endpoint /premium --asset <ASSET> --price 100000',
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

// ── x402 middleware — gates '/premium' by product_id ────────────────
app.use(
  x402Middleware({
    facilitatorUrl: FACILITATOR_URL,
    apiKey: FACILITATOR_API_KEY,
    settlement: SETTLEMENT_MODE,
    products: [{ endpoint: '/premium', productId: PREMIUM_PRODUCT_ID }],
    onSettlement: (o) => {
      // Use stderr so it's unbuffered when piped to a log file.
      process.stderr.write(
        `[merchant] ${o.success ? '✓ settled' : '✗ failed'} ${o.endpoint} payer=${o.payer ?? '?'} tx=${o.txHash ?? '(none)'} err=${o.error ?? ''}\n`,
      );
    },
  }),
);

app.get('/hello', (_req, res) => {
  res.json({ message: 'hello, world (free endpoint)' });
});

app.get('/premium', (_req, res) => {
  res.json({ message: 'gold! this response cost 0.01 USD' });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'x402 example merchant',
    endpoints: { '/hello': 'free', '/premium': `paid (product ${PREMIUM_PRODUCT_ID})` },
    facilitator: FACILITATOR_URL,
  });
});

app.listen(PORT, () => {
  console.log(`x402 example merchant listening on ${PORT}`);
  console.log(`  facilitator:      ${FACILITATOR_URL}`);
  console.log(`  gated path:       /premium → product ${PREMIUM_PRODUCT_ID}`);
  console.log(`  settlement mode:  ${SETTLEMENT_MODE}`);
});
