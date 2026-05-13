/**
 * Fireblocks Settlement Service
 *
 * Submits on-chain contract calls directly via the Fireblocks SDK,
 * bypassing the Web3Provider + RPC dependency. Fireblocks handles
 * gas estimation, transaction broadcast, and confirmation internally.
 */

import { FeeLevel, FireblocksSDK, PeerType, TransactionOperation, TransactionStatus } from 'fireblocks-sdk';
import { ethers } from 'ethers';
import { createFireblocksSdk } from './fireblocksClient';

/** Map EVM chain IDs to Fireblocks asset IDs (native chain asset, used
 *  as the `assetId` on CONTRACT_CALL — the token contract is the
 *  destination, not the asset). */
const CHAIN_TO_ASSET: Record<number, string> = {
  1: 'ETH',
  11155111: 'ETH_TEST5',
  8453: 'BASECHAIN_ETH',
  84532: 'BASECHAIN_ETH_TEST5',
};

/** Terminal transaction states — stop polling once reached */
const TERMINAL_STATES: TransactionStatus[] = [
  TransactionStatus.COMPLETED,
  TransactionStatus.FAILED,
  TransactionStatus.CANCELLED,
  TransactionStatus.BLOCKED,
  TransactionStatus.REJECTED,
];

const POLL_INTERVAL_MS = 2000;
/** Caps the live poll at ~5 minutes. Past this, the row keeps its
 *  fireblocksTxId and the reconciler resumes from Fireblocks's truth. */
const MAX_POLL_ATTEMPTS = 150;

export type FireblocksTxOutcome =
  | { kind: 'completed'; txHash: string; blockNumber: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'in_flight'; status: string; subStatus?: string };

export interface FireblocksSettlementConfig {
  apiKey: string;
  apiSecret: string;
  vaultAccountId: string;
  baseUrl?: string;
  chainId?: number;
}

export class FireblocksSettlementService {
  private sdk: FireblocksSDK;
  private vaultAccountId: string;
  private chainId: number;
  private assetId: string;

  constructor(config: FireblocksSettlementConfig) {
    this.sdk = createFireblocksSdk({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      baseUrl: config.baseUrl,
    });
    this.vaultAccountId = config.vaultAccountId;
    this.chainId = config.chainId || 8453;
    this.assetId = CHAIN_TO_ASSET[this.chainId] || `ETH`;
  }

  /**
   * Get the wallet address for this vault account on the configured chain.
   * Uses the Fireblocks SDK directly — no RPC needed.
   */
  async getWalletAddress(): Promise<string> {
    const addresses = await this.sdk.getDepositAddresses(this.vaultAccountId, this.assetId);
    if (!addresses || addresses.length === 0) {
      throw new Error(`No deposit address found for vault ${this.vaultAccountId}, asset ${this.assetId}`);
    }
    return addresses[0].address;
  }

  /**
   * Fetch the EVM deposit address of an arbitrary vault on this chain.
   * Used to resolve the merchant vault's payTo when it differs from
   * the broadcaster (facilitator) vault.
   */
  async getWalletAddressForVault(vaultId: string, assetId?: string): Promise<string> {
    const useAssetId = assetId ?? this.assetId;
    const addresses = await this.sdk.getDepositAddresses(vaultId, useAssetId);
    if (!addresses || addresses.length === 0) {
      throw new Error(`No deposit address found for vault ${vaultId}, asset ${useAssetId}`);
    }
    return addresses[0].address;
  }

  /**
   * Activate the configured chain's native asset on the vault (creates the
   * wallet and generates a deposit address) if it doesn't already exist.
   * Returns the freshly-created address.
   */
  async activateNativeAsset(): Promise<string> {
    const result = await this.sdk.createVaultAsset(this.vaultAccountId, this.assetId);
    return result.address;
  }

  /**
   * Ensure the vault has a wallet for the configured chain's native asset.
   * If missing, creates it. Returns the address either way.
   */
  async ensureWalletAddress(): Promise<{ address: string; created: boolean }> {
    try {
      const address = await this.getWalletAddress();
      return { address, created: false };
    } catch (err) {
      const msg = (err as Error).message;
      if (!/No deposit address/.test(msg)) throw err;
      const address = await this.activateNativeAsset();
      return { address, created: true };
    }
  }

  /**
   * Submit a contract call via Fireblocks and wait for on-chain confirmation.
   *
   * @param contractAddress - The target contract address
   * @param callData - ABI-encoded function call data (hex string starting with 0x)
   * @param note - Optional human-readable note for the Fireblocks transaction
   * @returns Transaction hash and block number
   */
  async contractCall(
    contractAddress: string,
    callData: string,
    note?: string,
    onTxId?: (fireblocksTxId: string) => Promise<void> | void,
    options?: { idempotencyKey?: string },
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { id, status } = await this.sdk.createTransaction(
      {
        operation: TransactionOperation.CONTRACT_CALL,
        assetId: this.assetId,
        source: {
          type: PeerType.VAULT_ACCOUNT,
          id: this.vaultAccountId,
        },
        destination: {
          type: PeerType.ONE_TIME_ADDRESS,
          oneTimeAddress: {
            address: contractAddress,
          },
        },
        amount: '0',
        // Fireblocks' default fee buffer on EIP-1559 networks is very
        // generous and can pre-flight-reject when the vault is lightly
        // funded (testnets). LOW is well above Sepolia/Base-Sepolia
        // basefees in practice and keeps the reserved max under control.
        feeLevel: FeeLevel.LOW,
        failOnLowFee: false,
        extraParameters: {
          contractCallData: callData,
        },
        note: note || 'x402 settlement',
      },
      // Per-payment idempotency: a retry of the same logical settlement
      // (network blip, process restart) reuses the existing Fireblocks
      // tx instead of submitting a second on-chain transaction.
      options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
    );

    console.log(`[fireblocks] Transaction created: ${id} (status: ${status})`);

    if (onTxId) {
      try {
        await onTxId(id);
      } catch (err) {
        console.error(`[fireblocks] onTxId callback failed for ${id}:`, err);
      }
    }

    // Poll for completion. Bounded so a stuck tx (PENDING_SIGNATURE,
    // QUEUED, BROADCASTING) can't hold the HTTP request handler open
    // indefinitely — the row keeps its fireblocksTxId and the
    // reconciler picks it up.
    let txInfo = await this.sdk.getTransactionById(id);
    let attempts = 0;
    while (!TERMINAL_STATES.includes(txInfo.status)) {
      if (++attempts >= MAX_POLL_ATTEMPTS) {
        throw new Error(
          `Fireblocks transaction ${id} did not reach terminal state after ` +
            `${MAX_POLL_ATTEMPTS} polls (last status: ${txInfo.status}` +
            `${txInfo.subStatus ? `, ${txInfo.subStatus}` : ''}). ` +
            `fireblocksTxId is persisted — reconcile via ` +
            `POST /api/admin/payments/<id>/sync.`,
        );
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      txInfo = await this.sdk.getTransactionById(id);
      console.log(`[fireblocks] Tx ${id}: ${txInfo.status}${txInfo.subStatus ? ` (${txInfo.subStatus})` : ''}`);
    }

    if (txInfo.status !== TransactionStatus.COMPLETED) {
      throw new Error(
        `Fireblocks transaction ${id} failed: ${txInfo.status}${txInfo.subStatus ? ` (${txInfo.subStatus})` : ''}`,
      );
    }

    console.log(`[fireblocks] Tx ${id} completed: ${txInfo.txHash}`);

    return {
      txHash: txInfo.txHash,
      blockNumber: txInfo.blockInfo?.blockHeight ? parseInt(txInfo.blockInfo.blockHeight, 10) : 0,
    };
  }

  /**
   * One-shot lookup of a Fireblocks transaction's current state, shaped
   * for reconciliation: callers get a tagged union covering completed,
   * failed, or still-in-flight — no need to know Fireblocks status enums.
   */
  async getTransactionOutcome(fireblocksTxId: string): Promise<FireblocksTxOutcome> {
    const info = await this.sdk.getTransactionById(fireblocksTxId);
    if (info.status === TransactionStatus.COMPLETED) {
      return {
        kind: 'completed',
        txHash: info.txHash,
        blockNumber: info.blockInfo?.blockHeight ? parseInt(info.blockInfo.blockHeight, 10) : 0,
      };
    }
    if (TERMINAL_STATES.includes(info.status)) {
      return {
        kind: 'failed',
        reason: `${info.status}${info.subStatus ? ` (${info.subStatus})` : ''}`,
      };
    }
    return { kind: 'in_flight', status: info.status, subStatus: info.subStatus };
  }

  /**
   * Refund an ERC-20 token amount back to a recipient.
   * Used by the escrow settlement strategy when the upstream fails after settlement.
   * Submits a CONTRACT_CALL to the token's transfer(to, amount) function.
   */
  async refund(
    tokenAddress: string,
    to: string,
    amount: bigint,
  ): Promise<{ txHash: string; blockNumber: number }> {
    const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const callData = iface.encodeFunctionData('transfer', [to, amount]);
    return this.contractCall(tokenAddress, callData, `x402 refund to ${to}`);
  }
}
