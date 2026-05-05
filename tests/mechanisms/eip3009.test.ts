import { beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { Eip3009Mechanism } from '../../src/mechanisms/Eip3009Mechanism';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';

// verify() never calls Fireblocks, so a bare cast is enough.
const factoryStub = {} as FireblocksSettlementFactory;

const TOKEN_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TOKEN_NAME = 'USDC';
const TOKEN_VERSION = '2';
const CHAIN_ID = 84532;

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

async function signAuthorization(
  signer: ethers.Wallet,
  message: Authorization,
): Promise<{ v: number; r: string; s: string }> {
  const domain = {
    name: TOKEN_NAME,
    version: TOKEN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: TOKEN_ADDRESS,
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
  const sig = ethers.Signature.from(await signer.signTypedData(domain, types, message));
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe('Eip3009Mechanism.verify', () => {
  let wallet: ethers.Wallet;
  let recipient: string;
  let now: number;

  beforeAll(() => {
    wallet = new ethers.Wallet(
      '0x' + '1'.repeat(64), // deterministic test key
    );
    recipient = '0x' + '2'.repeat(40);
    now = Math.floor(Date.now() / 1000);
  });

  function baseMessage(overrides: Partial<Authorization> = {}): Authorization {
    return {
      from: wallet.address,
      to: recipient,
      value: '100000', // 0.10 USDC
      validAfter: '0',
      validBefore: String(now + 600), // valid 10 min into the future
      nonce: ethers.hexlify(ethers.randomBytes(32)),
      ...overrides,
    };
  }

  async function verifyWith(message: Authorization, expectedAmount: bigint = 100000n) {
    const m = new Eip3009Mechanism(factoryStub);
    const signature = await signAuthorization(wallet, message);
    return m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: CHAIN_ID,
      message,
      signature,
      expectedAmount,
      expectedRecipient: recipient,
      provider: null,
    });
  }

  it('accepts a valid authorization', async () => {
    const res = await verifyWith(baseMessage());
    expect(res.valid).toBe(true);
    expect(res.signer?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects an expired authorization (validBefore in the past)', async () => {
    const res = await verifyWith(baseMessage({ validBefore: String(now - 1) }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/expired/i);
  });

  it('rejects a not-yet-valid authorization (validAfter in the future)', async () => {
    const res = await verifyWith(
      baseMessage({ validAfter: String(now + 3600), validBefore: String(now + 7200) }),
    );
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/not yet valid/i);
  });

  it('rejects amount-mismatch when signed value < expected', async () => {
    const res = await verifyWith(baseMessage({ value: '99999' }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Amount mismatch/i);
  });

  it('accepts when signed value > expected (overpay)', async () => {
    const res = await verifyWith(baseMessage({ value: '100001' }));
    expect(res.valid).toBe(true);
  });

  it('rejects recipient mismatch', async () => {
    const wrongRecipient = '0x' + '3'.repeat(40);
    const res = await verifyWith(baseMessage({ to: wrongRecipient }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Recipient mismatch/i);
  });

  it('rejects a signature for a different sender', async () => {
    const m = new Eip3009Mechanism(factoryStub);
    const attacker = new ethers.Wallet('0x' + '9'.repeat(64));
    const message = baseMessage({ from: wallet.address }); // claim to be the real wallet
    const signature = await signAuthorization(attacker, message); // but signed by attacker
    const res = await m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
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
