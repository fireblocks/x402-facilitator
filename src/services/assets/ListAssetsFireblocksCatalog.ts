/**
 * Catalog backed by `fireblocks.listAssets()` + `fireblocks.listBlockchains()`.
 *
 * The asset endpoint gives us contract address + decimals + a blockchainId;
 * we need a second hop to the blockchain endpoint to map that blockchainId
 * to the EIP-155 numeric chainId we use internally. Blockchain records are
 * cached in-process for 24h — they don't change.
 */

import { FireblocksSDK, ListAssetResponse, ListBlockchainResponse } from 'fireblocks-sdk';
import { FacilitatorRepository } from '../../repositories/interfaces/FacilitatorRepository';
import { TenantScope, formatScope } from '../../core/tenantScope';
import { createFireblocksSdkFromConfig } from '../fireblocksClient';
import {
  FireblocksAssetCatalog,
  FireblocksAssetHydration,
  FireblocksAssetNotFoundError,
} from './FireblocksAssetCatalog';

const BLOCKCHAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Fireblocks' listBlockchains endpoint rejects pageSize=1000 (accepts a
// smaller range than listAssets). 500 is the observed ceiling; today
// there are ~300 blockchains total so one page covers it.
const BLOCKCHAIN_PAGE_SIZE = 500;

interface CachedBlockchains {
  byId: Map<string, ListBlockchainResponse>;
  fetchedAt: number;
}

export class ListAssetsFireblocksCatalog implements FireblocksAssetCatalog {
  private sdkCache = new Map<string, FireblocksSDK>();
  private blockchainCache = new Map<string, CachedBlockchains>();

  constructor(private readonly facilitator: FacilitatorRepository) {}

  async fetchAsset(scope: TenantScope, assetId: string): Promise<FireblocksAssetHydration> {
    const sdk = this.sdkFor(scope);
    let res;
    try {
      res = await sdk.listAssets({ ids: [assetId] });
    } catch (err) {
      throw new Error(
        `Fireblocks listAssets failed for '${assetId}' in ${formatScope(scope)}: ${(err as Error).message}`,
      );
    }
    const match = res.data.find((a) => a.id === assetId || a.legacyId === assetId);
    if (!match) throw new FireblocksAssetNotFoundError(assetId, scope);
    const { chainId, isTestnet } = match.blockchainId
      ? await this.resolveBlockchainFacts(scope, match.blockchainId)
      : { chainId: null, isTestnet: null };
    return toDomain(match, chainId, isTestnet);
  }

  private sdkFor(scope: TenantScope): FireblocksSDK {
    const key = formatScope(scope);
    const cached = this.sdkCache.get(key);
    if (cached) return cached;
    const sdk = createFireblocksSdkFromConfig(this.facilitator.get(scope).fireblocks);
    this.sdkCache.set(key, sdk);
    return sdk;
  }

  private async resolveBlockchainFacts(
    scope: TenantScope,
    blockchainId: string,
  ): Promise<{ chainId: number | null; isTestnet: boolean | null }> {
    const cache = await this.loadBlockchains(scope);
    const bc = cache.byId.get(blockchainId);
    const rawChainId = bc?.onchain?.chainId;
    let chainId: number | null = null;
    if (rawChainId) {
      const asNumber = Number(rawChainId);
      if (Number.isFinite(asNumber)) chainId = asNumber;
    }
    const rawTest = (bc?.onchain as { test?: boolean } | undefined)?.test;
    const isTestnet = typeof rawTest === 'boolean' ? rawTest : null;
    return { chainId, isTestnet };
  }

  private async loadBlockchains(scope: TenantScope): Promise<CachedBlockchains> {
    const key = formatScope(scope);
    const cached = this.blockchainCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < BLOCKCHAIN_CACHE_TTL_MS) {
      return cached;
    }
    const sdk = this.sdkFor(scope);
    const byId = new Map<string, ListBlockchainResponse>();
    let cursor: string | null | undefined = undefined;
    // Page through everything; we want the full id→chainId mapping.
    do {
      const res = await sdk.listBlockchains({
        pageSize: BLOCKCHAIN_PAGE_SIZE,
        pageCursor: cursor || undefined,
      });
      for (const b of res.data) byId.set(b.id, b);
      cursor = res.next;
    } while (cursor);
    const fresh = { byId, fetchedAt: Date.now() };
    this.blockchainCache.set(key, fresh);
    return fresh;
  }
}

function toDomain(
  res: ListAssetResponse,
  chainId: number | null,
  isTestnet: boolean | null,
): FireblocksAssetHydration {
  return {
    id: res.id,
    legacyId: res.legacyId,
    blockchainId: res.blockchainId ?? null,
    address: res.onchain?.address ?? null,
    decimals: res.onchain?.decimals ?? 0,
    chainId,
    isTestnet,
    symbol: res.onchain?.symbol ?? res.displaySymbol,
    name: res.onchain?.name ?? res.displayName,
    assetClass: res.assetClass,
    standards: res.onchain?.standards ?? [],
    deprecated: res.metadata?.deprecated ?? false,
  };
}
