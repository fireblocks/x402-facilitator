/**
 * PriceProvider — converts a USD amount to an asset base-unit amount at
 * request time, using some external source.
 *
 * Implementations bundled:
 *   - StableOnlyPriceProvider   — only supports assets marked `stable: true`.
 *   - CoinGeckoPriceProvider    — free-tier CoinGecko, 30s in-memory cache.
 *   - CompositePriceProvider    — chain N providers; first hit wins.
 *
 * Swap in Chainlink / Pyth / merchant-owned by implementing this one iface.
 */

import { Asset } from '../../repositories/interfaces/AssetRepository';

export interface PriceQuote {
  /** Final amount the payer is asked for, in the asset's base units. */
  amountBaseUnits: bigint;
  /** USD per one whole unit of the asset used in the conversion. */
  priceUsd: number;
  /** When the price was fetched (for cache/staleness reasoning). */
  asOf: Date;
  /** Human-readable source ("stable", "coingecko:usd-coin", etc). */
  source: string;
}

export class PriceUnavailableError extends Error {
  constructor(
    public readonly assetId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

export interface PriceProvider {
  /**
   * Return the amount of `asset` (in base units) equal to `usdAmount`.
   * Throw PriceUnavailableError if no price can be produced — the
   * caller degrades gracefully (drops this asset from accepts[]).
   */
  quote(asset: Asset, usdAmount: number): Promise<PriceQuote>;
}

/**
 * Round a USD amount up to the nearest base unit of an asset.
 * Rounding UP protects merchant revenue from sub-unit fractional loss.
 */
export function usdToBaseUnits(usdAmount: number, pricePerUnit: number, decimals: number): bigint {
  if (pricePerUnit <= 0) {
    throw new Error(`Non-positive price: ${pricePerUnit}`);
  }
  const raw = (usdAmount / pricePerUnit) * Math.pow(10, decimals);
  // Round up; 1e-9 epsilon avoids float-noise cases like 99.9999999 → 100.
  return BigInt(Math.ceil(raw - 1e-9));
}
