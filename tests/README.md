# Tests

Unit + repository contract tests via Vitest. Fast, deterministic, no network.

```bash
npm test                  # one-shot
npm run test:watch        # watch mode
npm run test:coverage     # with v8 coverage report
```

## What's covered

| Suite | Scope |
|---|---|
| `tests/config/networkPolicy.test.ts` | Mainnet default-deny: `mainnetAllowed`, `findMainnetAssets`, `MainnetAssetForbiddenError` formatting. |
| `tests/utils/authorizationHash.test.ts` | Replay-protection hash: deterministic, property-order-insensitive (canonical JSON), changes on any signature / message edit. |
| `tests/mechanisms/eip3009.test.ts` | EIP-3009 `verify`: happy path, expired (`validBefore`), not-yet-valid (`validAfter`), amount mismatch, recipient mismatch, signature-from-wrong-key. |
| `tests/mechanisms/permit2.test.ts` | Permit2 `verify`: happy path, `permitted.token` mismatch, wrong spender, amount underpay, recipient mismatch, deadline expired, `validAfter` in future, signature-from-wrong-key. |
| `tests/mechanisms/erc7710.test.ts` | ERC-7710 `verify` + `settle`: rejects when no RPC provider configured (no silent optimistic-accept), rejects unknown `delegationManager` (allowlist), rejects missing-fields, `settle` refuses unknown manager. |
| `tests/repositories/paymentRepository.contract.test.ts` | Shared contract suite run against `InMemoryPaymentRepository` + `SqlitePaymentRepository`. Covers create/get round-trip (bigint string preservation), full state-machine, replay-protection (`isAuthorizationUsed`), scope isolation. |
| `tests/services/paymentReconciler.test.ts` | Reconciler state machine with mocked Fireblocks: `settling+COMPLETED → completed`, `settling+FAILED → failed`, `settling+in_flight → no-op`, legacy heal (`failed+fireblocksTxId+COMPLETED → completed`), skips rows without `fireblocksTxId`, never touches merchant-managed terminal states. |

## What's NOT covered here (by design)

- **Full HTTP integration tests** (supertest against the whole Express app) — heavier setup; lives outside this suite.
- **Postgres adapter** — requires a live database; covered by `scripts/e2e.ts` end-to-end run.
- **Real Fireblocks integration** — covered by `npm run e2e` (live network, needs Sepolia funds + Fireblocks TAP rule).

## Adding a test

- Put the file under `tests/<area>/<thing>.test.ts`.
- Pure-function tests: no setup needed; just import + assert.
- For Fireblocks-dependent code: mock the SDK with `vi.fn()` and stub `FireblocksSettlementService.getTransactionOutcome` / `contractCall` as needed. Never hit the network from a unit test.
- For repository tests: add the adapter to the `adapters` array in `paymentRepository.contract.test.ts` — the same suite runs against every adapter.
