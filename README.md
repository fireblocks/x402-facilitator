# x402 Facilitator

Charge for any HTTP endpoint with a one-shot cryptographic signature. Your client signs an EIP-712 message; your server calls this facilitator to verify the signature, and the facilitator settles the token transfer on-chain via [Fireblocks](https://www.fireblocks.com/).

For a deeper architectural walkthrough — auth model, source layout, transfer mechanisms, payment lifecycle, reconciliation — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Contents

- [What this does](#what-this-does)
- [How x402 works](#how-x402-works)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Integrating from your merchant server](#integrating-from-your-merchant-server)
- [Pricing modes](#pricing-modes)
- [The config file](#the-config-file)
- [Management API](#management-api)
- [Payment processing API](#payment-processing-api)
- [Payment Instruction Integrity](#payment-instruction-integrity)
- [CLI reference](#cli-reference)
- [Running in production](#running-in-production)
- [Multiple merchants on one facilitator](#multiple-merchants-on-one-facilitator)
- [License](#license)

---

## What this does

HTTP 402 ("Payment Required") has been a reserved-but-unused status code since HTTP/1.1. The [x402 protocol](https://x402.org) gives it a job: a server responds **402** with a price quote; the client signs an EIP-712 message authorizing exactly that payment; the client retries the same request with a `payment-signature` header; the server verifies and delivers the resource.

This project is the **facilitator** — the service merchants call to verify x402 signatures and settle payments on-chain through Fireblocks. It's **API-only**: merchants run their own server, return 402 themselves using middleware/SDK code, and hit this service at two decision points (`/api/payments/verify` and `/api/payments/settle`). Customer traffic never passes through the facilitator.

This follows the canonical x402 integration pattern (same as Coinbase's reference facilitator).

Out of the box:

- **API-only** — `/api/payments/{create,verify,settle}` + `/api/discovery` + management. No reverse proxy of merchant traffic.
- **Fireblocks settlement** — on-chain transfers via `CONTRACT_CALL`, no raw private keys.
- **Pluggable payment store** — in-memory (tests), SQLite (default), or PostgreSQL.
- **Four transfer mechanisms** — `eip-3009` (USDC-style), `permit2` + `upto-permit2` (any ERC-20), `erc7710` (smart-account delegation).
- **Multi-configuration** — one deployment can host many merchants, each with their own Fireblocks vault, products, and API keys.
- **Two auth surfaces** — persistent API keys (opaque) for payment processing; JWT (HS256 or JWKS) for the management API. Never mixed.
- **Role-based profile** — run the same binary as `processing`, `management`, or `all`.
- **Remote admin CLI** (`x402`) — pure HTTP client for `/api/admin/*`. Authenticates with a JWT minted locally. Works from a laptop, CI, or a dashboard.
- **Local bootstrap** (`npm run setup`) — scaffold config, rotate JWT secrets, import legacy SQLite, all filesystem-only.
- **Testnet-only by default** — the facilitator refuses to boot or register mainnet assets unless `X402_ALLOW_MAINNET=true`.

---

## How x402 works

```
  client                        merchant server                    facilitator
  ──────                        ───────────────                    ───────────
  GET /premium ────────────►    402 Payment Required
                                "0.10 USDC, pay to 0x…"
  sign EIP-712
  GET /premium
  + payment-signature ─────►    POST /api/payments/verify ──►  verify sig (off-chain)
                                                            ◄── { isValid: true, payer }
                                POST /api/payments/settle ──►  submit CONTRACT_CALL
                                                                via Fireblocks, wait
                                                            ◄── { success, txHash }
                                200 OK + PAYMENT-RESPONSE
  ◄─── 200 OK (data) ──────
```

1. Client makes a normal HTTP request to the **merchant's** server.
2. The merchant's middleware notices no `payment-signature` header and returns **402** with a JSON quote describing amount, asset, and recipient.
3. Client signs an EIP-712 message authorizing that exact transfer (no gas, no on-chain tx at this stage).
4. Client retries the same request with `payment-signature: <base64>`.
5. Merchant's middleware calls `POST /api/payments/verify` on the facilitator; if valid, calls `POST /api/payments/settle`; returns the response with a `PAYMENT-RESPONSE` header.

The facilitator itself is a plain HTTP service — it exposes the three payment endpoints (`/supported`, `/verify`, `/settle`) plus a management API, and never sees the actual customer request.

---

## Prerequisites

- **Node.js 20+**
- **A Fireblocks account**: an API key, a vault account ID, and the PEM-format secret file. (If you're just evaluating the facilitator locally and don't have Fireblocks yet, the server will still start with an empty config — you just can't call `fireblocks test` or settle payments.)

---

## Quick start

```bash
git clone https://github.com/fireblocks/x402-facilitator
cd x402-facilitator
npm install

# 1. Local bootstrap — scaffolds config/facilitator.json + secrets/jwt-hs256.key
npm run setup

# 2. Fill in Fireblocks creds: edit config/facilitator.json
#    fireblocks.api_key           → your Fireblocks API key
#    fireblocks.api_secret_path   → path to your PEM (e.g. ./secrets/fireblocks.pem)
#    (The CLI cannot write these remotely — the PEM path is a server-side concern.)

# 3. Start the facilitator
npm run dev                                     # facilitator on :3000

# 4. Build + install the remote CLI globally (one-time)
npm run build && npm link                       # puts `x402` on your PATH

# 5. Mint a local admin JWT and export it
npm run setup:admin-token -- --preset full --ttl 2h   # prints the JWT
export X402_ADMIN_TOKEN=<paste the token>

# 6. Activate Fireblocks vault wallets + cache the receiver addresses
x402 fireblocks test --create-missing

# 7. Import an asset from Fireblocks (auto-fills address, decimals, chain_id;
#    you supply the x402-specific fields)
x402 assets import USDC_BASECHAIN_ETH_TEST5_8SH8 \
    --transfer-mechanism eip-3009 \
    --eip712-name "USDC" --eip712-version 2 \
    --stable

# 8. Declare a product.
#    USD-priced (auto-converts across all accepted assets):
x402 products add --name "Premium" --endpoint /premium \
    --usd-price 0.01 --asset USDC_BASECHAIN_ETH_TEST5_8SH8

#    Or: single asset, native base units:
# x402 products add --name "Premium" --endpoint /premium \
#     --asset USDC_BASECHAIN_ETH_TEST5_8SH8 --price 10000

# 9. Mint a machine API key for the merchant server (calls /verify + /settle)
x402 keys create --scopes process-payments --label my-merchant
#   → prints the key once, copy it into your merchant app's config
```

Verify:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","role":"all","mechanisms":[...], …}
```

---

## Integrating from your merchant server

Your server keeps serving its own traffic. You add middleware (Express/Next.js/Hono/etc — same pattern as Coinbase's x402 SDK packages) that:

1. On every request, inspects the incoming path. If the path is payment-gated and lacks a `payment-signature` header → return **402** with a JSON body (your middleware builds this from a product declared in your config).
2. On a request with a `payment-signature` header → call this facilitator's `POST /api/payments/verify` to check the signature, then `POST /api/payments/settle` to run the on-chain tx. If both succeed, serve your resource.

Request shape your middleware sends to the facilitator:

```bash
curl -X POST https://facilitator.example.com/api/payments/verify \
  -H "Authorization: Bearer $MERCHANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentPayload":     { ... the client-signed payload ... },
    "paymentRequirements":{ ... what you advertised in the 402 ... }
  }'
```

And then `POST /api/payments/settle` with the same body shape.

The facilitator never sees the end-user's HTTP request. It only handles the cryptographic verification and the Fireblocks `CONTRACT_CALL`.

---

## Pricing modes

Each product has a `pricing[]` table listing one entry per accepted asset. Each entry is **one of**:

- **Native-denomination** — `amount` is set. The client is charged exactly `amount` base units of that asset, regardless of exchange rates. Useful when you bill in crypto directly.
- **USD-converted** — `amount` is null. The product's `usd_price` (fractional dollars) is converted to this asset at request time using a `PriceProvider`.

A product can mix both:

```jsonc
{
  "usd_price": 0.10,
  "pricing": [
    { "asset_id": "USDC_BASE" },                  // convert $0.10 → USDC (≈100000 base units)
    { "asset_id": "USDC_POLYGON", "amount": 90000 }, // override: pay 0.09 USDC on Polygon
    { "asset_id": "ETH_BASE" }                    // convert $0.10 → ETH at the current rate
  ]
}
```

### Multiple transfer mechanisms on the same asset

Each pricing row accepts an optional `transfer_mechanism` override. When present, it takes precedence over the asset's own `transfer_mechanism` — so a single asset can be offered under several mechanisms at once, and the 402 emits one `accepts[]` entry per row.

```jsonc
{
  "usd_price": 0.10,
  "pricing": [
    { "asset_id": "USDC_BASE" },                                     // inherit → eip-3009
    { "asset_id": "USDC_BASE", "transfer_mechanism": "permit2" },    // same asset, permit2
    { "asset_id": "USDC_BASE", "transfer_mechanism": "erc7710" }     // same asset, MDF delegation
  ]
}
```

**Enforcement (security):** `/api/payments/verify` and `/api/payments/settle` look up the product referenced by `paymentRequirements.extra.productId` and reject (`400 unsupported_scheme`) if the client's payload implies a mechanism that isn't in the product's pricing. A client can't upgrade `eip-3009` to `permit2` just by shipping a different payload shape.

Clients can filter the offered options locally with `MECHANISM=<name>` on the test client (see `examples/test-client/README.md`).

### PriceProvider

The bundled `PriceProvider` stack is a `CompositePriceProvider` that tries in order:

1. **`StableOnlyPriceProvider`** — any asset marked `stable: true` quotes at 1:1 USD. No network call.
2. **`CoinGeckoPriceProvider`** — queries CoinGecko `/simple/price` using the asset's `price_symbol` (e.g. `ethereum`, `weth`, `matic-network`). 30-second in-memory cache; serves stale prices for up to 5 minutes if the live call fails. Pro-tier users can set `COINGECKO_API_KEY`.

Swap for Pyth / Chainlink / a merchant-owned oracle by implementing the `PriceProvider` interface (`src/services/pricing/PriceProvider.ts`) and passing it into `PricingService` at startup.

Assets that can't be priced at all (no `stable` flag, no `price_symbol`, live provider down) are **dropped from the 402 response**, not rejected — other accepted assets remain available to the client.

### Gas cost — placeholder today

Ethereum mainnet settlement can cost $1+ in gas; the same tx on Base is fractions of a cent. A merchant who quotes "$0.10" should not accept mainnet payments at $0.10, or they lose money to settlement gas.

The `GasCostEstimator` interface + `NoopGasCostEstimator` are wired into the pricing pipeline today but return `0` on every chain. When you're ready to enable chain-aware pricing, implement `GasCostEstimator.estimate(chainId, mechanism)` (using your RPC, Chainlink gas oracles, or Fireblocks fee estimates) and pick a `GasCostPolicy`:

- `ignore` — current default.
- `add-to-quote` — gross up the client's charge so merchant revenue is constant.
- `reject-if-above-pct` — drop uneconomic chains from `accepts[]`.

See `src/services/pricing/GasCostEstimator.ts`.

---

## The config file

Everything non-runtime lives in `config/facilitator.json`. The file is loaded + validated at boot; changes require a server restart.

```jsonc
{
  "tenant_id": "acme",
  "default_configuration_id": "default",
  "assets": [
    {
      "asset_id": "USDC_BASE",
      "blockchain_id": "0318d40f-7709-4f10-b980-11f3abaf31ac",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "decimals": 6,
      "chain_id": 8453,
      "eip712_name": "USD Coin",
      "eip712_version": "2",
      "transfer_mechanism": "eip-3009",
      "stable": true,
      "price_symbol": null
    },
    {
      "asset_id": "ETH_BASE",
      "blockchain_id": "0318d40f-7709-4f10-b980-11f3abaf31ac",
      "address": "0x4200000000000000000000000000000000000006",
      "decimals": 18,
      "chain_id": 8453,
      "eip712_name": "Wrapped Ether",
      "eip712_version": "1",
      "transfer_mechanism": "permit2",
      "stable": false,
      "price_symbol": "weth"
    }
  ],
  "configurations": [
    {
      "configuration_id": "default",
      "public_host": "https://pay.myservice.com",
      "fireblocks": {
        "api_key": "...",
        "api_secret_path": "./secrets/fireblocks.pem",
        "receiver_vault": "0",
        "base_url": "https://api.fireblocks.io",
        "deposit_address_cache": {
          "USDC_BASE": "0xMerchantVaultAddress",
          "ETH_BASE": "0xMerchantVaultAddress"
        }
      },
      "api_keys": [
        {
          "key_id": "ak_...",
          "hash": "sha256:...",
          "scopes": ["process-payments"],
          "label": "agent"
        }
      ],
      "products": [
        {
          "product_id": "prod_...",
          "name": "Premium Data",
          "endpoint": "/premium",
          "scheme": "exact",
          "usd_price": 0.10,
          "pricing": [
            { "asset_id": "USDC_BASE", "amount": null },
            { "asset_id": "ETH_BASE", "amount": null }
          ],
          "description": null,
          "mime_type": "application/json",
          "category": null,
          "is_discoverable": false
        }
      ]
    }
  ]
}
```

A few things to know:

- **`configurations[]`** — one facilitator process can host many merchants. Each configuration has its own Fireblocks credentials, API keys, and product catalog. Clients are routed to the right configuration by the `Host` header matching `public_host`.
- **`asset_id`** is the Fireblocks-native identifier (e.g. `USDC_BASE`, `USDC_POLYGON`, `ETH_BASE`). No separate tokens or blockchains registry — the asset entry carries everything the facilitator needs.
- **Assets** set `stable: true` for USD-pegged stablecoins (no network call at request time) or `price_symbol: "<coingecko-id>"` for live-priced assets.
- **Products** use `pricing[]` to list accepted assets, and optionally a `usd_price` to convert from. Legacy `{asset_id, price}` on a product is still accepted and normalized to a single-entry `pricing[]`.

API key **hashes** are persisted; plaintext is returned once at creation and never again. If you lose a key, revoke it and mint a new one.

---

## Management API

Two independent auth paths, one uniform principal shape:

| Path | Auth | Purpose |
|------|------|---------|
| `/api/admin/*`    | `UserPrincipal`     | Operators. JWT-bearer only (HS256 or JWKS). Per-route scope check. |
| `/api/payments/*` | `ApiTokenPrincipal` | Machine clients. Persistent API keys with scopes. |
| `/api/discovery/*`, `/api/health`, `/api/payments/supported` | public | — |

### Granular admin scopes

Each admin route declares exactly one required scope:

| Scope            | Routes                                                               |
|------------------|----------------------------------------------------------------------|
| `admin:read`     | `GET /facilitator`, `GET /assets`, `GET /products`, `GET /tokens`, `GET /fireblocks` |
| `admin:write`    | `POST`/`DELETE` on assets / products / tokens / fireblocks test      |
| `payments:read`  | `GET /payments`, `GET /payments/:id`                                 |
| `payments:write` | `POST /payments/:id/mark-failed`, `POST /payments/:id/refund`, `POST /payments/:id/sync`, `POST /payments/sync-all`, `POST /payments/sweep-expired` |
| `*`              | Wildcard — passes every admin scope check                            |

Mint a JWT locally with the bundled helper:

```bash
npm run setup:admin-token -- --preset full       # all four admin scopes
npm run setup:admin-token -- --preset readonly   # admin:read + payments:read
npm run setup:admin-token -- --preset payments-ops
npm run setup:admin-token -- --scopes "payments:read admin:read"   # raw
```

It reads the HS256 secret scaffolded by `npm run setup` (or your override — see env vars below), signs a short-lived token (default 1h), and prints it. Export as `X402_ADMIN_TOKEN` and every `x402` CLI call and raw curl against `/api/admin/*` picks it up:

```bash
export X402_ADMIN_TOKEN=<paste token>
x402 payments list
curl -H "authorization: Bearer $X402_ADMIN_TOKEN" http://localhost:3000/api/admin/facilitator
```

In production, skip the local HS256 secret and point `X402_ADMIN_JWT_JWKS_URL` at your IDP's JWKS endpoint. Your IDP issues tokens carrying `tenant_id`, `sub`, `scope` (space-delimited), and optional `configuration_ids`.

### Targeting a configuration

When a tenant holds multiple configurations, admin requests pick one with the `X-Configuration-ID` header or `?configuration=<id>` query parameter. Omitted → `default_configuration_id`:

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" \
     -H "X-Configuration-ID: merchant-b" \
     http://localhost:3000/api/admin/products
```

The authenticated user's `configurationIds` grant must include the chosen configuration, otherwise the request gets **403**.

### Endpoints

#### `GET /api/admin/facilitator`

Returns the configuration block the principal is scoped to, with Fireblocks `api_key` redacted.

```json
{
  "publicHost": "http://localhost:3000",
  "fireblocks": {
    "apiKey": "abcd…wxyz",
    "apiSecretPath": "./secrets/fireblocks.pem",
    "receiverVault": "0",
    "baseUrl": "https://api.fireblocks.io",
    "depositAddressCache": {
      "USDC_BASE": "0x…"
    }
  }
}
```

#### `GET /api/admin/assets` · `GET /api/admin/assets/:assetId`

List or fetch one configured asset.

```json
[
  {
    "assetId": "USDC_BASE",
    "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "decimals": 6,
    "chainId": 8453,
    "eip712Name": "USD Coin",
    "eip712Version": "2",
    "transferMechanism": "eip-3009"
  }
]
```

#### `GET /api/admin/products` · `GET /api/admin/products/:productId`

List or fetch products, with their asset joined.

```json
[
  {
    "productId": "prod_7Lm3nOp",
    "name": "Premium Data",
    "endpoint": "/premium",
    "assetId": "USDC_BASE",
    "price": 100000,
    "scheme": "exact",
    "description": null,
    "mimeType": "application/json",
    "category": null,
    "isDiscoverable": false,
    "asset": { "assetId": "USDC_BASE", "address": "0x…", ... }
  }
]
```

> Adding/editing products over HTTP is not yet supported — use the CLI. The endpoints above are read-only on purpose.

#### `POST /api/admin/assets`

Register an asset. The facilitator calls Fireblocks' `listAssets` to fill `address` / `decimals` / `chain_id`; you supply the x402-specific fields in the body. Requires admin auth.

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "asset_id": "USDC_BASE",
      "transfer_mechanism": "eip-3009",
      "eip712_name": "USD Coin",
      "eip712_version": "2",
      "stable": true
    }' \
    http://localhost:3000/api/admin/assets
```

Response includes the merged asset record plus Fireblocks-side metadata (symbol, assetClass, standards, deprecated flag) for audit.

#### `POST /api/admin/assets/sync`

Re-fetch the Fireblocks-owned fields for every asset in the scope. Body: `{ "apply": false }` for a dry-run diff report; `true` to write. Returns per-asset `diffs[]` and any `errors[]`.

#### API token CRUD — `/api/admin/tokens`

The primary write endpoints. **Use these to mint keys for machine clients that will call `/api/payments/*`.**

`POST /api/admin/tokens` — mint a key:

```bash
curl -X POST \
    -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"scopes":["process-payments"],"label":"agent-primary"}' \
    http://localhost:3000/api/admin/tokens
```

```json
{
  "token": "x402_ak_AbCd1234_plaintextOnlyReturnedOnce",
  "keyId": "ak_AbCd1234",
  "label": "agent-primary",
  "scopes": ["process-payments"]
}
```

Scopes you'll actually use:

- `process-payments` — call `/api/payments/{create,verify,settle}`
- `api:read` — read-only access (reserved for future public read routes)
- `*` — wildcard, also unlocks the admin path under the dev fallback

`GET /api/admin/tokens` — list keys (hashes omitted):

```json
[
  {"keyId":"ak_AbCd1234","label":"agent-primary","scopes":["process-payments"],
   "tenantId":"acme","configurationId":"default"}
]
```

`DELETE /api/admin/tokens/:keyId` — revoke a key. Returns **204** on success, **404** if not found.

#### `GET /api/admin/payments` · `GET /api/admin/payments/:paymentId`

Read-only payment inspection. Scope: `payments:read`. Query params on list: `?status=<status>`, `?limit=<n>`, `?offset=<n>`.

```json
[
  {
    "paymentId": "pay_abc",
    "tenantId": "acme",
    "configurationId": "default",
    "productId": "prod_7Lm3nOp",
    "assetId": "USDC_BASE",
    "amount": 0.1,
    "amountBaseUnits": 100000,
    "recipientAddress": "0x…",
    "fromAddress": "0x…",
    "status": "completed",
    "transferMechanism": "eip-3009",
    "transactionHash": "0x…",
    "blockNumber": 12345678,
    "createdAt": "…",
    "paidAt": "…"
  }
]
```

#### `POST /api/admin/payments/:paymentId/mark-failed`

Force a stuck row into `failed` with an operator-supplied reason. No on-chain action — for rows where the happy-path transitions never closed out (server crash mid-settle, settlement poll timed out, etc.). Scope: `payments:write`.

```bash
curl -X POST https://facilitator.example.com/api/admin/payments/pay_abc/mark-failed \
  -H "Authorization: Bearer $X402_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"settlement poller wedged for >1h; sweeping"}'
```

Returns the updated payment row. 404 if the id doesn't exist.

#### `POST /api/admin/payments/:paymentId/refund`

Refund a payment whose on-chain leg landed (`status` is `completed` or `settled`). Submits a `CONTRACT_CALL` to the token's `transfer(to, amount)` function via Fireblocks. Status transitions: `→ refunding → refunded` (or `refund_failed` with the Fireblocks error recorded). Scope: `payments:write`.

```bash
curl -X POST https://facilitator.example.com/api/admin/payments/pay_abc/refund \
  -H "Authorization: Bearer $X402_ADMIN_TOKEN"
```

409 if the payment isn't refundable. 502 if the on-chain refund fails (the row is still marked `refund_failed` so it's visible in subsequent list calls).

#### `POST /api/admin/payments/:paymentId/sync`

Reconcile one payment against Fireblocks. Reads the persisted `fireblocksTxId`, asks Fireblocks for the tx's current state, and transitions the row: `completed` with `transactionHash`/`blockNumber` on COMPLETED, `failed` on FAILED/CANCELLED/BLOCKED/REJECTED, no-op while in-flight. Also works on `failed` rows with a `fireblocksTxId` — lifts them back to `completed` when the chain agrees (re-opening refund). Scope: `payments:write`.

```bash
curl -X POST https://facilitator.example.com/api/admin/payments/pay_abc/sync \
  -H "Authorization: Bearer $X402_ADMIN_TOKEN"
```

#### `POST /api/admin/payments/sync-all`

Run the same reconcile pass across every `settling` row in the caller's scope. Returns a summary counting outcomes. Scope: `payments:write`.

```bash
curl -X POST https://facilitator.example.com/api/admin/payments/sync-all \
  -H "Authorization: Bearer $X402_ADMIN_TOKEN"
# { "scanned": 4, "completed": 2, "failed": 1, "inFlight": 1, "skipped": 0 }
```

The same pass fires at boot for every configuration (processing-role only). Opt out with `X402_RECONCILE_ON_BOOT=false` if you run many processing instances against a shared store.

#### `POST /api/admin/payments/sweep-expired`

Bulk-expire every pending payment whose `expiresAt` is in the past. Idempotent per row — safe to run on a schedule. Scope: `payments:write`.

```bash
curl -X POST https://facilitator.example.com/api/admin/payments/sweep-expired \
  -H "Authorization: Bearer $X402_ADMIN_TOKEN"
# { "expired": 7 }
```

Statuses: `pending → verified → settling → completed`, plus `settled`, `refunding`, `refunded`, `refund_failed`, `expired`, `failed`.

**Reconciler-ownership invariant:** once a `fireblocksTxId` is attached to a row, the settle route never preempts it into `failed` on transient errors — Fireblocks's own truth (via the reconciler) decides terminality. Rows without a `fireblocksTxId` still follow the normal settle path.

---

## Payment processing API

These are the endpoints your **client / agent** hits once you've given it an API key. Authenticated with the key you issued via `/api/admin/tokens`.

### `GET /api/payments/supported` (public)

What schemes, networks, and extensions this facilitator accepts. Used for discovery.

### `POST /api/payments/create`

Return a 402 `PaymentRequired` payload for a product, without actually being gated behind a 402 flow. Useful for clients that want the quote before making the real request.

```bash
curl -X POST \
    -H "Authorization: Bearer $MACHINE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"product_id":"prod_7Lm3nOp"}' \
    http://localhost:3000/api/payments/create
```

### `POST /api/payments/verify`

Verify an EIP-712 signature off-chain without settling. The client sends the `paymentPayload` (signature + authorization) and the `paymentRequirements` it's trying to satisfy. Response: `{isValid, payer, invalidReason?}`.

### `POST /api/payments/settle`

Verify and then settle on-chain. Returns the transaction hash on success.

---

## Payment Instruction Integrity

Optional. When enabled on a configuration, the facilitator signs every `/api/payments/create` response with an ES256 keypair and attaches the envelope two ways:

1. As an `integrity` top-level field on the JSON body
2. As an `X-402-Integrity` response header (mirrored by `@x402/express`)

Wallets that implement the [PII extension](https://x402.org) fetch the `did:web` document referenced by the envelope, verify the signature, and refuse to sign any payment whose body was altered between the facilitator and the wallet.

### What the facilitator signs

The envelope covers a payment-critical slice of the 402 body — specifically `{x402Version, accepts}` — plus the envelope's own `iat` and `exp`. `resource.url`, `error`, and `extensions` are intentionally excluded because the merchant SDK rewrites `resource.url` to its own public origin before emitting the 402; signing it would invalidate every response. The payment data the wallet actually commits to (amount, asset, payTo, network, scheme, all in `accepts[]`) *is* signed.

Canonical bytes:

```
SHA-256( JCS({x402Version, accepts}) || "\n" || iat || "\n" || exp )
```

JCS is RFC 8785 JSON Canonicalization. The draft spec's single-accept `\n`-joined field list is a strict subset of this when `accepts[]` has length 1.

### Envelope shape (base64url JSON)

```json
{
  "v": 1,
  "did": "did:web:api.example.com",
  "kid": "key-1",
  "alg": "ES256",
  "iat": 1776521334,
  "exp": 1776521634,
  "sig": "<base64url P1363 signature>"
}
```

### Enabling it

`npm run setup` scaffolds `./secrets/integrity-p256.pem` (P-256 keypair) for you. Flip on the config per configuration:

```jsonc
{
  "configuration_id": "default",
  "public_host": "http://localhost:3000",
  // …
  "integrity": {
    "enabled": true,
    "private_key_path": "./secrets/integrity-p256.pem",
    "did": "did:web:localhost%3A3000",
    "kid": "key-1",
    "alg": "ES256",
    "ttl_seconds": 300,
    "serve_did_document": true
  }
}
```

### `GET /.well-known/did.json`

Public route. When `integrity.serve_did_document: true`, the facilitator serves the DID document (assembled from the configured public key) at `/.well-known/did.json`. The configuration is resolved by Host-header match against `public_host`; misses fall back to the default configuration.

If you'd rather host the did.json yourself (e.g. your facilitator isn't at the domain your `did:web:` encodes), leave `serve_did_document: false` and publish the public key at whatever URL `did:web:<domain>` resolves to. The facilitator then only *signs*; you serve the key.

### Wallet-side verification

The test client has a `VERIFY_INTEGRITY=true` flag that:

1. Decodes the `integrity` envelope
2. Checks `iat`/`exp`
3. Resolves `did:web:<domain>` → `https://<domain>/.well-known/did.json`
4. Picks the key whose id matches `kid`
5. Reconstructs the canonical bytes and verifies the ES256 signature
6. Aborts the flow if the signature doesn't verify

```bash
VERIFY_INTEGRITY=true MECHANISM=eip3009 CHAIN=11155111 npm run dev
```

Add `REQUIRE_INTEGRITY=true` to also reject quotes that don't carry an envelope at all.

### Scope

- ✅ Signs — `{x402Version, accepts, iat, exp}`
- ❌ Doesn't sign — `resource.url`, `error`, `extensions` (mutable by merchant SDK)
- ✅ Supported algorithm — `ES256` (P-256)
- ❌ Not yet — `ES256K`, `EdDSA`, `did:webvh`, multiple keys per DID, on-chain registry binding

The spec is a [draft](https://x402.org); the envelope format follows it but the V2 multi-accept canonical form is a documented extension.

---

## CLI reference

Two surfaces, clean split:

1. **`x402`** — remote HTTP client for `/api/admin/*`. Pure API client, safe to run from anywhere with `X402_ADMIN_TOKEN`. Targets `X402_URL` (default `http://localhost:3000`).
2. **`npm run setup*`** — local bootstrap scripts. Touch the filesystem (scaffold config, mint JWTs from the on-disk secret, import a legacy SQLite DB). Must run on the same host as the server.

### Remote CLI (`x402`)

Install once per developer:

```bash
npm run build && npm link       # puts `x402` on your PATH
```

Every command that operates on a configuration takes `-c, --configuration <id>` (or env `CONFIGURATION=<id>`); omitted → server default.

```bash
# config (read-only)
x402 config show
x402 config validate
x402 config configurations

# Fireblocks (read-only + operational test)
x402 fireblocks show
x402 fireblocks test [--chain-id 8453] [--create-missing]

# API keys
x402 keys list [--json]
x402 keys create --scopes process-payments [--label agent]
x402 keys revoke <keyId>

# Assets — read + Fireblocks-hydrated import/sync
x402 assets list [--json]
x402 assets show <assetId>
x402 assets import <assetId> \
    --transfer-mechanism eip-3009 \
    --eip712-name "<domain name>" --eip712-version <n> \
    [--stable] [--price-symbol <coingecko-id>] [--force]
x402 assets sync [--apply]           # diff against Fireblocks
x402 assets remove <assetId>

# Products
x402 products list [--json]
x402 products show <productId>
#   USD-priced, single asset:
x402 products add --name Premium --endpoint /premium --asset USDC_BASE --usd-price 0.10
#   USD-priced, multi-asset (facilitator picks based on client balance):
x402 products add --name Premium --endpoint /premium --usd-price 0.10 \
                  --asset USDC_BASE --asset ETH_BASE
#   Native base units (legacy shorthand):
x402 products add --name Premium --endpoint /premium --asset USDC_BASE --price 100000
x402 products remove <productId>

# Payments — read (payments:read)
x402 payments list [--status failed] [--limit 20] [--json]
x402 payments get <paymentId>

# Payments — state changes (payments:write)
x402 payments mark-failed <paymentId> --reason "..."   # no on-chain action
x402 payments refund <paymentId>                       # Fireblocks CONTRACT_CALL
x402 payments sync <paymentId>                         # reconcile one row against Fireblocks
x402 payments sync-all                                 # reconcile every settling row in scope
x402 payments sweep-expired                            # bulk-expire past pending rows
```

Every command accepts `--url <base>` and `--token <jwt>` to override the env defaults.

### Local setup scripts

These run through `npm run`. They never hit HTTP.

```bash
npm run setup                      # scaffold config/facilitator.json + secrets/jwt-hs256.key
npm run setup -- --force           # rotate both (destructive)

npm run setup:admin-token -- --preset full         # admin:read admin:write payments:read payments:write
npm run setup:admin-token -- --preset readonly     # admin:read + payments:read
npm run setup:admin-token -- --preset payments-ops
npm run setup:admin-token -- --preset wildcard
npm run setup:admin-token -- --scopes "payments:read admin:read" --ttl 30m   # raw

npm run setup:migrate -- --db ./data/legacy.db [--force]
```

All config edits go through atomic tmpfile + rename, so it's safe to run `x402 products add` while the server is running (nodemon will reload).

### End-to-end test harness

```bash
npm run e2e
```

Assumes the facilitator, example merchant, and EOA are already set up (Fireblocks creds, TAP rule, `PRIVATE_KEY`, EOA funded). Fires each configured transfer mechanism (`eip-3009`, `permit2`, `erc7710`) in sequence against the test client, polls the admin API until each payment row reaches `completed`, and prints a ✅/❌ summary with block explorer links. Exits `0` iff every mechanism passed.

Idempotent — safe to re-run; converges config (imports missing assets, mints a merchant key if none exists) before firing. See `scripts/e2e.ts`.

---

## Running in production

Environment variables (all optional):

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Server listen port |
| `CONFIG_PATH` | `./config/facilitator.json` | Where to load config |
| `PAYMENT_STORE` | `sqlite` | `memory` \| `sqlite` \| `postgres` |
| `DB_PATH` | `./data/facilitator.db` | sqlite only |
| `POSTGRES_URL` | — | required if `PAYMENT_STORE=postgres` |
| `ALLOWED_ORIGINS` | `http://localhost:$PORT` | comma-separated CORS allowlist |
| `X402_ADMIN_JWT_SECRET` | — | Inline HS256 secret; takes precedence over the file-based default |
| `X402_ADMIN_JWT_SECRET_FILE` | `./secrets/jwt-hs256.key` | File-based HS256 secret; scaffolded by `npm run setup` |
| `X402_ADMIN_JWT_JWKS_URL` | — | JWKS endpoint for production (RS256/ES256); overrides HS256 when set |
| `X402_ADMIN_JWT_ISSUER`   | — | Optional `iss` claim to require on every admin JWT |
| `X402_ADMIN_JWT_AUDIENCE` | — | Optional `aud` claim to require on every admin JWT |
| `X402_URL` | `http://localhost:3000` | Read by the `x402` CLI |
| `X402_ADMIN_TOKEN` | — | Bearer JWT for the `x402` CLI |
| `X402_ALLOW_MAINNET` | — | Must be `true` to register or run with mainnet assets. Default-deny: boot and asset-import both refuse mainnet when unset. |
| `X402_RECONCILE_ON_BOOT` | `true` | Run the reconcile pass across every `settling` row on processing-role boot. Set `false` when running many instances against a shared store so only one leads reconcile. |
| `COINGECKO_API_KEY` | — | Optional; enables CoinGecko Pro. Free tier works unauthenticated. |
| `NODE_ENV` | `development` | Standard Node env |

Fireblocks credentials do **not** live in env vars — they're in `config/facilitator.json`.

### Network policy (mainnet vs testnet)

The facilitator tracks every asset's network via an `is_testnet` field (populated at import time from Fireblocks' `blockchain.onchain.test`). By default, **mainnet is denied**:

- **Boot** — server refuses to start if any configured asset has `is_testnet: false` and `X402_ALLOW_MAINNET !== true`. The error lists the offending `(asset_id, chain_id)` pairs.
- **Import** — `POST /api/admin/assets` (and `x402 assets import`) returns **403** when the hydrated asset is mainnet and the flag is off.

To opt in:
```bash
X402_ALLOW_MAINNET=true npm start
```
The server banner prints `network policy: mainnet OK (X402_ALLOW_MAINNET=true)` or `testnet-only (default)` at startup so there's no ambiguity.

Build + run compiled:

```bash
npm run build
NODE_ENV=production \
X402_ROLE=processing \                         # or 'management' for a second instance
X402_ADMIN_JWT_JWKS_URL=https://auth.yourco.example.com/.well-known/jwks.json \
PAYMENT_STORE=postgres \
POSTGRES_URL=postgres://<USER>:<PASSWORD>@host:5432/x402 \
npm start
```

For management in production, point `X402_ADMIN_JWT_JWKS_URL` at your JWT issuer's public keys. HS256 (shared secret via `X402_ADMIN_JWT_SECRET`) works but asymmetric / JWKS is the right choice at scale. Without either, the admin API rejects everything.

### Settle-first vs optimistic — on the merchant side

The merchant's middleware controls the order:

- **optimistic** — serve the response first, `/api/payments/settle` in the background. Simpler, preferred when the resource is idempotent/cheap.
- **settle-first** — `/api/payments/settle` synchronously before serving. Safer for one-shot, expensive deliveries where you can't refund.

The facilitator's `/api/payments/settle` is a single atomic operation; the choice of when to call it is a middleware concern, not a facilitator one.

---

## Multiple merchants on one facilitator

Payment-service providers who operate the facilitator on behalf of many merchants use one configuration per merchant:

```jsonc
{
  "tenant_id": "acme-payments-provider",
  "default_configuration_id": "merchant-a",
  "configurations": [
    {
      "configuration_id": "merchant-a",
      "public_host": "https://pay.merchant-a.com",
      "fireblocks": { ..."merchant A's vault"... },
      "assets": [ ... ],
      "products": [ ... ],
      "api_keys": [ ... ]
    },
    {
      "configuration_id": "merchant-b",
      "public_host": "https://pay.merchant-b.com",
      "fireblocks": { ..."merchant B's vault"... },
      "assets": [ ... ],
      "products": [ ... ],
      "api_keys": [ ... ]
    }
  ]
}
```

Requests are routed to the right configuration by matching the request's `Host` header against each configuration's `public_host`. API keys are **bound** to the configuration they were issued under — a key from `merchant-a` cannot settle payments for `merchant-b`.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Disclaimer

This software handles on-chain value transfer. Before integrating, please read the full [DISCLAIMER](./DISCLAIMER.md) — it covers irreversibility of on-chain transfers, the absence of a third-party security audit, third-party contract risk (Permit2, MetaMask Delegation Framework, ERC-20 token contracts including USDC / USDT blacklisting mechanics), the non-advisory nature of this code, jurisdictional and data-protection considerations (GDPR / UK GDPR), the Fireblocks trademark, the absence of any fiduciary or custodial relationship, and the independence of the x402 protocol specification.
