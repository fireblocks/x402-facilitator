/**
 * Factory that caches FireblocksSettlementService instances per
 * (scope, chainId). Single-tenant today: all requests use DEFAULT_SCOPE.
 * Multi-tenant tomorrow: each scope has its own Fireblocks credentials
 * coming from the FacilitatorRepository, cached independently.
 */

import { FireblocksSettlementService } from './fireblocksSettlement';
import { FacilitatorRepository } from '../repositories/interfaces/FacilitatorRepository';
import { TenantScope, formatScope } from '../core/tenantScope';

export class FireblocksSettlementFactory {
  private services: Map<string, FireblocksSettlementService> = new Map();

  constructor(private readonly facilitator: FacilitatorRepository) {}

  /**
   * Get or construct the SETTLEMENT service for (scope, chainId).
   * Bound to the broadcaster vault (facilitator_vault ?? receiver_vault) —
   * that's the vault whose API user signs the on-chain settle tx.
   */
  get(scope: TenantScope, chainId?: number): FireblocksSettlementService {
    const fb = this.facilitator.get(scope).fireblocks;
    return this.getOrBuild('settle', scope, chainId, fb.facilitatorVault ?? fb.receiverVault);
  }

  /**
   * Get or construct the REFUND service for (scope, chainId).
   * Bound to the vault that actually holds the USDC after settlement —
   * merchant_vault if set (split-vault mode), else receiver_vault
   * (single-vault mode, where the broadcaster is also the receiver).
   *
   * Distinct from `get()` because in the gas-sponsored split-vault
   * topology the broadcaster vault holds no funds; refunding from it
   * would revert with insufficient balance.
   */
  getForRefund(scope: TenantScope, chainId?: number): FireblocksSettlementService {
    const fb = this.facilitator.get(scope).fireblocks;
    return this.getOrBuild('refund', scope, chainId, fb.merchantVault ?? fb.receiverVault);
  }

  private getOrBuild(
    role: 'settle' | 'refund',
    scope: TenantScope,
    chainId: number | undefined,
    vaultAccountId: string,
  ): FireblocksSettlementService {
    const key = `${role}|${formatScope(scope)}|${chainId ?? 'default'}|${vaultAccountId}`;
    const cached = this.services.get(key);
    if (cached) return cached;
    const fb = this.facilitator.get(scope).fireblocks;
    const service = new FireblocksSettlementService({
      apiKey: fb.apiKey,
      apiSecret: fb.apiSecretPath,
      vaultAccountId,
      baseUrl: fb.baseUrl,
      chainId,
    });
    this.services.set(key, service);
    return service;
  }

  clear(): void {
    this.services.clear();
  }
}
