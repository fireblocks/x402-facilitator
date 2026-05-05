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
