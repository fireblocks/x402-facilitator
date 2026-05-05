import { Asset } from '../../repositories/interfaces/AssetRepository';
import {
  PriceProvider,
  PriceQuote,
  PriceUnavailableError,
  usdToBaseUnits,
} from './PriceProvider';

/**
 * Minimal built-in: prices only assets marked `stable: true` at 1:1 USD.
 * Rejects everything else with PriceUnavailableError so a Composite can
 * fall through to another provider.
 */
export class StableOnlyPriceProvider implements PriceProvider {
  async quote(asset: Asset, usdAmount: number): Promise<PriceQuote> {
    if (!asset.stable) {
      throw new PriceUnavailableError(
        asset.assetId,
        `Asset ${asset.assetId} is not stable; no oracle configured for live pricing.`,
      );
    }
    return {
      amountBaseUnits: usdToBaseUnits(usdAmount, 1, asset.decimals),
      priceUsd: 1,
      asOf: new Date(),
      source: 'stable',
    };
  }
}
