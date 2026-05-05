export * from './PriceProvider';
export * from './StableOnlyPriceProvider';
export * from './CoinGeckoPriceProvider';
export * from './CompositePriceProvider';
export * from './GasCostEstimator';
export * from './PricingService';

import { PriceProvider } from './PriceProvider';
import { StableOnlyPriceProvider } from './StableOnlyPriceProvider';
import { CoinGeckoPriceProvider } from './CoinGeckoPriceProvider';
import { CompositePriceProvider } from './CompositePriceProvider';

/**
 * Default wiring:
 *   - Always-on StableOnly for 1:1 stablecoins (zero network cost).
 *   - CoinGecko on top for live-priced assets. Uses COINGECKO_API_KEY
 *     from env if present; falls through to the free tier otherwise.
 *
 * Swap this for a non-default stack by constructing your own
 * CompositePriceProvider.
 */
export function createDefaultPriceProvider(): PriceProvider {
  return new CompositePriceProvider([
    new StableOnlyPriceProvider(),
    new CoinGeckoPriceProvider(),
  ]);
}
