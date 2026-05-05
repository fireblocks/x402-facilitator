/**
 * ERC-7710 Delegation Transfer Mechanism
 *
 * Uses smart contract delegation for accounts that support ERC-4337/ERC-7579
 * modular accounts. Verification is purely simulation-based — there is no
 * off-chain signature recovery. Instead, we simulate the delegation redemption
 * call on-chain to validate it would succeed.
 *
 * Flow:
 *   1. Client provides permissionContext (opaque delegation proof)
 *   2. Facilitator simulates redeemDelegations() on DelegationManager
 *   3. If simulation succeeds, call redeemDelegations() for real
 */

import { BaseMechanism, VerifyParams, VerifyResult, SettleParams, SettleResult, DEFAULT_SETTLE_SCOPE } from './TransferMechanism';
import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';
import { ethers } from 'ethers';

/** Returns a configured RPC provider for the given chain, or null when
 *  the operator hasn't wired one up. The mechanism rejects verify when
 *  null — never silently accept. */
export type ProviderFactory = (chainId: number) => ethers.Provider | null;

/**
 * Canonical MetaMask Delegation Framework (MDF) addresses.
 *
 * These are CREATE2 deterministic deployments — identical on every
 * chain where MDF has been bootstrapped (Ethereum mainnet + major L2s
 * + Sepolia + Base Sepolia + Polygon Amoy + etc). Verified live on
 * Ethereum Sepolia and Base Sepolia.
 *
 * Source: MetaMask/delegation-framework repo, broadcast artifacts for
 *         DeployDelegationFramework.s.sol and
 *         DeployEIP7702StatelessDeleGator.s.sol (run-latest.json per chain).
 */
export const MDF_DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
export const MDF_EIP7702_STATELESS_DELEGATOR = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
export const MDF_HYBRID_DELEGATOR = '0x48dbe696a4d990079e039489ba2053b36e8ffec4';

/** Allowlist of DelegationManager addresses we will dispatch on-chain
 *  CONTRACT_CALLs to. Without this, a client could substitute any
 *  contract address for `delegation.delegationManager` and have
 *  Fireblocks call it from the operator's vault. */
const ALLOWED_DELEGATION_MANAGERS: ReadonlySet<string> = new Set([
  MDF_DELEGATION_MANAGER.toLowerCase(),
]);

// DelegationManager ABI (redeemDelegations function)
const DELEGATION_MANAGER_ABI = [
  `function redeemDelegations(
    bytes[] calldata delegationProofs,
    bytes32[] calldata modes,
    bytes[] calldata executionCallData
  )`,
];

// ERC-20 transfer ABI for encoding execution calldata
const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ERC-7579 single execution mode
const SINGLE_EXECUTION_MODE = ethers.zeroPadValue('0x00', 32);

export class Erc7710Mechanism extends BaseMechanism {
  readonly name = 'erc7710';

  constructor(
    fireblocksFactory: FireblocksSettlementFactory,
    private readonly providerFactory?: ProviderFactory,
  ) {
    super(fireblocksFactory);
  }

  /**
   * Verify ERC-7710 delegation via simulation.
   * Simulates redeemDelegations() to check if the delegation is valid.
   *
   * Expected params.message = delegation payload:
   *   { delegationManager, permissionContext, delegator }
   */
  async verify(params: VerifyParams): Promise<VerifyResult> {
    try {
      const { tokenAddress, chainId, message, expectedAmount, expectedRecipient, provider: providerParam } = params;

      const delegation = message as {
        delegationManager: string;
        permissionContext: string;
        delegator: string;
      };

      if (!delegation.delegationManager || !delegation.permissionContext || !delegation.delegator) {
        return { valid: false, error: 'Missing required ERC-7710 delegation fields' };
      }

      // Defence in depth — never dispatch CONTRACT_CALL against a
      // delegationManager we haven't reviewed. Mirrors the check in settle().
      if (!ALLOWED_DELEGATION_MANAGERS.has(delegation.delegationManager.toLowerCase())) {
        return {
          valid: false,
          error: `Unknown delegationManager: ${delegation.delegationManager}`,
        };
      }

      // Resolve a provider: caller-supplied wins, fall back to the
      // mechanism's configured factory. No provider → reject; we will
      // not optimistic-accept a delegation we cannot simulate.
      const provider = providerParam || this.providerFactory?.(chainId) || null;
      if (!provider) {
        return {
          valid: false,
          error:
            `ERC-7710 simulation requires an RPC provider for chainId=${chainId}. ` +
            `Set X402_RPC_URL_${chainId} (or the configured equivalent) on the facilitator process.`,
        };
      }

      // Encode the ERC-20 transfer call
      const erc20Interface = new ethers.Interface(ERC20_TRANSFER_ABI);
      const transferCallData = erc20Interface.encodeFunctionData('transfer', [
        expectedRecipient,
        expectedAmount,
      ]);

      // ERC-7579 single-mode execution: bytes.concat(target, value, callData)
      // (packed layout, NOT abi.encode — the DeleGator's decoder slices at
      //  fixed offsets 0..20 for target, 20..52 for value, 52..end for data).
      const executionCallData = ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [tokenAddress, 0, transferCallData],
      );

      // Simulate redeemDelegations
      const delegationManager = new ethers.Contract(
        delegation.delegationManager,
        DELEGATION_MANAGER_ABI,
        provider,
      );

      try {
        await delegationManager.redeemDelegations.staticCall(
          [delegation.permissionContext],
          [SINGLE_EXECUTION_MODE],
          [executionCallData],
          { gasLimit: 500_000 },
        );
        return { valid: true, signer: delegation.delegator };
      } catch (simError) {
        return {
          valid: false,
          error: `Delegation simulation failed: ${simError instanceof Error ? simError.message : simError}`,
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: `ERC-7710 verification error: ${error}`,
      };
    }
  }

  /**
   * Settle via ERC-7710 delegation redemption.
   * Calls delegationManager.redeemDelegations() via Fireblocks.
   */
  async settle(params: SettleParams): Promise<SettleResult> {
    const { to, amount, tokenAddress, signature, chainId, onSettlementTxId, scope = DEFAULT_SETTLE_SCOPE, paymentId } = params;

    if (!signature) {
      return { success: false, error: 'ERC-7710 delegation payload required' };
    }

    const delegation = signature as {
      delegationManager: string;
      permissionContext: string;
      delegator: string;
    };

    if (!ALLOWED_DELEGATION_MANAGERS.has(delegation.delegationManager.toLowerCase())) {
      return {
        success: false,
        error: `Refusing to settle against unknown delegationManager: ${delegation.delegationManager}`,
      };
    }

    console.log(`[erc7710] Settling: ${tokenAddress} amount=${amount} delegator=${delegation.delegator}`);

    try {
      // Encode ERC-20 transfer
      const erc20Interface = new ethers.Interface(ERC20_TRANSFER_ABI);
      const transferCallData = erc20Interface.encodeFunctionData('transfer', [to, amount]);

      const executionCallData = ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [tokenAddress, 0, transferCallData],
      );

      const iface = new ethers.Interface(DELEGATION_MANAGER_ABI);
      const callData = iface.encodeFunctionData('redeemDelegations', [
        [delegation.permissionContext],
        [SINGLE_EXECUTION_MODE],
        [executionCallData],
      ]);

      const settlement = this.fireblocksFactory.get(scope, chainId);
      const result = await settlement.contractCall(
        delegation.delegationManager,
        callData,
        'x402 ERC-7710 settlement',
        onSettlementTxId,
        { idempotencyKey: paymentId },
      );

      console.log(`[erc7710] Confirmed: ${result.txHash} block=${result.blockNumber}`);

      return {
        success: true,
        transactionHash: result.txHash,
        blockNumber: result.blockNumber,
      };
    } catch (error) {
      console.error('[erc7710] Settlement error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
