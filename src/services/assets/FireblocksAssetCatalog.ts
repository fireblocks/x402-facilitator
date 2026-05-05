/**
 * FireblocksAssetCatalog — scope-aware source of chain-level asset facts
 * (contract address, decimals, EIP-155 chainId) for a given Fireblocks
 * asset_id.
 *
 * Swappable by design — if a richer catalog lands (with, e.g., EIP-712
 * domain hints or a stable-classification), implement a second version
 * of this interface and wire it in without changing call sites.
 */

import { TenantScope } from '../../core/tenantScope';

export interface FireblocksAssetHydration {
  /** Fireblocks opaque UUID. Accepted by `listAssets({ ids })`. */
  id: string;
  /**
   * Fireblocks legacy/human-readable id (e.g. `USDC_BASECHAIN_ETH_TEST5_8SH8`).
   * Use this for vault-level ops (`createVaultAsset`, `getDepositAddresses`,
   * `createTransaction`) — those endpoints are picky about the UUID form.
   */
  legacyId: string;
  /** Fireblocks blockchain UUID linking the asset to a chain. */
  blockchainId: string | null;
  /** Contract address (for ERC-20s) or null for native/gas assets. */
  address: string | null;
  decimals: number;
  /** EIP-155 numeric chain id; null if Fireblocks doesn't publish one (e.g. non-EVM). */
  chainId: number | null;
  /**
   * True if the asset's blockchain is a testnet (Fireblocks' own
   * `blockchain.onchain.test` flag). Null if Fireblocks didn't publish it.
   */
  isTestnet: boolean | null;
  /** Fireblocks' own display symbol — informational. */
  symbol: string;
  /** Fireblocks' own display name — informational, used to suggest eip712_name. */
  name: string;
  /** Fireblocks' asset class ('NATIVE' | 'FT' | 'FIAT' | 'NFT' | 'SFT'). */
  assetClass: string;
  /** Onchain standards list ('ERC20', etc). */
  standards: string[];
  deprecated: boolean;
}

export interface FireblocksAssetCatalog {
  /** Fetch hydration data for one asset_id in the given scope. */
  fetchAsset(scope: TenantScope, assetId: string): Promise<FireblocksAssetHydration>;
}

export class FireblocksAssetNotFoundError extends Error {
  constructor(
    public readonly assetId: string,
    public readonly scope: TenantScope,
  ) {
    super(
      `Fireblocks does not expose asset '${assetId}' to configuration '${scope.configurationId}'.`,
    );
    this.name = 'FireblocksAssetNotFoundError';
  }
}
