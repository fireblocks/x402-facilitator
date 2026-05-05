/**
 * Permit2 Transfer Mechanism (Exact Scheme)
 *
 * Universal fallback for any ERC-20 token using Uniswap's Permit2 contract
 * and an x402ExactPermit2Proxy contract to enforce recipient binding via
 * a witness pattern.
 *
 * Flow:
 *   1. Client signs Permit2 PermitWitnessTransferFrom with Witness{to, validAfter}
 *   2. Facilitator verifies signature off-chain (recover signer from EIP-712 hash)
 *   3. Facilitator calls x402ExactPermit2Proxy.settle() on-chain
 */

import { BaseMechanism, VerifyParams, VerifyResult, SettleParams, SettleResult, DEFAULT_SETTLE_SCOPE } from './TransferMechanism';
import { ethers } from 'ethers';

/** Canonical x402ExactPermit2Proxy address (CREATE2 deployed) */
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

/** Canonical Permit2 contract address (Uniswap) */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// EIP-712 types for Permit2 PermitWitnessTransferFrom with Witness
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

// x402ExactPermit2Proxy ABI (settle function)
const EXACT_PERMIT2_PROXY_ABI = [
  `function settle(
    tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit,
    address owner,
    tuple(address to, uint256 validAfter) witness,
    bytes signature
  )`,
  `function settleWithPermit(
    tuple(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline) permit2612,
    tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit,
    address owner,
    tuple(address to, uint256 validAfter) witness,
    bytes signature
  )`,
];

export class Permit2Mechanism extends BaseMechanism {
  readonly name = 'permit2';

  /**
   * Verify Permit2 witness signature off-chain.
   * Recovers signer from EIP-712 typed data hash, validates amount and recipient.
   *
   * Expected params.message = permit2Authorization object:
   *   { permitted: { token, amount }, from, spender, nonce, deadline, witness: { to, validAfter } }
   * Expected params.signature = { v, r, s } (already split by caller)
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
        witness: { to: string; validAfter: string };
      };

      // Validate required fields
      if (!permit2Auth.permitted || !permit2Auth.from || !permit2Auth.witness) {
        return { valid: false, error: 'Missing required permit2Authorization fields' };
      }

      // Validate the permit authorizes the exact token we're settling.
      // Otherwise a permit for token A could be replayed in a payment
      // for asset B (e.g. cross-chain identical addresses, misconfigured
      // product) and pull the wrong asset on-chain.
      if (permit2Auth.permitted.token.toLowerCase() !== params.tokenAddress.toLowerCase()) {
        return {
          valid: false,
          error: `Token mismatch: permit authorizes ${permit2Auth.permitted.token}, expected ${params.tokenAddress}`,
        };
      }

      // Validate spender is the x402ExactPermit2Proxy
      if (permit2Auth.spender.toLowerCase() !== X402_EXACT_PERMIT2_PROXY.toLowerCase()) {
        return { valid: false, error: `Invalid spender: expected ${X402_EXACT_PERMIT2_PROXY}, got ${permit2Auth.spender}` };
      }

      // Validate amount
      const authorizedAmount = BigInt(permit2Auth.permitted.amount);
      if (authorizedAmount < expectedAmount) {
        return { valid: false, error: `Amount mismatch: expected ${expectedAmount}, got ${authorizedAmount}` };
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
        return { valid: false, error: `Permit2 not yet valid: validAfter=${permit2Auth.witness.validAfter} > now=${nowUnix}` };
      }

      // Recover signer from EIP-712 hash
      const domain = {
        name: 'Permit2',
        chainId,
        verifyingContract: PERMIT2_ADDRESS,
      };

      // Build the message for EIP-712 hashing (PermitWitnessTransferFrom)
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
          validAfter: permit2Auth.witness.validAfter,
        },
      };

      const hash = ethers.TypedDataEncoder.hash(domain, PERMIT2_WITNESS_TYPES, eip712Message);
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
        error: `Invalid Permit2 signature format: ${error}`,
      };
    }
  }

  /**
   * Settle payment on-chain using x402ExactPermit2Proxy.settle().
   * Calls the proxy contract which enforces recipient binding via witness.
   */
  async settle(params: SettleParams): Promise<SettleResult> {
    const { from, tokenAddress, signature, chainId, onSettlementTxId, scope = DEFAULT_SETTLE_SCOPE, paymentId } = params;

    if (!signature) {
      return { success: false, error: 'Permit2 authorization required' };
    }

    // signature object has permit2Authorization fields merged in
    const permit2Auth = signature as {
      nonce: string;
      deadline: string;
      permitted: { token: string; amount: string };
      witness: { to: string; validAfter: string };
      v: number;
      r: string;
      s: string;
    };

    console.log(`[permit2] Settling: ${tokenAddress} amount=${permit2Auth.permitted?.amount}`);

    try {
      const nowUnix = Math.floor(Date.now() / 1000);
      const secsRemaining = Number(permit2Auth.deadline) - nowUnix;
      console.log(`[permit2] deadline=${permit2Auth.deadline} now=${nowUnix} remaining=${secsRemaining}s`);
      if (secsRemaining < 30) {
        console.warn(`[permit2] WARNING: only ${secsRemaining}s until deadline expires — tx may revert`);
      }

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
        validAfter: permit2Auth.witness.validAfter,
      };

      const iface = new ethers.Interface(EXACT_PERMIT2_PROXY_ABI);
      const callData = iface.encodeFunctionData('settle', [permit, from, witness, signatureBytes]);

      const settlement = this.fireblocksFactory.get(scope, chainId);
      const result = await settlement.contractCall(
        X402_EXACT_PERMIT2_PROXY,
        callData,
        'x402 Permit2 settlement',
        onSettlementTxId,
        { idempotencyKey: paymentId },
      );

      console.log(`[permit2] Confirmed: ${result.txHash} block=${result.blockNumber}`);

      return {
        success: true,
        transactionHash: result.txHash,
        blockNumber: result.blockNumber,
      };
    } catch (error) {
      console.error('[permit2] Settlement error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
