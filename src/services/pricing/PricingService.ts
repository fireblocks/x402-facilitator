/**
 * PricingService — the orchestrator between a Product and its final
 * `accepts[]` array.
 *
 * For each row in product.pricing[]:
 *   1. Look up the Asset in the current scope.
 *   2. If the row has an explicit amount, use it verbatim.
 *   3. Otherwise, convert product.usdPrice via the PriceProvider.
 *   4. (Placeholder) Adjust for chain-specific gas cost via
 *      GasCostEstimator. Today this is a no-op; future policies can
 *      gross up the quote or drop uneconomic chains.
 *   5. On failure, skip the row (graceful degradation) and record the
 *      reason; the merchant gets a partial accepts[] with only the
 *      assets that could be quoted.
 */

import { AssetRepository, Asset } from '../../repositories/interfaces/AssetRepository';
import { Product } from '../../repositories/interfaces/ProductRepository';
import { TenantScope } from '../../core/tenantScope';
import { PriceProvider, PriceUnavailableError } from './PriceProvider';
import { GasCostEstimator, GasCostPolicy } from './GasCostEstimator';

export interface QuotedAsset {
  asset: Asset;
  /**
   * The mechanism this quote is offered under — either the pricing
   * row's override (for multi-mechanism offers on the same asset) or
   * the asset's default.
   */
  mechanism: string;
  amountBaseUnits: bigint;
  /** Null when the row was native-denominated (no USD involved). */
  priceUsd: number | null;
  pricedAt: Date | null;
  /** Placeholder — always 0 today. */
  gasCostUsd: number;
  source: string;
}

export interface RejectedAsset {
  assetId: string;
  reason: string;
}

export interface QuoteResult {
  quotes: QuotedAsset[];
  rejected: RejectedAsset[];
}

export interface PricingServiceOptions {
  /** Gas-cost policy today is a placeholder; default 'ignore'. */
  gasCostPolicy?: GasCostPolicy;
}

export class PricingService {
  private readonly gasCostPolicy: GasCostPolicy;

  constructor(
    private readonly assets: AssetRepository,
    private readonly priceProvider: PriceProvider,
    private readonly gasEstimator: GasCostEstimator,
    opts: PricingServiceOptions = {},
  ) {
    this.gasCostPolicy = opts.gasCostPolicy ?? 'ignore';
  }

  async quoteProduct(scope: TenantScope, product: Product): Promise<QuoteResult> {
    const quotes: QuotedAsset[] = [];
    const rejected: RejectedAsset[] = [];

    for (const row of product.pricing) {
      const asset = this.assets.get(row.assetId);
      if (!asset) {
        rejected.push({
          assetId: row.assetId,
          reason: `Asset '${row.assetId}' not found in global catalog`,
        });
        continue;
      }
      const mechanism = row.transferMechanism ?? asset.transferMechanism;

      try {
        if (row.amount !== null && row.amount !== undefined) {
          quotes.push({
            asset,
            mechanism,
            amountBaseUnits: BigInt(Math.ceil(row.amount)),
            priceUsd: null,
            pricedAt: null,
            gasCostUsd: 0,
            source: 'native',
          });
          continue;
        }

        if (product.usdPrice === null) {
          rejected.push({
            assetId: row.assetId,
            reason: 'No amount set and product has no usd_price to convert from',
          });
          continue;
        }

        // ── Placeholder: chain-aware gas adjustment ─────────────────
        // Today this returns 0 regardless of chain. When a real
        // GasCostEstimator lands, branch on `this.gasCostPolicy`:
        //   - 'ignore'             : effectiveUsd = product.usdPrice
        //   - 'add-to-quote'       : effectiveUsd = product.usdPrice + gas.usdCost
        //   - 'reject-if-above-pct': drop if gas/usdPrice above threshold
        const gas = await this.gasEstimator.estimate(asset.chainId, asset.transferMechanism);
        let effectiveUsd = product.usdPrice;
        if (this.gasCostPolicy === 'add-to-quote' && gas.usdCost > 0) {
          effectiveUsd += gas.usdCost;
        }
        // 'reject-if-above-pct' would need a threshold config — deferred
        // until the estimator actually returns non-zero values.

        const quote = await this.priceProvider.quote(asset, effectiveUsd);
        quotes.push({
          asset,
          mechanism,
          amountBaseUnits: quote.amountBaseUnits,
          priceUsd: quote.priceUsd,
          pricedAt: quote.asOf,
          gasCostUsd: gas.usdCost,
          source: quote.source,
        });
      } catch (err) {
        const reason =
          err instanceof PriceUnavailableError
            ? err.message
            : `Unexpected error: ${(err as Error).message}`;
        console.warn(`[pricing] dropping ${row.assetId}: ${reason}`);
        rejected.push({ assetId: row.assetId, reason });
      }
    }

    return { quotes, rejected };
  }
}
