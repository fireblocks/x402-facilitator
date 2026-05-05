/**
 * Upto Scheme — Permit2 Transfer Mechanism
 *
 * Variable-amount settlement: client signs a maximum amount, facilitator settles
 * the actual consumed amount (which may be less). Uses Permit2 exclusively since
 * EIP-3009 requires fixed amounts.
 *
 * Key differences from exact Permit2:
 *   - Witness struct includes a `facilitator` field binding to the facilitator address
 *   - settle(amount) accepts actual charge amount, not the max
 *   - Zero settlement (amount = 0) requires no on-chain tx
 */

import { BaseMechanism, VerifyParams, VerifyResult, SettleParams, SettleResult, DEFAULT_SETTLE_SCOPE } from './TransferMechanism';
import { ethers } from 'ethers';

/** Canonical x402UptoPermit2Proxy address (CREATE2 deployed) */
export const X402_UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

/** Canonical Permit2 contract address (Uniswap) */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// EIP-712 types for Permit2 PermitWitnessTransferFrom with UptoWitness
const UPTO_PERMIT2_WITNESS_TYPES = {
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

// x402UptoPermit2Proxy ABI
const UPTO_PERMIT2_PROXY_ABI = [
  `function settle(
    uint256 amount,
    tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit,
    address owner,
    tuple(address to, address facilitator, uint256 validAfter) witness,
    bytes signature
  )`,
];

export class UptoPermit2Mechanism extends BaseMechanism {
  readonly name = 'upto-permit2';

  /**
   * Verify upto Permit2 witness signature off-chain.
   *
   * Expected params.message = upto permit2Authorization:
   *   { permitted: {token, amount}, from, spender, nonce, deadline, witness: {to, facilitator, validAfter} }
   */
  async verify(params: VerifyParams): Promise<VerifyResult> {
    try {
      const { chainId, message, signature, expectedAmount, expectedRecipient } = params;

      const permit2Auth = message as {
        permitted: { token: string; amount: string };
        from: string;
        spender: string;
        nonce: string;
        deadline: string;
        witness: { to: string; facilitator: string; validAfter: string };
      };

      if (!permit2Auth.permitted || !permit2Auth.from || !permit2Auth.witness) {
        return { valid: false, error: 'Missing required upto permit2Authorization fields' };
      }

      if (permit2Auth.permitted.token.toLowerCase() !== params.tokenAddress.toLowerCase()) {
        return {
          valid: false,
          error: `Token mismatch: permit authorizes ${permit2Auth.permitted.token}, expected ${params.tokenAddress}`,
        };
      }

      // Validate spender is the x402UptoPermit2Proxy
      if (permit2Auth.spender.toLowerCase() !== X402_UPTO_PERMIT2_PROXY.toLowerCase()) {
        return { valid: false, error: `Invalid spender: expected ${X402_UPTO_PERMIT2_PROXY}, got ${permit2Auth.spender}` };
      }

      // For upto, the authorized amount is the MAXIMUM — actual charge can be less
      const maxAmount = BigInt(permit2Auth.permitted.amount);
      if (maxAmount < expectedAmount) {
        return { valid: false, error: `Max authorized amount ${maxAmount} is less than expected ${expectedAmount}` };
      }

      // Validate recipient via witness
      if (permit2Auth.witness.to.toLowerCase() !== expectedRecipient.toLowerCase()) {
        return { valid: false, error: `Recipient mismatch: expected ${expectedRecipient}, got ${permit2Auth.witness.to}` };
      }

      // Check deadline
      const nowUnix = Math.floor(Date.now() / 1000);
      if (Number(permit2Auth.deadline) <= nowUnix) {
        return { valid: false, error: `Permit2 deadline expired: ${permit2Auth.deadline} <= ${nowUnix}` };
      }

      // Check validAfter
      if (Number(permit2Auth.witness.validAfter) > nowUnix) {
        return { valid: false, error: `Permit2 not yet valid: validAfter=${permit2Auth.witness.validAfter}` };
      }

      // Recover signer
      const domain = {
        name: 'Permit2',
        chainId,
        verifyingContract: PERMIT2_ADDRESS,
      };

      const eip712Message = {
        permitted: {
          token: permit2Auth.permitted.token,
          amount: permit2Auth.permitted.amount,
        },
        spender: permit2Auth.spender,
        nonce: permit2Auth.nonce,
        deadline: permit2Auth.deadline,
        witness: {
          to: permit2Auth.witness.to,
          facilitator: permit2Auth.witness.facilitator,
          validAfter: permit2Auth.witness.validAfter,
        },
      };

      const hash = ethers.TypedDataEncoder.hash(domain, UPTO_PERMIT2_WITNESS_TYPES, eip712Message);
      const recoveredSigner = ethers.recoverAddress(hash, {
        v: signature.v,
        r: signature.r,
        s: signature.s,
      });

      const expectedFrom = permit2Auth.from.toLowerCase();
      if (recoveredSigner.toLowerCase() !== expectedFrom) {
        return {
          valid: false,
          error: `Signature verification failed: recovered signer ${recoveredSigner} does not match expected sender ${expectedFrom}`,
        };
      }

      return { valid: true, signer: recoveredSigner };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid upto Permit2 signature format: ${error}`,
      };
    }
  }

  /**
   * Settle payment on-chain using x402UptoPermit2Proxy.settle(amount, ...).
   * The `amount` in params is the ACTUAL charge amount (not the max authorized).
   * If amount is 0, no on-chain tx is needed — the authorization expires unused.
   */
  async settle(params: SettleParams): Promise<SettleResult> {
    const { from, amount, tokenAddress, signature, chainId, onSettlementTxId, scope = DEFAULT_SETTLE_SCOPE, paymentId } = params;

    if (!signature) {
      return { success: false, error: 'Upto Permit2 authorization required' };
    }

    // Zero settlement — no on-chain tx needed
    if (amount === 0n) {
      console.log('[upto-permit2] Zero settlement — no on-chain tx needed');
      return { success: true, transactionHash: '', blockNumber: 0 };
    }

    const permit2Auth = signature as {
      nonce: string;
      deadline: string;
      permitted: { token: string; amount: string };
      witness: { to: string; facilitator: string; validAfter: string };
      v: number;
      r: string;
      s: string;
    };

    console.log(`[upto-permit2] Settling: ${tokenAddress} actualAmount=${amount} maxAuthorized=${permit2Auth.permitted?.amount}`);

    try {
      const signatureBytes = ethers.Signature.from({
        v: permit2Auth.v,
        r: permit2Auth.r,
        s: permit2Auth.s,
      }).serialized;

      const permit = {
        permitted: {
          token: permit2Auth.permitted.token,
          amount: permit2Auth.permitted.amount,
        },
        nonce: permit2Auth.nonce,
        deadline: permit2Auth.deadline,
      };

      const witness = {
        to: permit2Auth.witness.to,
        facilitator: permit2Auth.witness.facilitator,
        validAfter: permit2Auth.witness.validAfter,
      };

      const iface = new ethers.Interface(UPTO_PERMIT2_PROXY_ABI);
      const callData = iface.encodeFunctionData('settle', [amount, permit, from, witness, signatureBytes]);

      const settlement = this.fireblocksFactory.get(scope, chainId);
      const result = await settlement.contractCall(
        X402_UPTO_PERMIT2_PROXY,
        callData,
        'x402 upto-Permit2 settlement',
        onSettlementTxId,
        { idempotencyKey: paymentId },
      );

      console.log(`[upto-permit2] Confirmed: ${result.txHash} block=${result.blockNumber}`);

      return {
        success: true,
        transactionHash: result.txHash,
        blockNumber: result.blockNumber,
      };
    } catch (error) {
      console.error('[upto-permit2] Settlement error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
