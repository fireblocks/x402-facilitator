/**
 * GasCostEstimator — estimates the USD cost of settling a transfer on
 * a given chain with a given transfer mechanism.
 *
 * Why: gas on Ethereum mainnet is 100x+ gas on Base. A merchant who
 * quotes "$0.10" cannot accept payment on mainnet for the same amount
 * without losing money to the facilitator's settlement tx. A real impl
 * grosses the quote up (add gas to the client's charge) or rejects
 * uneconomic chains.
 *
 * TODAY: NoopGasCostEstimator returns 0 for every chain — pricing
 * behaves as if gas were free. The hook is in place so a real
 * implementation can slot in without touching call sites.
 *
 * Ideas for a real impl:
 *   - Hard-coded per-chain heuristics (fast, rough, no RPC dep).
 *   - eth_gasPrice / eth_baseFeePerGas from an RPC, × gas-units per
 *     mechanism, × ETH price from PriceProvider.
 *   - Fireblocks fee estimation where available.
 *   - Policy: 'ignore' | 'add-to-quote' | 'reject-if-above-threshold'.
 */

export interface GasCostEstimate {
  /** Estimated USD cost of submitting the settlement tx. */
  usdCost: number;
  asOf: Date;
}

export interface GasCostEstimator {
  estimate(chainId: number, mechanism: string): Promise<GasCostEstimate>;
}

/**
 * Default stub: zero gas cost, always. Safe for L2s where settlement
 * cost is negligible; dangerous for L1s. Replace before enabling
 * multi-chain production deployments that include mainnet Ethereum.
 */
export class NoopGasCostEstimator implements GasCostEstimator {
  async estimate(_chainId: number, _mechanism: string): Promise<GasCostEstimate> {
    return { usdCost: 0, asOf: new Date() };
  }
}

/**
 * How a non-zero gas estimate should affect the quote.
 *
 *   - 'ignore'              : do nothing (current default).
 *   - 'add-to-quote'        : client pays base_amount + gas_usd_in_asset.
 *   - 'reject-if-above-pct' : drop the asset from accepts[] if gas
 *                             exceeds N% of the merchant's USD price.
 */
export type GasCostPolicy = 'ignore' | 'add-to-quote' | 'reject-if-above-pct';
