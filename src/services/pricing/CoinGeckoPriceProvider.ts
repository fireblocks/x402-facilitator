import { Asset } from '../../repositories/interfaces/AssetRepository';
import {
  PriceProvider,
  PriceQuote,
  PriceUnavailableError,
  usdToBaseUnits,
} from './PriceProvider';

interface CacheEntry {
  priceUsd: number;
  asOf: Date;
}

export interface CoinGeckoPriceProviderOptions {
  /** Opt-in CoinGecko API key (Pro tier). Free tier works without. */
  apiKey?: string;
  /** How long to serve cached prices before re-fetching (default 30s). */
  ttlMs?: number;
  /**
   * Serve a cached price this much older than `ttlMs` if the live call
   * fails. Set to 0 to never serve stale. Default 5m.
   */
  staleGraceMs?: number;
  /** Override the base URL (useful for tests or self-hosted proxies). */
  baseUrl?: string;
}

/**
 * CoinGecko-backed PriceProvider.
 *
 * Uses the /simple/price endpoint keyed by an asset's `priceSymbol`
 * (CoinGecko "coin id", e.g. "ethereum", "usd-coin"). Assets without a
 * priceSymbol are rejected — the caller is expected to chain with
 * StableOnlyPriceProvider via CompositePriceProvider.
 */
export class CoinGeckoPriceProvider implements PriceProvider {
  private readonly ttlMs: number;
  private readonly staleGraceMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: CoinGeckoPriceProviderOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.staleGraceMs = opts.staleGraceMs ?? 5 * 60_000;
    this.baseUrl = opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
    this.apiKey = opts.apiKey ?? process.env.COINGECKO_API_KEY ?? null;
  }

  async quote(asset: Asset, usdAmount: number): Promise<PriceQuote> {
    if (!asset.priceSymbol) {
      throw new PriceUnavailableError(
        asset.assetId,
        `Asset ${asset.assetId} has no price_symbol; CoinGecko provider cannot price it.`,
      );
    }
    const price = await this.resolvePrice(asset.priceSymbol);
    return {
      amountBaseUnits: usdToBaseUnits(usdAmount, price.priceUsd, asset.decimals),
      priceUsd: price.priceUsd,
      asOf: price.asOf,
      source: `coingecko:${asset.priceSymbol}`,
    };
  }

  private async resolvePrice(symbol: string): Promise<CacheEntry> {
    const cached = this.cache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.asOf.getTime() < this.ttlMs) {
      return cached;
    }
    try {
      const fresh = await this.fetchPrice(symbol);
      this.cache.set(symbol, fresh);
      return fresh;
    } catch (err) {
      if (cached && now - cached.asOf.getTime() < this.ttlMs + this.staleGraceMs) {
        console.warn(
          `[coingecko] live fetch for ${symbol} failed (${(err as Error).message}); serving stale ${
            (now - cached.asOf.getTime()) / 1000
          }s`,
        );
        return cached;
      }
      throw new PriceUnavailableError(
        symbol,
        `CoinGecko lookup for ${symbol} failed: ${(err as Error).message}`,
      );
    }
  }

  private async fetchPrice(symbol: string): Promise<CacheEntry> {
    const url = new URL('/api/v3/simple/price', this.baseUrl.replace(/\/api\/v3$/, ''));
    url.searchParams.set('ids', symbol);
    url.searchParams.set('vs_currencies', 'usd');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-cg-pro-api-key'] = this.apiKey;
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const priceUsd = body[symbol]?.usd;
    if (typeof priceUsd !== 'number' || priceUsd <= 0) {
      throw new Error(`No usd price for ${symbol}`);
    }
    return { priceUsd, asOf: new Date() };
  }
}
