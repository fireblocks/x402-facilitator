import { beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  Permit2Mechanism,
  X402_EXACT_PERMIT2_PROXY,
  PERMIT2_ADDRESS,
} from '../../src/mechanisms/Permit2Mechanism';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';

const factoryStub = {} as FireblocksSettlementFactory;

const TOKEN_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;

const PERMIT2_WITNESS_TYPES = {
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

interface Permit2Auth {
  permitted: { token: string; amount: string };
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; validAfter: string };
}

async function signPermit2(signer: ethers.Wallet, msg: Permit2Auth) {
  const domain = {
    name: 'Permit2',
    chainId: CHAIN_ID,
    verifyingContract: PERMIT2_ADDRESS,
  };
  const eip712 = {
    permitted: msg.permitted,
    spender: msg.spender,
    nonce: msg.nonce,
    deadline: msg.deadline,
    witness: msg.witness,
  };
  const sig = ethers.Signature.from(
    await signer.signTypedData(domain, PERMIT2_WITNESS_TYPES, eip712),
  );
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe('Permit2Mechanism.verify', () => {
  let wallet: ethers.Wallet;
  let recipient: string;
  let now: number;

  beforeAll(() => {
    wallet = new ethers.Wallet('0x' + '1'.repeat(64));
    recipient = '0x' + '2'.repeat(40);
    now = Math.floor(Date.now() / 1000);
  });

  function baseMessage(overrides: Partial<Permit2Auth> = {}): Permit2Auth {
    return {
      permitted: { token: TOKEN_ADDRESS, amount: '100000' },
      from: wallet.address,
      spender: X402_EXACT_PERMIT2_PROXY,
      nonce: '12345',
      deadline: String(now + 600),
      witness: { to: recipient, validAfter: String(now - 60) },
      ...overrides,
    };
  }

  async function verifyWith(
    message: Permit2Auth,
    expectedAmount: bigint = 100000n,
    tokenAddress: string = TOKEN_ADDRESS,
  ) {
    const m = new Permit2Mechanism(factoryStub);
    const signature = await signPermit2(wallet, message);
    return m.verify({
      tokenAddress,
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: CHAIN_ID,
      message,
      signature,
      expectedAmount,
      expectedRecipient: recipient,
      provider: null,
    });
  }

  it('accepts a valid permit2 authorization', async () => {
    const res = await verifyWith(baseMessage());
    expect(res.valid).toBe(true);
    expect(res.signer?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects when permitted.token does not match the asset address', async () => {
    const wrongToken = '0x' + 'a'.repeat(40);
    const res = await verifyWith(
      baseMessage({ permitted: { token: wrongToken, amount: '100000' } }),
    );
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Token mismatch/i);
  });

  it('rejects when spender is not the x402ExactPermit2Proxy', async () => {
    const wrongSpender = '0x' + 'b'.repeat(40);
    const res = await verifyWith(baseMessage({ spender: wrongSpender }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Invalid spender/i);
  });

  it('rejects amount underpay', async () => {
    const res = await verifyWith(baseMessage({ permitted: { token: TOKEN_ADDRESS, amount: '50000' } }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Amount mismatch/i);
  });

  it('rejects when witness recipient does not match expected', async () => {
    const wrong = '0x' + '3'.repeat(40);
    const res = await verifyWith(baseMessage({ witness: { to: wrong, validAfter: String(now - 60) } }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Recipient mismatch/i);
  });

  it('rejects expired deadline', async () => {
    const res = await verifyWith(baseMessage({ deadline: String(now - 1) }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/deadline expired/i);
  });

  it('rejects not-yet-valid (witness.validAfter in future)', async () => {
    const res = await verifyWith(baseMessage({ witness: { to: recipient, validAfter: String(now + 3600) } }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/not yet valid/i);
  });

  it('rejects a signature recovered to a different address', async () => {
    const m = new Permit2Mechanism(factoryStub);
    const attacker = new ethers.Wallet('0x' + '9'.repeat(64));
    const message = baseMessage(); // from = real wallet
    const signature = await signPermit2(attacker, message); // signed by attacker
    const res = await m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: CHAIN_ID,
      message,
      signature,
      expectedAmount: 100000n,
      expectedRecipient: recipient,
      provider: null,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Signature verification failed/i);
  });
});
