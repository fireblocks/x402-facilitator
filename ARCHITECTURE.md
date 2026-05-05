# x402 Facilitator

## Overview

HTTP 402 payment facilitator — API-only. Merchants run their own servers and call `/api/payments/{create,verify,settle}` at two decision points; the facilitator verifies EIP-712 signatures and submits on-chain settlements via Fireblocks. No reverse proxy. No merchant traffic through this service.

Configuration lives in `config/facilitator.json` — a static file loaded + validated at boot (edits require a restart). One file holds **one tenant** and **one or more configurations**; each configuration is the isolation unit (its own Fireblocks credentials, API keys, products). Assets are a global catalog at the top level.

Two auth surfaces: **opaque API keys** for the payment processing API (machine credentials), and **JWT** for the management API (HS256 locally via a file-based secret, JWKS for production).

## Repo layout

```
/                           (this repo root — the facilitator)
├── src/                    server, CLI, repositories, mechanisms
├── config/                 facilitator.json (gitignored contents)
├── data/                   sqlite payment store (gitignored)
├── examples/
│   └── merchant/           demo upstream server used by dev:with-example
├── docs/
├── package.json
├── tsconfig.json
└── ARCHITECTURE.md         this file
```

## Technology Stack

- **Language**: TypeScript (strict)
- **Framework**: Express.js
- **Config**: JSON + zod validation
- **Blockchain**: ethers.js v6 (EIP-712, ABI encoding) + Fireblocks SDK `CONTRACT_CALL` for settlement
- **Payment storage**: pluggable via `PAYMENT_STORE` env var:
  - `memory` — in-memory (tests / ephemeral dev)
  - `sqlite` (default) — better-sqlite3 at `DB_PATH` (default `./data/facilitator.db`)
  - `postgres` — Kysely + `pg`, connection via `POSTGRES_URL`

## Routing

The server is a single process that splits traffic by **path prefix**:

| Path | Auth | Handler |
|------|------|---------|
| `/api/health` | public | Health check |
| `/api/discovery/*` | public | Discovery API |
| `/api/admin/facilitator` | JWT, scope `admin:read` | Config view |
| `/api/admin/assets`, `/api/admin/products`, `/api/admin/tokens` | JWT, scope `admin:read` (GET) or `admin:write` (POST/DELETE) | Config CRUD |
| `/api/admin/fireblocks`, `/api/admin/fireblocks/test` | JWT, `admin:read` / `admin:write` | Fireblocks config view + operational test |
| `/api/admin/payments`, `/api/admin/payments/:id` | JWT, `payments:read` | Read payments |
| `/api/admin/payments/:id/mark-failed`, `/api/admin/payments/:id/refund`, `/api/admin/payments/:id/sync`, `/api/admin/payments/sync-all`, `/api/admin/payments/sweep-expired` | JWT, `payments:write` | Operator state changes (mark-failed, Fireblocks refund, per-row sync, bulk sync, bulk expire) |
| `/api/payments/supported` | public | Schemes/networks advertised |
| `/api/payments/{create,verify,settle}` | API token, scope `process-payments` | Payment processing |

Anything not listed 404s. There is no reverse proxy; merchant traffic never touches the facilitator.

### Payment Instruction Integrity (optional)

When a configuration has `integrity.enabled: true` + a P-256 private key at `integrity.private_key_path`, the facilitator signs every `/api/payments/create` response. The signed envelope covers `{x402Version, accepts}` + `iat` + `exp` (canonical: `SHA256(JCS(slice) || \n || iat || \n || exp)`), lives as `body.integrity` and is mirrored by the merchant SDK onto the `X-402-Integrity` response header. Wallets verify against the `did:web` identified by the envelope.

`resource.url`, `error`, and `extensions` are deliberately excluded from the signed payload because the merchant SDK augments them (resource.url is rewritten to the merchant's origin). Payment-critical fields (amount, asset, payTo, network, scheme) all live inside `accepts[]` and are signed.

When `integrity.serve_did_document: true`, the facilitator serves the DID document at `GET /.well-known/did.json` (Host-resolved). Otherwise the operator self-hosts at whatever domain the `did:web:…` encodes. Signer lives in `src/services/integrity/IntegritySigner.ts`; route in `src/routes/wellKnown.ts`; envelope assembled in `src/routes/payments.ts` on `/create`.

### Network policy

Every asset carries `is_testnet: boolean` (populated at import from Fireblocks' `blockchain.onchain.test`). Mainnet is default-deny — the server refuses to boot and `POST /api/admin/assets` refuses to register a mainnet asset unless `X402_ALLOW_MAINNET=true` is in the env. Enforcement lives in `src/config/networkPolicy.ts` and is called from `src/index.ts` (boot) + `src/routes/adminAssets.ts` (import). The boot banner prints the active policy.

## Auth model (multi-tenant ready)

Two independent auth paths, two `Principal` shapes, one uniform
authorization check.

- **Management API (`/api/admin/*`)** — JWT-only. The `JwtUserAuthenticator`
  verifies the bearer and attaches `UserPrincipal { tenantId, userId,
  email, scopes, configurationIds }`. Each admin route declares the
  specific scope it requires — one of `admin:read`, `admin:write`,
  `payments:read`, `payments:write`. `*` is a wildcard that passes any
  check. Signing key resolution: `X402_ADMIN_JWT_SECRET` env →
  `X402_ADMIN_JWT_SECRET_FILE` env → `./secrets/jwt-hs256.key` (scaffolded
  by `npm run setup`). JWKS (production): `X402_ADMIN_JWT_JWKS_URL`.
- **Payment API (`/api/payments/*`)** — `ApiTokenRepository.verify()`
  checks the opaque bearer and attaches `ApiTokenPrincipal { tenantId,
  configurationId, keyId, scopes }`. API keys are machine credentials
  scoped to `process-payments`; they are **never** admins (no magic
  scope). Issued via `x402 keys create` or `POST /api/admin/tokens`.

`TenantScope { tenantId, configurationId }` is threaded through every
repository call. In single-tenant deployments there is one scope
(`DEFAULT_SCOPE`); in a hosted multi-tenant deployment the
`ConfigurationResolver` maps Host header → scope and repositories
filter on scope columns.

## Config file shape

The file holds **one tenant** and **one or more configurations**. Each
configuration is the isolation unit — its own Fireblocks credentials,
API keys, assets, products. Most deployments have one; a payments-
service hosting the facilitator for many merchants declares each as
its own configuration.

```jsonc
{
  "tenant_id": "default",
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
    }
  ],
  "configurations": [
    {
      "configuration_id": "default",
      "public_host": "http://localhost:3000",
      "fireblocks": {
        "api_key": "...",
        "api_secret_path": "./secrets/fireblocks.pem",
        "receiver_vault": "0",
        "base_url": "https://api.fireblocks.io",
        "deposit_address_cache": { "USDC_BASE": "0x…" }
      },
      "api_keys": [
        { "key_id": "ak_...", "hash": "sha256:...", "scopes": ["process-payments"], "label": "agent" }
      ],
      "products": [
        {
          "product_id": "prod_...",
          "name": "Gold",
          "endpoint": "/get-gold",
          "scheme": "exact",
          "usd_price": 0.10,
          "pricing": [{ "asset_id": "USDC_BASE", "amount": null }],
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

### Configuration resolution

- **Proxy traffic** (non-`/api/*` paths) resolves scope by matching the
  request's `Host` header against each configuration's `public_host`.
  No match → falls back to `default_configuration_id`.
- **Management API** (`/api/admin/*`) accepts `X-Configuration-ID`
  header or `?configuration=…` query param; otherwise uses the default.
  The authenticated `UserPrincipal` must have access to the chosen
  configuration (via its `configurationIds`).
- **Payment processing** (`/api/payments/*`) always uses the
  configuration the bearer API token was issued under. Clients cannot
  override.

### Assets are Fireblocks-native

There is **no tokens or blockchains registry**. Each `asset_id` is the Fireblocks asset identifier (e.g. `USDC_BASE`, `ETH_BASE`). The x402-specific metadata we need (EIP-712 domain, transfer mechanism, contract address) lives inline on the asset.

## Transfer mechanisms

Each asset declares a `transfer_mechanism`. The mechanism controls how signatures are validated and how settlement is executed on-chain:

| Mechanism | Description |
|-----------|-------------|
| `eip-3009` | `transferWithAuthorization()` — single-tx, for tokens that support it natively (USDC) |
| `permit2` | Uniswap Permit2 via `x402ExactPermit2Proxy` — universal ERC-20 fallback |
| `upto-permit2` | Permit2 with variable charge amount (scheme `upto`) |
| `erc7710` | MDF `DelegationManager.redeemDelegations()` — smart-account delegation (plain EOAs can play via EIP-7702 self-upgrade to `EIP7702StatelessDeleGator`) |

The asset's `transfer_mechanism` is the **default**. A product's pricing row can override it with its own `transfer_mechanism` field, so one asset can be offered under multiple mechanisms at once (the 402 emits one `accepts[]` entry per row). The server enforces this on `/verify` + `/settle`: it resolves the payload's mechanism (by shape — `permit2Authorization` / `delegation` / else asset default) and checks the product's pricing[] actually has a row for `(asset_id, resolved mechanism)`; if not, it returns `400 unsupported_scheme`. Requests missing `extra.productId` (i.e. not originated via `/api/payments/create`) are rejected.

## Authentication

- `Authorization: Bearer <token>` on every `/api/*` call except health/discovery.
- **Management** (`/api/admin/*`): JWT (HS256 local, JWKS prod). Each admin
  route declares one required scope — `admin:read`, `admin:write`,
  `payments:read`, or `payments:write`. `*` is a wildcard. Mint dev tokens
  via `npm run setup:admin-token -- --preset <name>`.
- **Payment processing** (`/api/payments/*`): opaque API keys generated
  via `x402 keys create`. Plaintext shown once, only SHA-256 hashes
  stored in config. Scope `process-payments` gates `/create|/verify|/settle`.

## Build & Dev Commands

```bash
npm install                  # once
npm run dev                  # facilitator only (port 3000)
npm run dev:with-example     # facilitator + examples/merchant upstream (port 3010)
npm run typecheck            # tsc --noEmit
npm run build                # compile to dist/
npm start                    # run compiled server
```

The merchant under `examples/merchant/` is opt-in; not started by the default dev script.

## CLI — two surfaces

1. **`x402`** — remote HTTP client for `/api/admin/*`. Authenticated with
   a JWT (env `X402_ADMIN_TOKEN`); targets `X402_URL`. Every command that
   operates on a configuration accepts `-c, --configuration <id>` (sent
   as `X-Configuration-ID`); omitted → server default. Install via
   `npm run build && npm link`.

2. **`npm run setup*`** — local bootstrap. Touches the filesystem, never
   HTTP. Must run on the same host as the server (needs `./secrets/`
   access for JWT minting).

```bash
# ── Local bootstrap (run on the server host) ─────────────────────────
npm run setup                                  # scaffold config + jwt-hs256.key
npm run setup -- --force                       # rotate both
npm run setup:admin-token -- --preset full           # mint admin JWT (readonly|payments-ops|full|wildcard)
npm run setup:admin-token -- --scopes "payments:read admin:read" --ttl 30m
npm run setup:migrate -- --db ./data/old.db    # one-shot legacy-sqlite import
npm run e2e                                     # run all 3 mechanisms against live merchant; assert `completed`

# ── Remote CLI ───────────────────────────────────────────────────────
export X402_ADMIN_TOKEN=<jwt from setup:admin-token>

x402 config show
x402 config configurations
x402 fireblocks show
x402 fireblocks test [--create-missing] [--chain-id 8453]
x402 keys list ; x402 keys create --scopes process-payments --label agent ; x402 keys revoke <id>
x402 assets list ; x402 assets import USDC_BASE --transfer-mechanism eip-3009 --eip712-name "USDC" --eip712-version 2 --stable
x402 assets sync [--apply] ; x402 assets remove <id>
x402 products list ; x402 products add --name Gold --endpoint /gold --asset USDC_BASE --usd-price 0.10 ; x402 products remove <id>
x402 payments list [--status failed] [--limit 20] [--json] ; x402 payments get <id>
x402 payments mark-failed <id> --reason "…" ; x402 payments refund <id> ; x402 payments sync <id> ; x402 payments sync-all ; x402 payments sweep-expired
```

All admin routes go through `ConfigFile` (atomic tmpfile + rename) so
mutations are safe against concurrent reads.

## Payment lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Payment row created, awaiting signature |
| `verified` | Off-chain signature validated |
| `settling` | On-chain tx submitted, awaiting Fireblocks confirmation |
| `settled` | On-chain confirmed (settle-first flow only, before upstream call) |
| `completed` | Terminal — upstream delivered + on-chain settled |
| `refunding` | Refund tx submitted (settle-first after upstream failure) |
| `refunded` | Terminal — funds returned |
| `refund_failed` | Refund tx failed — manual intervention |
| `expired` | Terminal — past expiration window |
| `failed` | Terminal — any error |

### Settlement strategies

`SettlementStrategyFn` is a pure function of `SettlementContext` that picks `optimistic` (proxy first, settle after) or `settle-first` (settle first, refund if upstream fails). Default: always `optimistic`. Replace at wire-up time in `src/index.ts`.

### Reconciliation

Every settlement persists the Fireblocks-internal tx id (`fireblocksTxId`) on the payment row the moment Fireblocks accepts the `createTransaction` — before the poll loop starts. If the process dies mid-poll, the row stays `settling` but retains the handle.

`PaymentReconciler` (`src/services/reconciliation/PaymentReconciler.ts`) drives the row to its real state by asking Fireblocks what the tx resolved to. Mechanism-agnostic — all four mechanisms settle via Fireblocks `CONTRACT_CALL`, so one reconciler covers all of them. Two entry points:

- **Boot** — `src/index.ts` runs `reconcileOpen` per configuration on processing-role startup, scanning every `settling` row for that scope. Set `X402_RECONCILE_ON_BOOT=false` to opt out (useful when running many processing instances against the same store — only one should lead the reconcile pass).
- **Admin, one row** — `POST /api/admin/payments/:id/sync` (CLI `x402 payments sync <id>`).
- **Admin, bulk** — `POST /api/admin/payments/sync-all` (CLI `x402 payments sync-all`) reconciles every `settling` row in the caller's scope and returns the `ReconcileSummary`.

**Invariant: rows with a `fireblocksTxId` are reconciler-owned.** The settle route (`src/routes/payments.ts`) will not preempt a row into `failed` status if a `fireblocksTxId` is already attached — the underlying tx may still land, so the row stays `settling` and the reconciler decides terminality from Fireblocks's own truth. Reconciliation also applies to `failed` rows with a `fireblocksTxId` (legacy rows from before this invariant), which can be lifted back to `completed` when Fireblocks reports the tx as COMPLETED — re-opening the refund path. `completed`, `refunded`, and `refund_failed` are merchant-managed terminal states and are never touched by the reconciler.

## Environment variables

```bash
PORT=3000                            # server port
CONFIG_PATH=./config/facilitator.json
PAYMENT_STORE=sqlite                 # memory | sqlite | postgres
DB_PATH=./data/facilitator.db        # sqlite only
POSTGRES_URL=postgres://...          # postgres only
ALLOWED_ORIGINS=http://localhost:3000
NODE_ENV=development
X402_RECONCILE_ON_BOOT=true          # set to false to skip the boot-time reconcile pass
```

Fireblocks credentials live in the config file, not in env vars.

## Source layout

```
src/
  index.ts                         # Express app + wiring
  core/
    tenantScope.ts                 # TenantScope + DEFAULT_SCOPE
    configurationResolver.ts       # ConfigurationResolver + default impl
  auth/
    principals.ts                  # Principal union (User | ApiToken)
    userAuthenticator.ts           # UserAuthenticator iface + Dev/Deny stubs
  config/
    configSchema.ts                # zod schema for facilitator.json
    configFile.ts                  # load + validate + atomic write
  repositories/
    interfaces/                    # domain types + repo interfaces (scope-aware)
    json/                          # JSON-backed config repos + ApiTokenRepository
    payment/                       # InMemory / Sqlite / Sql (Kysely+pg)
  services/
    fireblocksSettlement.ts        # Fireblocks SDK CONTRACT_CALL wrapper
    fireblocksSettlementFactory.ts # per-(scope, chain) settlement service cache
    settlementStrategy.ts          # optimistic vs settle-first policy
  mechanisms/                      # TransferMechanism iface + four impls
  middleware/
    auth.ts                        # createUserAuth / createApiTokenAuth /
                                   # resolveScope / requireScope (API tokens)
                                   # / requireUserScope (admin JWT scopes)
  routes/
    facilitator.ts                 # /api/admin/facilitator
    assets.ts                      # /api/admin/assets
    products.ts                    # /api/admin/products
    adminTokens.ts                 # /api/admin/tokens (issue/list/revoke)
    adminPayments.ts               # /api/admin/payments — list/get (payments:read)
                                   # + mark-failed / refund / sync / sync-all / sweep-expired (payments:write)
    payments.ts                    # /api/payments/{supported,create,verify,settle}
    discovery.ts                   # /api/discovery/resources
  extensions/                      # x402 extensions (identifier, gas sponsoring)
  cli/                             # commander CLI (init/config/fireblocks/keys/...)
  types/entities.ts                # x402 protocol types only
  utils/randId.ts                  # Stripe-style prefixed IDs
```

## Development guidelines

- All code is TypeScript; `tsc --noEmit` must pass
- Repositories are the only allowed path to data; no raw DB/file access in routes or middleware
- Domain types live in `src/repositories/interfaces/` (camelCase); on-disk/SQL shapes live in adapters
- New settlement mechanisms: add a class + register it in `src/mechanisms/index.ts`
- Adding config fields: update `configSchema.ts` zod schema, the JSON repository `toDomain` mapping, and the interface in `repositories/interfaces/`
