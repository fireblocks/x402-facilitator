#!/usr/bin/env node
/**
 * End-to-end test harness.
 *
 * Assumes the facilitator (:3000) and the example merchant (:3010) are
 * already running, and that the operator has:
 *   - Ran `npm run setup` (scaffolds config + JWT secret).
 *   - Filled in Fireblocks creds in config/facilitator.json.
 *   - Added a Fireblocks TAP rule auto-approving CONTRACT_CALL from the
 *     receiver_vault with ETH_TEST5 (Sepolia gas asset).
 *   - Funded the EOA (`PRIVATE_KEY`) with Sepolia ETH + USDC.
 *
 * Run:  npm run e2e
 *
 * The harness will:
 *   1. Preflight — config, JWT secret, servers reachable.
 *   2. Converge — ensure USDC asset is imported, ensure the Premium
 *      product has pricing rows for every mechanism under test, ensure
 *      a merchant API key exists.
 *   3. Snapshot payments list (paymentIds before).
 *   4. Run the test client for each mechanism (spawns a subprocess).
 *   5. Poll the admin API for the new payment row's terminal state.
 *   6. Print a ✅/❌ summary; exit 0 iff every mechanism completed.
 *
 * Idempotent — safe to re-run. Never drops or recreates config entries
 * that already exist.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Wallet } from 'ethers';
import { SignJWT } from 'jose';
import { resolveHs256Secret } from '../src/auth/jwtSecret';
import { getConfigFile } from '../src/config/configFile';

const MECHANISMS_TO_TEST = ['eip3009', 'permit2', 'erc7710'] as const;
type Mechanism = (typeof MECHANISMS_TO_TEST)[number];

// Map the client-side assetTransferMethod (no dashes) to the server-side
// transferMechanism (dashed). The payment store records the latter.
const CLIENT_TO_SERVER_MECH: Record<Mechanism, string> = {
  eip3009: 'eip-3009',
  permit2: 'permit2',
  erc7710: 'erc7710',
};

const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3000';
const MERCHANT_URL = process.env.MERCHANT_URL || 'http://localhost:3010';
const CHAIN = Number(process.env.CHAIN || 11155111); // ETH Sepolia
const EXPECTED_ASSET_ID = process.env.ASSET_ID || 'USDC_ETH_TEST5_0GER';
const MERCHANT_KEY_LABEL = 'e2e-merchant';
const POLL_INTERVAL_MS = 2000;
// Fireblocks queue + signing + broadcast time varies from ~60s on a
// quiet tenant to 5+ minutes when the workspace is backed up. 10 minutes
// covers worst-case sequential submission of 3 txs without false-failing
// a run that's still in flight.
const POLL_TIMEOUT_MS = 600_000;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function err(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function step(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`); }
function dim(msg: string) { console.log(`  ${DIM}${msg}${RESET}`); }
function die(msg: string): never { err(msg); process.exit(1); }

// ── HTTP helpers ────────────────────────────────────────────────────
async function httpJson<T>(
  method: string,
  url: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T | { error?: string } }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text && res.headers.get('content-type')?.includes('json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }
  }
  return { status: res.status, body: parsed as T };
}

interface PaymentRow {
  paymentId: string;
  status: string;
  transferMechanism: string;
  assetId: string;
  transactionHash: string | null;
  blockNumber: number | null;
  error: string | null;
  fromAddress: string | null;
  createdAt: string;
}

interface AssetRow {
  assetId: string;
  transferMechanism: string;
}
interface ProductPricingRow {
  assetId: string;
  amount: number | null;
  transferMechanism?: string;
}
interface ProductRow {
  productId: string;
  endpoint: string;
  pricing: ProductPricingRow[];
}
interface TokenRow {
  keyId: string;
  label: string | null;
  scopes: string[];
}
interface CreatedKey {
  token: string;
  keyId: string;
  label: string | null;
  scopes: string[];
}

// ── Admin JWT minter ────────────────────────────────────────────────
async function mintAdminJwt(): Promise<string> {
  const resolved = resolveHs256Secret();
  if (!resolved) {
    die('No HS256 secret found. Run `npm run setup` first.');
  }
  const tenantId = getConfigFile().get().tenant_id;
  const key = new TextEncoder().encode(resolved.secret);
  return await new SignJWT({
    tenant_id: tenantId,
    scope: '*',
    configuration_ids: '*',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('e2e-harness')
    .setIssuer('x402-dev')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(key);
}

// ── Preflight ───────────────────────────────────────────────────────
async function preflight(): Promise<string> {
  step('Preflight');
  // config
  const cfgPath = path.resolve('config/facilitator.json');
  if (!fs.existsSync(cfgPath)) die(`config/facilitator.json missing — run \`npm run setup\` first`);
  ok(`config present at ${cfgPath}`);

  const token = await mintAdminJwt();
  ok('admin JWT minted');

  const health = await httpJson<{ status: string }>(
    'GET',
    `${FACILITATOR_URL}/api/health`,
  );
  if (health.status !== 200) {
    die(`facilitator not reachable at ${FACILITATOR_URL}/api/health (got ${health.status}) — start with \`npm run dev\``);
  }
  ok(`facilitator up @ ${FACILITATOR_URL}`);

  const merchant = await httpJson<{ endpoints: Record<string, string> }>(
    'GET',
    `${MERCHANT_URL}/`,
  );
  if (merchant.status !== 200) {
    die(`merchant not reachable at ${MERCHANT_URL}/ (got ${merchant.status}) — start with \`cd examples/merchant && npm run dev\``);
  }
  ok(`merchant up @ ${MERCHANT_URL}`);

  if (!process.env.PRIVATE_KEY) {
    die('PRIVATE_KEY is not set — export the EOA payer key in your shell');
  }
  const wallet = new Wallet(process.env.PRIVATE_KEY);
  ok(`EOA payer: ${wallet.address}`);

  return token;
}

// ── Converge config ─────────────────────────────────────────────────
async function ensureAsset(token: string): Promise<void> {
  step('Ensure asset catalog');
  const list = await httpJson<AssetRow[]>('GET', `${FACILITATOR_URL}/api/admin/assets`, { token });
  if (list.status !== 200) die(`GET /assets → ${list.status}`);
  const rows = list.body as AssetRow[];
  if (rows.some((a) => a.assetId === EXPECTED_ASSET_ID)) {
    ok(`${EXPECTED_ASSET_ID} already in catalog`);
    return;
  }
  dim(`importing ${EXPECTED_ASSET_ID} from Fireblocks…`);
  const imp = await httpJson<unknown>('POST', `${FACILITATOR_URL}/api/admin/assets`, {
    token,
    body: {
      asset_id: EXPECTED_ASSET_ID,
      transfer_mechanism: 'eip-3009',
      eip712_name: 'USDC',
      eip712_version: '2',
      stable: true,
    },
  });
  if (imp.status !== 201) {
    die(`POST /assets → ${imp.status}: ${JSON.stringify(imp.body)}`);
  }
  ok(`imported ${EXPECTED_ASSET_ID}`);
}

async function ensurePremiumProduct(token: string): Promise<string> {
  step('Ensure Premium product has all mechanism rows');
  const [listProducts, listAssets] = await Promise.all([
    httpJson<ProductRow[]>('GET', `${FACILITATOR_URL}/api/admin/products`, { token }),
    httpJson<AssetRow[]>('GET', `${FACILITATOR_URL}/api/admin/assets`, { token }),
  ]);
  if (listProducts.status !== 200) die(`GET /products → ${listProducts.status}`);
  const products = listProducts.body as ProductRow[];
  const assetDefaults = new Map(
    (listAssets.body as AssetRow[]).map((a) => [a.assetId, a.transferMechanism]),
  );
  const existing = products.find((p) => p.endpoint === '/premium');

  const desiredPricing = MECHANISMS_TO_TEST.map((m) => ({
    asset_id: EXPECTED_ASSET_ID,
    amount: null,
    transfer_mechanism: CLIENT_TO_SERVER_MECH[m],
  }));

  if (existing) {
    // Can't update a product (no PATCH endpoint) — validate that every
    // mechanism we want to test is represented. A row that doesn't
    // specify `transferMechanism` inherits the asset's default, so we
    // resolve that before comparing.
    const effectiveKeys = new Set(
      existing.pricing.map((p) => {
        const mech = p.transferMechanism ?? assetDefaults.get(p.assetId) ?? '';
        return `${p.assetId}::${mech}`;
      }),
    );
    const missing = MECHANISMS_TO_TEST.filter(
      (m) => !effectiveKeys.has(`${EXPECTED_ASSET_ID}::${CLIENT_TO_SERVER_MECH[m]}`),
    );
    if (missing.length > 0) {
      die(
        `Premium product exists (${existing.productId}) but is missing pricing rows for: ${missing.join(', ')} on asset ${EXPECTED_ASSET_ID}. ` +
          `Edit config/facilitator.json to add them, or remove the product and re-run to let the harness create it fresh.`,
      );
    }
    ok(`product ${existing.productId} already covers all ${MECHANISMS_TO_TEST.length} mechanisms on ${EXPECTED_ASSET_ID}`);
    return existing.productId;
  }

  dim('creating Premium product…');
  const created = await httpJson<{ productId: string }>(
    'POST',
    `${FACILITATOR_URL}/api/admin/products`,
    {
      token,
      body: {
        name: 'Premium',
        endpoint: '/premium',
        scheme: 'exact',
        usd_price: 0.01,
        pricing: desiredPricing,
      },
    },
  );
  if (created.status !== 201) {
    die(`POST /products → ${created.status}: ${JSON.stringify(created.body)}`);
  }
  const productId = (created.body as { productId: string }).productId;
  ok(`created product ${productId}`);
  return productId;
}

async function ensureMerchantKey(token: string): Promise<{ keyId: string; plaintext: string | null }> {
  step('Ensure merchant API key');
  const list = await httpJson<TokenRow[]>('GET', `${FACILITATOR_URL}/api/admin/tokens`, { token });
  const existing = (list.body as TokenRow[]).find(
    (t) => t.label === MERCHANT_KEY_LABEL && t.scopes.includes('process-payments'),
  );
  if (existing) {
    ok(`key ${existing.keyId} (${MERCHANT_KEY_LABEL}) already exists — reusing`);
    return { keyId: existing.keyId, plaintext: null };
  }
  dim(`minting ${MERCHANT_KEY_LABEL}…`);
  const created = await httpJson<CreatedKey>(
    'POST',
    `${FACILITATOR_URL}/api/admin/tokens`,
    {
      token,
      body: { scopes: ['process-payments'], label: MERCHANT_KEY_LABEL },
    },
  );
  if (created.status !== 201) {
    die(`POST /tokens → ${created.status}: ${JSON.stringify(created.body)}`);
  }
  const cb = created.body as CreatedKey;
  ok(`minted ${cb.keyId}`);
  return { keyId: cb.keyId, plaintext: cb.token };
}

// ── Merchant config consistency check ───────────────────────────────
async function verifyMerchantBoundProduct(productId: string): Promise<void> {
  step('Verify merchant is bound to the expected product');
  const res = await httpJson<{ endpoints?: Record<string, string> }>(
    'GET',
    `${MERCHANT_URL}/`,
  );
  const endpoints = (res.body as { endpoints?: Record<string, string> }).endpoints ?? {};
  const premium = endpoints['/premium'] ?? '';
  if (!premium.includes(productId)) {
    die(
      `Merchant reports /premium bound to '${premium}', but the harness expected product ${productId}. ` +
        `Update examples/merchant/.env PREMIUM_PRODUCT_ID and restart the merchant.`,
    );
  }
  ok(`merchant /premium → ${productId}`);
}

// ── Run the test client as a subprocess ────────────────────────────
function runTestClient(mechanism: Mechanism): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['ts-node', 'src/index.ts'],
      {
        cwd: path.resolve('examples/test-client'),
        env: {
          ...process.env,
          MECHANISM: mechanism,
          CHAIN: String(CHAIN),
          AUTO_APPROVE: 'true', // safe — idempotent in the client
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const out: string[] = [];
    child.stdout.on('data', (b: Buffer) => {
      const s = b.toString();
      out.push(s);
      process.stdout.write(`  │ ${s.replace(/\n(?!$)/g, '\n  │ ')}`);
    });
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      process.stderr.write(`  │ ${s.replace(/\n(?!$)/g, '\n  │ ')}`);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`test client exited with code ${code}`));
    });
  });
}

// ── Poll until terminal ─────────────────────────────────────────────
async function pollPayment(token: string, paymentId: string): Promise<PaymentRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const terminal = new Set(['completed', 'settled', 'failed', 'refunded', 'refund_failed', 'expired']);
  while (Date.now() < deadline) {
    const res = await httpJson<PaymentRow>(
      'GET',
      `${FACILITATOR_URL}/api/admin/payments/${encodeURIComponent(paymentId)}`,
      { token },
    );
    if (res.status === 200) {
      const row = res.body as PaymentRow;
      if (terminal.has(row.status)) return row;
      dim(`  polling ${paymentId}… status=${row.status}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${paymentId} to reach a terminal state`);
}

// ── Main ────────────────────────────────────────────────────────────
interface MechanismResult {
  mechanism: Mechanism;
  success: boolean;
  paymentId?: string;
  txHash?: string | null;
  blockNumber?: number | null;
  reason?: string;
}

async function main() {
  console.log(`${BOLD}x402 end-to-end harness${RESET}`);
  console.log(`facilitator: ${FACILITATOR_URL}`);
  console.log(`merchant:    ${MERCHANT_URL}`);
  console.log(`chain:       ${CHAIN}`);
  console.log(`asset:       ${EXPECTED_ASSET_ID}`);

  const token = await preflight();
  await ensureAsset(token);
  const productId = await ensurePremiumProduct(token);
  const merchantKey = await ensureMerchantKey(token);
  if (merchantKey.plaintext) {
    warn('A fresh merchant API key was minted. The merchant must be restarted with this value in');
    warn(`  examples/merchant/.env  FACILITATOR_API_KEY=${merchantKey.plaintext}`);
    warn(`  examples/merchant/.env  PREMIUM_PRODUCT_ID=${productId}`);
    die('After updating + restarting the merchant, re-run the harness.');
  }
  await verifyMerchantBoundProduct(productId);

  step('Snapshot existing payments');
  const before = await httpJson<PaymentRow[]>(
    'GET',
    `${FACILITATOR_URL}/api/admin/payments?limit=500`,
    { token },
  );
  const beforeIds = new Set((before.body as PaymentRow[]).map((p) => p.paymentId));
  ok(`${beforeIds.size} row(s) pre-existing`);

  const results: MechanismResult[] = [];
  for (const mech of MECHANISMS_TO_TEST) {
    step(`Run mechanism: ${mech}`);
    try {
      await runTestClient(mech);
    } catch (e) {
      err(`test client failed: ${(e as Error).message}`);
      results.push({ mechanism: mech, success: false, reason: 'client_error' });
      continue;
    }
    // Find the new payment row for this mechanism.
    const after = await httpJson<PaymentRow[]>(
      'GET',
      `${FACILITATOR_URL}/api/admin/payments?limit=50`,
      { token },
    );
    const expectedMech = CLIENT_TO_SERVER_MECH[mech];
    const newRow = (after.body as PaymentRow[]).find(
      (p) => !beforeIds.has(p.paymentId) && p.transferMechanism === expectedMech,
    );
    if (!newRow) {
      err(`no new ${expectedMech} payment row persisted`);
      results.push({ mechanism: mech, success: false, reason: 'no_row_persisted' });
      continue;
    }
    beforeIds.add(newRow.paymentId);
    dim(`  persisted as ${newRow.paymentId} — polling to terminal…`);

    let final: PaymentRow;
    try {
      final = await pollPayment(token, newRow.paymentId);
    } catch (e) {
      err((e as Error).message);
      results.push({ mechanism: mech, success: false, paymentId: newRow.paymentId, reason: 'poll_timeout' });
      continue;
    }

    if (final.status === 'completed' || final.status === 'settled') {
      ok(`${mech} → ${final.status}  tx=${final.transactionHash}  block=${final.blockNumber}`);
      results.push({
        mechanism: mech,
        success: true,
        paymentId: final.paymentId,
        txHash: final.transactionHash,
        blockNumber: final.blockNumber,
      });
    } else {
      err(`${mech} → ${final.status}  error=${final.error ?? '(none)'}`);
      results.push({
        mechanism: mech,
        success: false,
        paymentId: final.paymentId,
        reason: final.error ?? final.status,
      });
    }
  }

  step('Summary');
  console.log('');
  for (const r of results) {
    const badge = r.success ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  [${badge}] ${r.mechanism.padEnd(8)} ${r.paymentId ?? ''}`);
    if (r.txHash) {
      const explorer =
        CHAIN === 11155111
          ? `https://sepolia.etherscan.io/tx/${r.txHash}`
          : CHAIN === 84532
            ? `https://sepolia.basescan.org/tx/${r.txHash}`
            : r.txHash;
      console.log(`           ${DIM}${explorer}${RESET}`);
    }
    if (r.reason && !r.success) {
      console.log(`           ${DIM}reason: ${r.reason}${RESET}`);
    }
  }
  console.log('');
  const allGreen = results.every((r) => r.success);
  if (allGreen) {
    console.log(`${GREEN}${BOLD}All ${results.length} mechanisms green.${RESET}`);
    process.exit(0);
  } else {
    const failed = results.filter((r) => !r.success).length;
    console.log(`${RED}${BOLD}${failed}/${results.length} mechanism(s) failed.${RESET}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${RED}fatal:${RESET}`, (e as Error).stack || e);
  process.exit(2);
});
