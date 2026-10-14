/**
 * Transfer Mechanism Interface
 *
 * Defines the contract for different payment transfer mechanisms in x402.
 *
 * - eip-3009: For tokens with native transferWithAuthorization (e.g. USDC)
 * - permit2 / upto-permit2: Universal fallback for any ERC-20 via Uniswap Permit2
 * - erc7710: Delegation-based flow
 */

import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';
import { FireblocksPollTimeoutError } from '../services/fireblocksSettlement';
import { TenantScope, DEFAULT_SCOPE } from '../core/tenantScope';

export interface VerifyParams {
  tokenAddress: string;
  tokenName: string;
  tokenVersion: string;
  chainId: number;
  message: any;
  signature: any;
  expectedAmount: bigint;
  expectedRecipient: string;
  provider: any;
}

export interface VerifyResult {
  valid: boolean;
  signer?: string;
  error?: string;
}

export interface SettleParams {
  /**
   * Scope the settlement runs in — determines which FireblocksSettlementService
   * (i.e. which credentials) the mechanism will use. Defaults to DEFAULT_SCOPE
   * for convenience in single-tenant setups.
   */
  scope?: TenantScope;
  paymentId: string;
  from: string;
  to: string;
  amount: bigint;
  tokenAddress: string;
  signature: any;
  chainId?: number;
  /**
   * Invoked once Fireblocks accepts the settlement transaction and
   * hands back its internal tx id. Fires before the poll loop starts —
   * lets the caller persist the id synchronously so a crash during
   * polling leaves behind something the reconciler can find.
   */
  onSettlementTxId?: (fireblocksTxId: string) => Promise<void> | void;
}

export const DEFAULT_SETTLE_SCOPE = DEFAULT_SCOPE;

export interface SettleResult {
  success: boolean;
  transactionHash?: string;
  blockNumber?: number;
  error?: string;
  /**
   * Set when `error` comes from a `FireblocksPollTimeoutError`: Fireblocks
   * accepted the transaction (see `fireblocksTxId`) but it hasn't reached
   * a terminal state within the live poll window. Distinct from a
   * genuine failure — the settlement may still land, and the reconciler
   * will resolve it. Callers (the `/settle` route) should surface this
   * as pending rather than a flat failure.
   */
  pending?: boolean;
  fireblocksTxId?: string;
}

/**
 * Shared catch-block conversion for every mechanism's `settle()`: logs
 * the error, then distinguishes a poll-cap timeout (pending, tx may
 * still land) from any other settlement failure.
 */
export function settleResultFromError(error: unknown, logPrefix: string): SettleResult {
  console.error(`${logPrefix} Settlement error:`, error);
  if (error instanceof FireblocksPollTimeoutError) {
    return {
      success: false,
      pending: true,
      fireblocksTxId: error.fireblocksTxId,
      error: error.message,
    };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  };
}

export interface TransferMechanism {
  readonly name: string;
  verify(params: VerifyParams): Promise<VerifyResult>;
  settle(params: SettleParams): Promise<SettleResult>;
}

export abstract class BaseMechanism implements TransferMechanism {
  constructor(protected fireblocksFactory: FireblocksSettlementFactory) {}

  abstract readonly name: string;
  abstract verify(params: VerifyParams): Promise<VerifyResult>;
  abstract settle(params: SettleParams): Promise<SettleResult>;
}
