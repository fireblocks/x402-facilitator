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
   * Get or construct the settlement service for (scope, chainId).
   */
  get(scope: TenantScope, chainId?: number): FireblocksSettlementService {
    const key = `${formatScope(scope)}|${chainId ?? 'default'}`;
    const cached = this.services.get(key);
    if (cached) return cached;
    const service = this.build(scope, chainId);
    this.services.set(key, service);
    return service;
  }

  private build(scope: TenantScope, chainId?: number): FireblocksSettlementService {
    const fb = this.facilitator.get(scope).fireblocks;
    return new FireblocksSettlementService({
      apiKey: fb.apiKey,
      apiSecret: fb.apiSecretPath,
      vaultAccountId: fb.receiverVault,
      baseUrl: fb.baseUrl,
      chainId,
    });
  }

  clear(): void {
    this.services.clear();
  }
}
