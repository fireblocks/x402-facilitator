/**
 * x402 test client — signs the facilitator's chosen mechanism with a
 * local ethers wallet and hits a merchant URL.
 *
 * Supports:
 *   - eip3009    → TransferWithAuthorization (USDC-style)
 *   - permit2    → Uniswap Permit2 PermitWitnessTransferFrom
 *                  (requires a one-time on-chain approve(Permit2, MAX)
 *                  from the EOA; set MECHANISM=permit2 and
 *                  AUTO_APPROVE=true to run the approval if missing)
 *
 * Env:
 *   PRIVATE_KEY       (required) EOA that pays
 *   MERCHANT_URL      default http://localhost:3010/premium
 *   CHAIN=<chainId>   force a specific chain (84532 | 11155111)
 *   MECHANISM=<name>  force a specific mechanism (eip3009 | permit2)
 *   AUTO_APPROVE=true submit on-chain approve(Permit2, MAX) if needed
 *                     (needs Sepolia ETH on the EOA for gas)
 *   RPC_URL_BASE_SEPOLIA / RPC_URL_ETH_SEPOLIA overrides
 *
 * No Fireblocks anywhere in this path. The facilitator still uses
 * Fireblocks for settlement (its vault submits the CONTRACT_CALL),
 * but this client is a plain EOA payer.
 */

import 'dotenv/config';
import crypto from 'crypto';
import canonicalize from 'canonicalize';
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  Signature,
  formatUnits,
  MaxUint256,
  AbiCoder,
} from 'ethers';

interface PaymentRequirements {
  scheme: 'exact' | 'upto';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    assetTransferMethod?: string;
    permit2ProxyAddress?: string;
    permit2Address?: string;
  };
}

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// MetaMask Delegation Framework — canonical deployment (same on every chain).
const MDF_DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
const MDF_EIP7702_STATELESS_DELEGATOR = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
// MDF's root authority sentinel is 0xff × 32, *not* zero. Signed
// delegations whose `authority == ROOT_AUTHORITY` are top-level (the
// delegator is the root). Source: DelegationManager.ROOT_AUTHORITY.
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// Per-chain public faucet URLs — printed to the operator when the EOA
// is underfunded. Public testnet faucets are all behind captchas/social
// login by design, so we don't automate this — we just tell the human
// what to open and which address to paste.
const ETH_FAUCETS: Record<number, string[]> = {
  11155111: [
    'https://www.alchemy.com/faucets/ethereum-sepolia',
    'https://sepolia-faucet.pk910.de       (PoW — no login required)',
    'https://faucets.chain.link/sepolia',
  ],
  84532: [
    'https://www.alchemy.com/faucets/base-sepolia',
    'https://portal.cdp.coinbase.com/products/faucet',
  ],
};
const USDC_FAUCETS: Record<number, string[]> = {
  11155111: ['https://faucet.circle.com   → select "Ethereum Sepolia"'],
  84532: ['https://faucet.circle.com   → select "Base Sepolia"'],
};
const CHAIN_LABELS: Record<number, string> = {
  11155111: 'Ethereum Sepolia',
  84532: 'Base Sepolia',
};

interface IntegrityEnvelope {
  v: number;
  did: string;
  kid: string;
  alg: string;
  iat: number;
  exp: number;
  sig: string;
}

interface PaymentRequired {
  x402Version: 2;
  error?: string;
  integrity?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MERCHANT_URL = process.env.MERCHANT_URL || 'http://localhost:3010/premium';

// One entry per chain we want to read balances from. Override/extend via env.
const RPC_URLS: Record<number, string> = {
  84532: process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org',
  11155111: process.env.RPC_URL_ETH_SEPOLIA || 'https://ethereum-sepolia-rpc.publicnode.com',
};

// Explicit pick: CHAIN=84532 forces Base Sepolia, CHAIN=11155111 forces ETH Sepolia.
const CHAIN_OVERRIDE = process.env.CHAIN ? Number(process.env.CHAIN) : null;
// Explicit pick: MECHANISM=eip3009 | permit2 | uptopermit2 — matches accepted.extra.assetTransferMethod.
const MECHANISM_OVERRIDE = process.env.MECHANISM?.toLowerCase() || null;
const AUTO_APPROVE = process.env.AUTO_APPROVE === 'true';
// When true, verify the facilitator's X-402-Integrity envelope against the
// DID document before signing anything. Aborts with a clear error if the
// signature is missing, expired, or malformed.
const VERIFY_INTEGRITY = process.env.VERIFY_INTEGRITY === 'true';
const REQUIRE_INTEGRITY = process.env.REQUIRE_INTEGRITY === 'true';

if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY is not set. Generate one:');
  console.error(
    `  node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"`,
  );
  console.error('Then fund it with USDC on Base Sepolia or Ethereum Sepolia via https://faucet.circle.com/');
  process.exit(1);
}

async function readUsdcBalance(
  address: string,
  chainId: number,
  tokenAddress: string,
): Promise<bigint | null> {
  const url = RPC_URLS[chainId];
  if (!url) return null;
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    const erc20 = new Contract(
      tokenAddress,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    );
    const bal = (await erc20.balanceOf(address)) as bigint;
    return bal;
  } catch {
    return null;
  } finally {
    provider.destroy();
  }
}

async function readEthBalance(address: string, chainId: number): Promise<bigint | null> {
  const url = RPC_URLS[chainId];
  if (!url) return null;
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    return await provider.getBalance(address);
  } catch {
    return null;
  } finally {
    provider.destroy();
  }
}

function printFundingHelp(
  title: string,
  address: string,
  chainId: number,
  needed: string,
  current: string,
  faucets: string[],
): void {
  const chain = CHAIN_LABELS[chainId] ?? `chain ${chainId}`;
  console.error('');
  console.error('━'.repeat(72));
  console.error(`  ${title}`);
  console.error('━'.repeat(72));
  console.error(`  Address:   ${address}`);
  console.error(`  Chain:     ${chain} (chain id ${chainId})`);
  console.error(`  Needed:    ${needed}`);
  console.error(`  Current:   ${current}`);
  console.error('');
  console.error('  Public faucets (all require captcha or social login):');
  for (const u of faucets) console.error(`    • ${u}`);
  console.error('');
  console.error('  Paste the address above, claim, then re-run this script.');
  console.error('━'.repeat(72));
  console.error('');
}

/**
 * Preflight: ensure the EOA has ≥ minWei of gas on the given chain.
 * On shortfall, prints a fund-me block and exits(1). If the RPC read
 * fails (common on TLS-restricted environments), logs a warning and
 * returns — the downstream tx will surface the real error.
 */
async function ensureEthBalance(
  wallet: Wallet,
  chainId: number,
  minWei: bigint,
  reason: string,
): Promise<void> {
  const bal = await readEthBalance(wallet.address, chainId);
  if (bal === null) {
    console.warn(
      `  ⚠ Could not read ETH balance on chain ${chainId} (RPC unreachable). Proceeding; tx may fail if underfunded.`,
    );
    return;
  }
  if (bal >= minWei) {
    console.log(`  gas OK: ${formatUnits(bal, 18)} ETH on ${CHAIN_LABELS[chainId] ?? chainId}`);
    return;
  }
  printFundingHelp(
    `Insufficient ETH for gas — ${reason}`,
    wallet.address,
    chainId,
    `≥ ${formatUnits(minWei, 18)} ETH`,
    `${formatUnits(bal, 18)} ETH`,
    ETH_FAUCETS[chainId] ?? ['(no faucet URLs configured for this chain)'],
  );
  process.exit(1);
}

/**
 * Preflight: ensure the EOA holds ≥ minAmount of the given USDC
 * contract. Same UX as ensureEthBalance — print + exit on shortage.
 */
async function ensureUsdcBalance(
  wallet: Wallet,
  chainId: number,
  tokenAddress: string,
  minAmount: bigint,
  reason: string,
): Promise<void> {
  const bal = await readUsdcBalance(wallet.address, chainId, tokenAddress);
  if (bal === null) {
    console.warn(
      `  ⚠ Could not read USDC balance on chain ${chainId} (RPC unreachable). Proceeding; settlement may fail if underfunded.`,
    );
    return;
  }
  if (bal >= minAmount) {
    console.log(`  USDC OK: ${formatUnits(bal, 6)} on ${CHAIN_LABELS[chainId] ?? chainId}`);
    return;
  }
  printFundingHelp(
    `Insufficient USDC — ${reason}`,
    wallet.address,
    chainId,
    `≥ ${formatUnits(minAmount, 6)} USDC`,
    `${formatUnits(bal, 6)} USDC`,
    USDC_FAUCETS[chainId] ?? ['https://faucet.circle.com'],
  );
  process.exit(1);
}

// ── Payment Instruction Integrity (X-402-Integrity) ─────────────────
//
// Decodes the envelope the facilitator emits, resolves did:web to fetch
// the signing key, and verifies the signature covers the canonical form
// of the 402 body we received. Returns a structured result so callers
// can decide between "proceed", "warn", and "abort".

function base64urlToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(padded, 'base64');
}

function didWebToUrl(did: string): string {
  // did:web:example.com        → https://example.com/.well-known/did.json
  // did:web:example.com:path   → https://example.com/path/did.json
  // Port is percent-encoded per did:web spec: did:web:localhost%3A3000
  const body = did.replace(/^did:web(vh)?:/, '');
  const [domainRaw, ...rest] = body.split(':');
  const domain = decodeURIComponent(domainRaw);
  const scheme = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(domain) ? 'http' : 'https';
  if (rest.length === 0) return `${scheme}://${domain}/.well-known/did.json`;
  return `${scheme}://${domain}/${rest.join('/')}/did.json`;
}

interface IntegrityResult {
  ok: boolean;
  reason: string;
  envelope?: IntegrityEnvelope;
}

async function verifyIntegrity(quote: PaymentRequired): Promise<IntegrityResult> {
  if (!quote.integrity) {
    return { ok: false, reason: 'no integrity envelope on the 402 response' };
  }
  let env: IntegrityEnvelope;
  try {
    env = JSON.parse(base64urlToBuffer(quote.integrity).toString('utf-8'));
  } catch (e) {
    return { ok: false, reason: `malformed envelope: ${(e as Error).message}` };
  }
  if (env.v !== 1) return { ok: false, reason: `unsupported envelope version v=${env.v}` };
  if (env.alg !== 'ES256') return { ok: false, reason: `unsupported alg ${env.alg}`, envelope: env };
  const now = Math.floor(Date.now() / 1000);
  if (env.exp < now) return { ok: false, reason: `envelope expired ${now - env.exp}s ago`, envelope: env };
  if (env.iat > now + 60) return { ok: false, reason: `iat is in the future`, envelope: env };

  // Fetch DID document.
  const didUrl = didWebToUrl(env.did);
  let didDoc: {
    verificationMethod?: Array<{
      id: string;
      type?: string;
      publicKeyJwk?: { kty?: string; crv?: string; x?: string; y?: string };
    }>;
  };
  try {
    const res = await fetch(didUrl);
    if (!res.ok) throw new Error(`GET ${didUrl} → ${res.status}`);
    didDoc = (await res.json()) as typeof didDoc;
  } catch (e) {
    return { ok: false, reason: `failed to resolve ${env.did} at ${didUrl}: ${(e as Error).message}`, envelope: env };
  }

  const fullKid = env.kid.startsWith(env.did) ? env.kid : `${env.did}#${env.kid}`;
  const entry = didDoc.verificationMethod?.find((m) => m.id === fullKid || m.id.endsWith(`#${env.kid}`));
  if (!entry?.publicKeyJwk) {
    return { ok: false, reason: `kid '${env.kid}' not found in DID document at ${didUrl}`, envelope: env };
  }
  if (entry.publicKeyJwk.kty !== 'EC' || entry.publicKeyJwk.crv !== 'P-256') {
    return { ok: false, reason: `DID key is not ES256 / P-256`, envelope: env };
  }

  // Reconstruct canonical payload — payment-critical slice only.
  // resource.url / error / extensions are intentionally excluded
  // because the merchant SDK rewrites resource.url to its own origin
  // before emitting the 402. See IntegritySigner.integritySlice.
  const slice = {
    x402Version: quote.x402Version ?? 2,
    accepts: Array.isArray(quote.accepts) ? quote.accepts : [],
  };
  const jcs = canonicalize(slice);
  if (jcs === undefined) return { ok: false, reason: 'canonicalize() returned undefined', envelope: env };
  const canonicalBytes = Buffer.from(`${jcs}\n${env.iat}\n${env.exp}`, 'utf-8');

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: entry.publicKeyJwk as crypto.JsonWebKey, format: 'jwk' });
  } catch (e) {
    return { ok: false, reason: `failed to import public key: ${(e as Error).message}`, envelope: env };
  }
  const valid = crypto.verify(
    'SHA256',
    canonicalBytes,
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    base64urlToBuffer(env.sig),
  );
  if (!valid) return { ok: false, reason: 'signature does not verify', envelope: env };
  return { ok: true, reason: `signature valid via ${env.did}#${env.kid}`, envelope: env };
}

function filterByMechanism(accepts: PaymentRequirements[]): PaymentRequirements[] {
  if (MECHANISM_OVERRIDE === null) return accepts;
  const filtered = accepts.filter(
    (a) => (a.extra.assetTransferMethod ?? '').toLowerCase() === MECHANISM_OVERRIDE,
  );
  if (filtered.length === 0) {
    throw new Error(
      `MECHANISM=${MECHANISM_OVERRIDE} was forced but no quote option uses it. ` +
        `Available: ${[...new Set(accepts.map((a) => a.extra.assetTransferMethod))].join(', ')}`,
    );
  }
  return filtered;
}

async function pickAccepted(
  wallet: Wallet,
  accepts: PaymentRequirements[],
): Promise<{ accepted: PaymentRequirements; chainId: number; reason: string }> {
  const candidates = filterByMechanism(accepts);

  // Explicit chain pick wins.
  if (CHAIN_OVERRIDE !== null) {
    const match = candidates.find((a) => Number(a.network.split(':')[1]) === CHAIN_OVERRIDE);
    if (!match) {
      throw new Error(
        `CHAIN=${CHAIN_OVERRIDE} was forced but the filtered quote has no option on that network. ` +
          `Available: ${candidates.map((a) => a.network).join(', ')}`,
      );
    }
    return {
      accepted: match,
      chainId: CHAIN_OVERRIDE,
      reason: `forced by CHAIN=${CHAIN_OVERRIDE}${MECHANISM_OVERRIDE ? ` + MECHANISM=${MECHANISM_OVERRIDE}` : ''}`,
    };
  }

  // Probe balances and pick the first with enough USDC.
  console.log(`\nBalance probe across ${candidates.length} option(s):`);
  const scored = await Promise.all(
    candidates.map(async (a) => {
      const chainId = Number(a.network.split(':')[1]);
      const bal = await readUsdcBalance(wallet.address, chainId, a.asset);
      console.log(
        `  ${a.network.padEnd(16)} ${(a.extra.assetTransferMethod ?? '?').padEnd(10)} ${a.asset}  balance=${bal === null ? 'unknown' : formatUnits(bal, 6)} needed=${formatUnits(a.amount, 6)}`,
      );
      return { a, chainId, bal };
    }),
  );
  const sufficient = scored.find((s) => s.bal !== null && s.bal >= BigInt(s.a.amount));
  if (sufficient) {
    return {
      accepted: sufficient.a,
      chainId: sufficient.chainId,
      reason: `has ${formatUnits(sufficient.bal!, 6)} USDC on ${sufficient.a.network}`,
    };
  }
  const first = candidates[0];
  return {
    accepted: first,
    chainId: Number(first.network.split(':')[1]),
    reason: 'no option had sufficient balance — falling back to first',
  };
}

interface SignedAuthorization {
  signature: string;
  body: Record<string, unknown>;
}

async function signEip3009(
  wallet: Wallet,
  accepted: PaymentRequirements,
  chainId: number,
): Promise<SignedAuthorization> {
  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + Math.max(accepted.maxTimeoutSeconds, 300);
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const domain = {
    name: accepted.extra.name,
    version: accepted.extra.version,
    chainId,
    verifyingContract: accepted.asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = {
    from: wallet.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: 0,
    validBefore,
    nonce,
  };
  const rawSig = await wallet.signTypedData(domain, types, message);
  const sig = Signature.from(rawSig).serialized;
  return {
    signature: sig,
    body: {
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter: String(message.validAfter),
        validBefore: String(message.validBefore),
        nonce: message.nonce,
      },
    },
  };
}

async function ensurePermit2Allowance(
  wallet: Wallet,
  chainId: number,
  tokenAddress: string,
  needed: bigint,
): Promise<{ ok: boolean; allowance: bigint | null; reason?: string }> {
  const url = RPC_URLS[chainId];
  if (!url) return { ok: false, allowance: null, reason: `No RPC configured for chain ${chainId}` };
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    const erc20 = new Contract(
      tokenAddress,
      [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
      ],
      provider,
    );
    const current = (await erc20.allowance(wallet.address, PERMIT2_ADDRESS)) as bigint;
    if (current >= needed) return { ok: true, allowance: current };
    if (!AUTO_APPROVE) {
      return {
        ok: false,
        allowance: current,
        reason:
          `EOA ${wallet.address} has ${current} allowance on Permit2 (need ≥ ${needed}). ` +
          `Re-run with AUTO_APPROVE=true to submit approve(Permit2, MAX) on-chain (needs gas ETH on the EOA).`,
      };
    }
    // Submit approve from the wallet.
    console.log(`\nSubmitting approve(Permit2, MAX) on chain ${chainId} — requires gas ETH on EOA…`);
    const signer = wallet.connect(provider);
    const contractWithSigner = new Contract(
      tokenAddress,
      ['function approve(address spender, uint256 amount) returns (bool)'],
      signer,
    );
    const tx = await contractWithSigner.approve(PERMIT2_ADDRESS, MaxUint256);
    console.log(`  tx hash: ${tx.hash}`);
    await tx.wait();
    const fresh = (await erc20.allowance(wallet.address, PERMIT2_ADDRESS)) as bigint;
    console.log(`  new allowance: ${fresh}`);
    return { ok: true, allowance: fresh };
  } catch (err) {
    return { ok: false, allowance: null, reason: (err as Error).message };
  } finally {
    provider.destroy();
  }
}

async function ensureEip7702Upgrade(
  wallet: Wallet,
  chainId: number,
): Promise<{ ok: boolean; state: 'already' | 'now' | 'failed'; reason?: string }> {
  const url = RPC_URLS[chainId];
  if (!url) {
    return { ok: false, state: 'failed', reason: `No RPC configured for chain ${chainId}` };
  }
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    // EIP-7702-upgraded EOA has code = 0xef0100 + <implementation> (23 bytes)
    const expected = ('0xef0100' + MDF_EIP7702_STATELESS_DELEGATOR.slice(2)).toLowerCase();
    const code = (await provider.getCode(wallet.address)).toLowerCase();
    if (code === expected) return { ok: true, state: 'already' };
    if (code !== '0x' && code !== expected) {
      return {
        ok: false,
        state: 'failed',
        reason: `EOA ${wallet.address} already has code ${code.slice(0, 14)}… — not pointing at EIP7702StatelessDeleGator`,
      };
    }
    // Submit a self-authorized EIP-7702 upgrade tx (type 0x04).
    const signer = wallet.connect(provider);
    const currentNonce = await signer.getNonce();
    // Self-auth nonce = currentNonce + 1 (the tx consumes one nonce before
    // the auth is applied, so the auth must reference the post-tx nonce).
    const auth = await signer.authorize({
      address: MDF_EIP7702_STATELESS_DELEGATOR,
      chainId,
      nonce: currentNonce + 1,
    });
    const tx = await signer.sendTransaction({
      type: 4,
      to: wallet.address,
      value: 0,
      data: '0x',
      authorizationList: [auth],
    });
    console.log(`  7702 tx hash: ${tx.hash}`);
    await tx.wait();
    // Sanity-check code pointer
    const newCode = (await provider.getCode(wallet.address)).toLowerCase();
    if (newCode !== expected) {
      return {
        ok: false,
        state: 'failed',
        reason: `After 7702 tx, code is ${newCode.slice(0, 14)}… expected ${expected.slice(0, 14)}…`,
      };
    }
    return { ok: true, state: 'now' };
  } catch (err) {
    return { ok: false, state: 'failed', reason: (err as Error).message };
  } finally {
    provider.destroy();
  }
}

async function signDelegation(
  wallet: Wallet,
  accepted: PaymentRequirements,
  chainId: number,
): Promise<SignedAuthorization> {
  const delegationManager =
    (accepted.extra as Record<string, unknown>).delegationManager as string | undefined;
  const delegate =
    ((accepted.extra as Record<string, unknown>).delegate as string | undefined) ??
    accepted.payTo;
  if (!delegationManager) {
    throw new Error('erc7710 quote missing extra.delegationManager');
  }

  const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();

  // EIP-712 domain (matches MDF DelegationManager's getDomainSeparator):
  //   NAME = "DelegationManager", DOMAIN_VERSION = "1"
  const domain = {
    name: 'DelegationManager',
    version: '1',
    chainId,
    verifyingContract: delegationManager,
  };

  // Typehash (from MDF Constants.sol):
  //   Delegation(address delegate,address delegator,bytes32 authority,
  //              Caveat[] caveats,uint256 salt)
  //   Caveat(address enforcer,bytes terms)
  // Note: signature + Caveat.args are intentionally excluded from hashing.
  const types = {
    Delegation: [
      { name: 'delegate', type: 'address' },
      { name: 'delegator', type: 'address' },
      { name: 'authority', type: 'bytes32' },
      { name: 'caveats', type: 'Caveat[]' },
      { name: 'salt', type: 'uint256' },
    ],
    Caveat: [
      { name: 'enforcer', type: 'address' },
      { name: 'terms', type: 'bytes' },
    ],
  };

  // For this test we ship an unconstrained delegation — no caveats. In
  // production each payment should at minimum bind (target=token,
  // method=transfer, recipient=payTo, amount≤<X>) via enforcers.
  const message = {
    delegate,
    delegator: wallet.address,
    authority: ROOT_AUTHORITY,
    caveats: [] as Array<{ enforcer: string; terms: string }>,
    salt,
  };
  const sig = await wallet.signTypedData(domain, types, message);

  // permissionContext = abi.encode(Delegation[]). Delegation struct here
  // carries the full on-chain shape (including signature + Caveat.args)
  // even though only delegate/delegator/authority/caveats/salt were signed.
  const permissionContext = AbiCoder.defaultAbiCoder().encode(
    [
      'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]',
    ],
    [
      [
        {
          delegate,
          delegator: wallet.address,
          authority: ROOT_AUTHORITY,
          caveats: [],
          salt,
          signature: sig,
        },
      ],
    ],
  );

  return {
    signature: sig,
    body: {
      delegation: {
        delegationManager,
        permissionContext,
        delegator: wallet.address,
      },
    },
  };
}

async function signPermit2(
  wallet: Wallet,
  accepted: PaymentRequirements,
  chainId: number,
): Promise<SignedAuthorization> {
  const spender = accepted.extra.permit2ProxyAddress;
  if (!spender) {
    throw new Error('permit2 quote missing extra.permit2ProxyAddress');
  }
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + Math.max(accepted.maxTimeoutSeconds, 300);
  // Uint256 random nonce. Permit2 uses a bitmap for replay protection, any uint fits.
  const nonce = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();

  const domain = {
    name: 'Permit2',
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  };
  const types = {
    PermitWitnessTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: 'Witness' },
    ],
    TokenPermissions: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    Witness: [
      { name: 'to', type: 'address' },
      { name: 'validAfter', type: 'uint256' },
    ],
  };
  const message = {
    permitted: {
      token: accepted.asset,
      amount: accepted.amount,
    },
    spender,
    nonce,
    deadline: String(deadline),
    witness: {
      to: accepted.payTo,
      validAfter: '0',
    },
  };
  const rawSig = await wallet.signTypedData(domain, types, message);
  const sig = Signature.from(rawSig).serialized;
  return {
    signature: sig,
    body: {
      permit2Authorization: {
        permitted: message.permitted,
        from: wallet.address,
        spender,
        nonce,
        deadline: message.deadline,
        witness: message.witness,
      },
    },
  };
}

async function main() {
  const wallet = new Wallet(PRIVATE_KEY!);

  console.log(`Target:          ${MERCHANT_URL}`);
  console.log(`Wallet address:  ${wallet.address}`);

  // 1. Hit the merchant without a signature — expect 402.
  const first = await fetch(MERCHANT_URL);
  if (first.status === 200) {
    console.log('Resource already free (no 402). Body:', await first.text());
    return;
  }
  if (first.status !== 402) {
    console.error(`Unexpected status from merchant: ${first.status}`);
    console.error(await first.text());
    process.exit(1);
  }
  const quote = (await first.json()) as PaymentRequired;
  if (!quote.accepts || quote.accepts.length === 0) {
    console.error('402 response has no accepts[] entries');
    process.exit(1);
  }

  console.log(`\n402 quote — ${quote.accepts.length} payment option(s):`);
  for (const a of quote.accepts) {
    console.log(
      `  • ${a.network} scheme=${a.scheme} amount=${a.amount} asset=${a.asset} payTo=${a.payTo} domain=${a.extra.name} v${a.extra.version}`,
    );
  }

  // Payment Instruction Integrity — verify the 402 body against the
  // facilitator's did:web key before signing anything. Controlled by
  // VERIFY_INTEGRITY (opt-in) and REQUIRE_INTEGRITY (strict mode: abort
  // when the server didn't include an envelope at all).
  if (VERIFY_INTEGRITY || REQUIRE_INTEGRITY) {
    console.log('\nPayment Instruction Integrity check…');
    const result = await verifyIntegrity(quote);
    if (result.ok) {
      console.log(`  ✓ ${result.reason}`);
      if (result.envelope) {
        const ttl = result.envelope.exp - Math.floor(Date.now() / 1000);
        console.log(`    did=${result.envelope.did} kid=${result.envelope.kid} ttl=${ttl}s`);
      }
    } else {
      const shouldAbort =
        REQUIRE_INTEGRITY ||
        (VERIFY_INTEGRITY && quote.integrity !== undefined);
      const label = shouldAbort ? '✗' : '⚠';
      console.error(`  ${label} ${result.reason}`);
      if (shouldAbort) {
        console.error('  Refusing to sign — set VERIFY_INTEGRITY=false to bypass (NOT recommended).');
        process.exit(1);
      } else {
        console.error('  Proceeding without integrity (REQUIRE_INTEGRITY=true to enforce).');
      }
    }
  }

  const { accepted, chainId, reason } = await pickAccepted(wallet, quote.accepts);
  const mechanism = (accepted.extra.assetTransferMethod ?? 'eip3009').toLowerCase();
  console.log(`\nSelected:  ${accepted.network} (${mechanism}) — ${reason}`);

  let signed: SignedAuthorization;
  let includeEcdsaSignature = true;
  if (mechanism === 'eip3009') {
    // EIP-3009: payer doesn't pay gas, but they do need USDC.
    console.log('\nPreflight: USDC balance…');
    await ensureUsdcBalance(
      wallet,
      chainId,
      accepted.asset,
      BigInt(accepted.amount),
      'EIP-3009 TransferWithAuthorization',
    );
    console.log('\nSigning TransferWithAuthorization (EIP-3009)…');
    signed = await signEip3009(wallet, accepted, chainId);
  } else if (mechanism === 'permit2') {
    // Permit2: EOA needs USDC for the transfer, and (if allowance isn't
    // set yet) a tiny amount of gas ETH for the one-time approve tx.
    console.log('\nPreflight: USDC balance…');
    await ensureUsdcBalance(
      wallet,
      chainId,
      accepted.asset,
      BigInt(accepted.amount),
      'Permit2 settlement',
    );
    if (AUTO_APPROVE) {
      console.log('\nPreflight: gas ETH for approve(Permit2, MAX)…');
      // ~50k gas * ~2 gwei = 0.0001 ETH. Ask for 0.001 to leave retry room.
      await ensureEthBalance(wallet, chainId, 1_000_000_000_000_000n, 'Permit2 approve tx');
    }
    console.log('\nChecking Permit2 allowance on-chain…');
    const allowanceStatus = await ensurePermit2Allowance(
      wallet,
      chainId,
      accepted.asset,
      BigInt(accepted.amount),
    );
    if (!allowanceStatus.ok) {
      console.warn(`  ⚠ ${allowanceStatus.reason}`);
      console.warn(`  Proceeding to sign anyway — settlement will revert on-chain without allowance.`);
    } else {
      console.log(`  allowance OK: ${allowanceStatus.allowance}`);
    }
    console.log('\nSigning Permit2 PermitWitnessTransferFrom…');
    signed = await signPermit2(wallet, accepted, chainId);
  } else if (mechanism === 'erc7710') {
    // ERC-7710 via EIP-7702: EOA needs USDC (for the eventual transfer)
    // and gas ETH (for the one-time self-upgrade tx).
    console.log('\nPreflight: USDC balance…');
    await ensureUsdcBalance(
      wallet,
      chainId,
      accepted.asset,
      BigInt(accepted.amount),
      'ERC-7710 delegation redemption',
    );
    console.log('\nPreflight: gas ETH for EIP-7702 self-upgrade…');
    // ~30k gas * ~2 gwei = 0.00006 ETH. Ask for 0.001 to leave buffer.
    await ensureEthBalance(wallet, chainId, 1_000_000_000_000_000n, 'EIP-7702 self-upgrade tx');

    console.log('\nChecking EIP-7702 upgrade status…');
    const up = await ensureEip7702Upgrade(wallet, chainId);
    if (!up.ok) {
      console.warn(`  ⚠ ${up.reason}`);
      console.warn('  Proceeding anyway — the Delegation signature will fail validation against an un-upgraded EOA.');
    } else {
      console.log(
        `  status: EIP7702StatelessDeleGator ${up.state === 'already' ? 'already pointed at this EOA' : 'freshly installed'}`,
      );
    }
    console.log('\nSigning MDF Delegation (EIP-712 against DelegationManager)…');
    signed = await signDelegation(wallet, accepted, chainId);
    includeEcdsaSignature = false; // server expects payload.delegation, no top-level sig
  } else {
    throw new Error(
      `Unsupported mechanism '${mechanism}' in this client. ` +
        `Supported: eip3009, permit2, erc7710.`,
    );
  }
  console.log(`  signer:  ${wallet.address}`);
  console.log(`  sig:     ${signed.signature.slice(0, 14)}…`);

  const payload = {
    x402Version: 2,
    resource: quote.resource,
    accepted,
    payload: {
      ...(includeEcdsaSignature ? { signature: signed.signature } : {}),
      ...signed.body,
    },
  };
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');

  console.log(`\nRetrying with payment-signature header…`);
  const second = await fetch(MERCHANT_URL, { headers: { 'payment-signature': header } });
  console.log(`\nMerchant response: ${second.status}`);
  const text = await second.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  const settlementHeader = second.headers.get('payment-response');
  if (settlementHeader) {
    const decoded = JSON.parse(Buffer.from(settlementHeader, 'base64').toString('utf-8'));
    console.log(`\nPAYMENT-RESPONSE:`);
    console.log(JSON.stringify(decoded, null, 2));
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  if (process.env.DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
