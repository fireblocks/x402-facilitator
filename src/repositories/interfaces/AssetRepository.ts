/**
 * Asset — a Fireblocks-native payment asset (e.g. USDC_BASE) plus the
 * x402-specific metadata needed to build payment requirements, verify
 * signatures, and quote USD → asset amounts.
 *
 * Assets are global — the same token contract has the same metadata
 * regardless of which merchant is accepting it. No TenantScope here.
 */

export interface Asset {
  assetId: string;
  /** Fireblocks blockchain UUID — canonical link to the blockchains catalog. */
  blockchainId: string;
  address: string;
  decimals: number;
  /** Cached EIP-155 numeric chain id, populated from Fireblocks at import. */
  chainId: number;
  eip712Name: string;
  eip712Version: string;
  transferMechanism: string;
  /**
   * Testnet vs mainnet, sourced from Fireblocks' `blockchain.onchain.test`
   * at import time. Drives the X402_ALLOW_MAINNET policy at boot.
   */
  isTestnet: boolean;
  stable: boolean;
  priceSymbol: string | null;
}

export interface AssetRepository {
  get(assetId: string): Asset | undefined;
  list(): Asset[];
}
