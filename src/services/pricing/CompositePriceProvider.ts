import { Asset } from '../../repositories/interfaces/AssetRepository';
import { PriceProvider, PriceQuote, PriceUnavailableError } from './PriceProvider';

/**
 * Try each provider in order. First non-error result wins. If all
 * throw PriceUnavailableError, aggregate reasons and re-throw.
 */
export class CompositePriceProvider implements PriceProvider {
  constructor(private readonly providers: PriceProvider[]) {}

  async quote(asset: Asset, usdAmount: number): Promise<PriceQuote> {
    const reasons: string[] = [];
    for (const p of this.providers) {
      try {
        return await p.quote(asset, usdAmount);
      } catch (err) {
        reasons.push((err as Error).message);
        if (!(err instanceof PriceUnavailableError)) {
          // Unknown error: do not fall through — surface immediately.
          throw err;
        }
      }
    }
    throw new PriceUnavailableError(
      asset.assetId,
      `No provider could price ${asset.assetId}: ${reasons.join(' | ')}`,
    );
  }
}
