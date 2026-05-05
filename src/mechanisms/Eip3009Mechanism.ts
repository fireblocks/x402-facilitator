/**
 * EIP-3009 Transfer Mechanism
 * Uses transferWithAuthorization() for single-tx meta-transactions.
 * For tokens that support it natively (e.g. USDC).
 */

import { BaseMechanism, VerifyParams, VerifyResult, SettleParams, SettleResult, DEFAULT_SETTLE_SCOPE } from './TransferMechanism';
import { ethers } from 'ethers';

export class Eip3009Mechanism extends BaseMechanism {
  readonly name = 'eip-3009';

  /**
   * Verify transferWithAuthorization signature off-chain.
   * Recovers signer from EIP-712 typed data hash, validates amount and recipient.
   */
  async verify(params: VerifyParams): Promise<VerifyResult> {
    try {
      const { tokenAddress, tokenName, tokenVersion, chainId, message, signature, expectedAmount, expectedRecipient } = params;

      const domain = {
        name: tokenName,
        version: tokenVersion,
        chainId,
        verifyingContract: tokenAddress,
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

      const hash = ethers.TypedDataEncoder.hash(domain, types, message);
      const recoveredSigner = ethers.recoverAddress(hash, {
        v: signature.v,
        r: signature.r,
        s: signature.s,
      });

      const expectedFrom = message.from.toLowerCase();
      if (recoveredSigner.toLowerCase() !== expectedFrom) {
        return {
          valid: false,
          error: `Signature verification failed: recovered signer ${recoveredSigner} does not match expected sender ${expectedFrom}`,
        };
      }

      const signatureAmount = BigInt(message.value);
      if (signatureAmount < expectedAmount) {
        return {
          valid: false,
          error: `Amount mismatch: expected ${expectedAmount}, got ${signatureAmount}`,
        };
      }

      const signatureRecipient = message.to.toLowerCase();
      if (signatureRecipient !== expectedRecipient.toLowerCase()) {
        return {
          valid: false,
          error: `Recipient mismatch: expected ${expectedRecipient}, got ${signatureRecipient}`,
        };
      }

      // Enforce the signed time window. The on-chain transferWithAuthorization
      // also enforces these, but /verify is the authoritative off-chain gate —
      // accepting outside the window wastes a Fireblocks tx that will revert.
      const nowUnix = Math.floor(Date.now() / 1000);
      if (Number(message.validAfter) > nowUnix) {
        return {
          valid: false,
          error: `Authorization not yet valid: validAfter=${message.validAfter} > now=${nowUnix}`,
        };
      }
      if (Number(message.validBefore) <= nowUnix) {
        return {
          valid: false,
          error: `Authorization expired: validBefore=${message.validBefore} <= now=${nowUnix}`,
        };
      }

      return { valid: true, signer: recoveredSigner };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid signature format: ${error}`,
      };
    }
  }

  /**
   * Settle payment on-chain using EIP-3009 transferWithAuthorization.
   * Single transaction — most efficient for tokens supporting it natively.
   */
  async settle(params: SettleParams): Promise<SettleResult> {
    const { from, to, amount, tokenAddress, signature, chainId, onSettlementTxId, scope = DEFAULT_SETTLE_SCOPE, paymentId } = params;

    if (!signature) {
      return { success: false, error: 'Authorization signature required' };
    }

    console.log(`[eip-3009] Settling: ${tokenAddress} amount=${amount}`);

    try {
      const validAfter = signature.validAfter || 0;
      const validBefore = signature.validBefore;
      const nowUnix = Math.floor(Date.now() / 1000);
      const secsRemaining = Number(validBefore) - nowUnix;
      console.log(`[eip-3009] validBefore=${validBefore} now=${nowUnix} remaining=${secsRemaining}s`);
      if (secsRemaining < 30) {
        console.warn(`[eip-3009] WARNING: only ${secsRemaining}s until validBefore expires — tx may revert`);
      }

      const iface = new ethers.Interface([
        'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
      ]);

      const callData = iface.encodeFunctionData('transferWithAuthorization', [
        from, to, amount,
        validAfter,
        validBefore,
        signature.nonce,
        signature.v, signature.r, signature.s,
      ]);

      const settlement = this.fireblocksFactory.get(scope, chainId);
      const result = await settlement.contractCall(
        tokenAddress,
        callData,
        'x402 EIP-3009 settlement',
        onSettlementTxId,
        { idempotencyKey: paymentId },
      );

      console.log(`[eip-3009] Confirmed: ${result.txHash} block=${result.blockNumber}`);

      return {
        success: true,
        transactionHash: result.txHash,
        blockNumber: result.blockNumber,
      };
    } catch (error) {
      console.error('[eip-3009] Settlement error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
