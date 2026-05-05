# @x402/express

Express middleware for the x402 payment protocol. Returns **402 Payment Required** when a gated request arrives without a signature; calls an x402 facilitator for verification and on-chain settlement when one is provided.

## Install

```bash
npm install @x402/express
```

## Usage

```ts
import express from 'express';
import { x402Middleware } from '@x402/express';

const app = express();
app.use(express.json());

app.use(
  x402Middleware({
    facilitatorUrl: process.env.FACILITATOR_URL!,   // e.g. https://facilitator.example.com
    apiKey: process.env.FACILITATOR_API_KEY!,       // `process-payments` scope
    settlement: 'optimistic',                       // or 'settle-first'
    products: [
      {
        endpoint: '/premium',
        scheme: 'exact',
        network: 'eip155:84532',                    // Base Sepolia
        amount: '100000',                           // 0.10 USDC (6 decimals)
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0xYourReceiverAddress',
        eip712: { name: 'USDC', version: '2' },
        transferMechanism: 'eip-3009',
      },
    ],
  }),
);

app.get('/premium', (_req, res) => {
  res.json({ data: 'gold!' });
});

app.listen(3010);
```

The middleware handles:

- 402 response with the EIP-712 quote when `payment-signature` header is absent.
- Forwarding the signed payload to the facilitator's `/api/payments/verify`.
- Running `/api/payments/settle` — either synchronously (`settle-first`) before serving or in the background (`optimistic`, default) after serving.
- Adding the `PAYMENT-RESPONSE` header on successful settle-first flows.

Non-product requests pass through untouched.

## License

ISC.
