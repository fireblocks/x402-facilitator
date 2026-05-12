import { describe, expect, it } from 'vitest';
import {
  Erc7710Mechanism,
  MDF_DELEGATION_MANAGER,
} from '../../src/mechanisms/Erc7710Mechanism';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';

const factoryStub = {} as FireblocksSettlementFactory;

const TOKEN_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RECIPIENT = '0x' + '2'.repeat(40);
const DELEGATOR = '0x' + '3'.repeat(40);
const ATTACKER_MANAGER = '0x' + 'a'.repeat(40);
const VALID_PERMISSION_CONTEXT = '0x' + 'd'.repeat(200);

function baseDelegation(overrides: Partial<Record<string, string>> = {}) {
  return {
    delegationManager: MDF_DELEGATION_MANAGER,
    permissionContext: VALID_PERMISSION_CONTEXT,
    delegator: DELEGATOR,
    ...overrides,
  };
}

describe('Erc7710Mechanism.verify', () => {
  it('rejects when no provider is configured and none is injected', async () => {
    // Mechanism with no providerFactory; route always passes provider: null.
    const m = new Erc7710Mechanism(factoryStub);
    const res = await m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
      message: baseDelegation(),
      signature: {},
      expectedAmount: 100000n,
      expectedRecipient: RECIPIENT,
      provider: null,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/RPC provider/i);
    expect(res.error).toMatch(/X402_RPC_URL_84532/);
  });

  it('rejects an unknown delegationManager even with a provider configured', async () => {
    // ProviderFactory would return a provider, but the manager isn't allowlisted.
    // Allowlist check happens before provider use, so even without a real provider
    // we should get rejected with the manager-mismatch error.
    const m = new Erc7710Mechanism(factoryStub);
    const res = await m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
      message: baseDelegation({ delegationManager: ATTACKER_MANAGER }),
      signature: {},
      expectedAmount: 100000n,
      expectedRecipient: RECIPIENT,
      provider: null,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Unknown delegationManager/i);
    expect(res.error).toMatch(new RegExp(ATTACKER_MANAGER, 'i'));
  });

  it('rejects when delegation payload is missing required fields', async () => {
    const m = new Erc7710Mechanism(factoryStub);
    const res = await m.verify({
      tokenAddress: TOKEN_ADDRESS,
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
      message: { delegationManager: MDF_DELEGATION_MANAGER },
      signature: {},
      expectedAmount: 100000n,
      expectedRecipient: RECIPIENT,
      provider: null,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Missing required ERC-7710/i);
  });
});

describe('Erc7710Mechanism.settle', () => {
  it('refuses to settle against an unknown delegationManager', async () => {
    const m = new Erc7710Mechanism(factoryStub);
    const res = await m.settle({
      paymentId: 'pay_test_1',
      from: DELEGATOR,
      to: RECIPIENT,
      amount: 100000n,
      tokenAddress: TOKEN_ADDRESS,
      signature: baseDelegation({ delegationManager: ATTACKER_MANAGER }),
      chainId: 84532,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Refusing to settle/i);
    expect(res.error).toMatch(new RegExp(ATTACKER_MANAGER, 'i'));
  });
});
