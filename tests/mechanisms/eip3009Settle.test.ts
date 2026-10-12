/**
 * When the live poll cap is hit, Fireblocks has already handed back a
 * tx id but hasn't reached a terminal state. The mechanism layer must
 * tell the route that explicitly (`pending` + `fireblocksTxId`) rather
 * than collapsing it into the same shape as a genuine failure — a payer
 * reading a flat `success: false` with no other signal will plausibly
 * sign and pay again.
 */
import { describe, expect, it } from 'vitest';
import { Eip3009Mechanism } from '../../src/mechanisms/Eip3009Mechanism';
import { FireblocksPollTimeoutError } from '../../src/services/fireblocksSettlement';
import type { FireblocksSettlementFactory } from '../../src/services/fireblocksSettlementFactory';
import type { SettleParams } from '../../src/mechanisms/TransferMechanism';

function baseParams(): SettleParams {
  return {
    paymentId: 'pay_1',
    from: '0x' + '1'.repeat(40),
    to: '0x' + '2'.repeat(40),
    amount: 1000n,
    tokenAddress: '0x' + '3'.repeat(40),
    chainId: 84532,
    signature: {
      v: 27,
      r: '0x' + '0'.repeat(64),
      s: '0x' + '0'.repeat(64),
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: '0x' + '4'.repeat(64),
    },
  };
}

function stubFactory(contractCall: (...args: any[]) => Promise<any>): FireblocksSettlementFactory {
  return { get: () => ({ contractCall }) } as unknown as FireblocksSettlementFactory;
}

describe('Eip3009Mechanism.settle — poll-cap conversion', () => {
  it('converts a FireblocksPollTimeoutError into a pending result carrying the fireblocksTxId', async () => {
    const pollError = new FireblocksPollTimeoutError('fb-tx-123', 'BROADCASTING');
    const factory = stubFactory(async (_addr, _data, _note, onTxId) => {
      await onTxId?.('fb-tx-123');
      throw pollError;
    });

    const result = await new Eip3009Mechanism(factory).settle(baseParams());

    expect(result).toEqual({
      success: false,
      pending: true,
      fireblocksTxId: 'fb-tx-123',
      error: pollError.message,
    });
  });

  it('a genuine terminal failure (not a poll timeout) stays a plain failure, not pending', async () => {
    const factory = stubFactory(async () => {
      throw new Error('Fireblocks transaction fb-tx-456 failed: FAILED (INSUFFICIENT_FUNDS)');
    });

    const result = await new Eip3009Mechanism(factory).settle(baseParams());

    expect(result.success).toBe(false);
    expect(result.pending).toBeUndefined();
    expect(result.fireblocksTxId).toBeUndefined();
    expect(result.error).toContain('INSUFFICIENT_FUNDS');
  });
});
