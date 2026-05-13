/**
 * Facilitator config — configuration-level settings for a tenant.
 * Single-tenant today: one FacilitatorConfig for the default scope.
 * Multi-tenant tomorrow: one config per (tenantId, configurationId).
 */

import { TenantScope } from '../../core/tenantScope';

export interface FireblocksConfig {
  apiKey: string;
  apiSecretPath: string;
  receiverVault: string;
  /** Vault that broadcasts settlement (msg.sender). Defaults to receiverVault. */
  facilitatorVault?: string;
  /** Vault whose address receives funds via payTo. Defaults to receiverVault. */
  merchantVault?: string;
  baseUrl: string;
  /**
   * Cached `getDepositAddresses(vault, asset_id)` results, keyed by
   * Fireblocks asset_id. Purely a cache — missing entries trigger a
   * runtime SDK call. Keys are asset_ids (e.g. `USDC_BASECHAIN_ETH_TEST5_8SH8`)
   * because Fireblocks models deposit addresses per-asset.
   */
  depositAddressCache: Record<string, string>;
}

export interface FacilitatorConfig {
  publicHost: string;
  fireblocks: FireblocksConfig;
}

export interface FacilitatorRepository {
  /**
   * Load the configuration for the given scope. Throws if none exists.
   */
  get(scope: TenantScope): FacilitatorConfig;

  reload(): void;
}
