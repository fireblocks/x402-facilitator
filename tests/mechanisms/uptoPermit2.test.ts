import { beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  UptoPermit2Mechanism,
  X402_UPTO_PERMIT2_PROXY,
} from '../../src/mechanisms/UptoPermit2Mechanism';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';

const factoryStub = {} as FireblocksSettlementFactory;
const TOKEN_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const WITNESS_TYPES = {
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
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
};

interface UptoPermit2Auth {
  permitted: { token: string; amount: string };
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; facilitator: string; validAfter: string };
  expectedFacilitator?: string;
}

async function signPermit2(signer: ethers.Wallet, msg: UptoPermit2Auth) {
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
    await signer.signTypedData(domain, WITNESS_TYPES, eip712),
  );
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe('UptoPermit2Mechanism.verify', () => {
  let wallet: ethers.Wallet;
  let recipient: string;
  let facilitator: string;
  let otherFacilitator: string;
  let now: number;

  beforeAll(() => {
    wallet = new ethers.Wallet('0x' + '1'.repeat(64));
    recipient = '0x' + '2'.repeat(40);
    facilitator = '0x' + '4'.repeat(40);
    otherFacilitator = '0x' + '5'.repeat(40);
    now = Math.floor(Date.now() / 1000);
  });

  function baseMessage(overrides: Partial<UptoPermit2Auth> = {}): UptoPermit2Auth {
    return {
      permitted: { token: TOKEN_ADDRESS, amount: '100000' },
      from: wallet.address,
      spender: X402_UPTO_PERMIT2_PROXY,
      nonce: '12345',
      deadline: String(now + 600),
      witness: {
        to: recipient,
        facilitator,
        validAfter: String(now - 60),
      },
      expectedFacilitator: facilitator,
      ...overrides,
    };
  }

  async function verifyWith(message: UptoPermit2Auth, expectedAmount: bigint = 100000n) {
    const m = new UptoPermit2Mechanism(factoryStub);
    const signature = await signPermit2(wallet, message);
    return m.verify({
      tokenAddress: TOKEN_ADDRESS,
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

  it('accepts a valid upto-permit2 authorization with matching facilitator', async () => {
    const res = await verifyWith(baseMessage());
    expect(res.valid).toBe(true);
    expect(res.signer?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects when the expected facilitator binding is missing', async () => {
    const res = await verifyWith({ ...baseMessage(), expectedFacilitator: undefined });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/missing expected facilitator/i);
  });

  it('rejects when witness.facilitator does not match the expected facilitator', async () => {
    const res = await verifyWith({
      ...baseMessage(),
      witness: { to: recipient, facilitator: otherFacilitator, validAfter: String(now - 60) },
      expectedFacilitator: facilitator,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/facilitator mismatch/i);
  });
});
