/**
 * Mainnet-vs-testnet network policy.
 *
 * Default-deny mainnet. An operator must opt in explicitly by setting
 * `X402_ALLOW_MAINNET=true`. Enforced at two points:
 *
 *   1. Asset import  — `POST /api/admin/assets` refuses to register a
 *                       mainnet asset while the flag is off.
 *   2. Server boot   — scans the configured catalog; refuses to start
 *                       if any asset is mainnet and the flag is off.
 *
 * `is_testnet` lives on each asset record and is populated at import
 * time from Fireblocks' `blockchain.onchain.test` field.
 */

import type { AssetShape } from './configSchema';

export function mainnetAllowed(): boolean {
  return process.env.X402_ALLOW_MAINNET === 'true';
}

export interface MainnetAsset {
  asset_id: string;
  chain_id: number;
}

export function findMainnetAssets(assets: AssetShape[]): MainnetAsset[] {
  return assets
    .filter((a) => a.is_testnet === false)
    .map((a) => ({ asset_id: a.asset_id, chain_id: a.chain_id }));
}

export class MainnetAssetForbiddenError extends Error {
  constructor(
    public readonly offenders: MainnetAsset[],
    public readonly context: 'boot' | 'import',
  ) {
    const list = offenders.map((o) => `${o.asset_id} (chain ${o.chain_id})`).join(', ');
    const preamble =
      context === 'boot'
        ? 'Refusing to start: facilitator config contains mainnet asset(s)'
        : 'Refusing to register mainnet asset';
    super(
      `${preamble} while X402_ALLOW_MAINNET is not set.\n  offending: ${list}\n` +
        `  Set X402_ALLOW_MAINNET=true in the environment to opt in to production chains.`,
    );
    this.name = 'MainnetAssetForbiddenError';
  }
}
