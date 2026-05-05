/**
 * Shared Fireblocks SDK construction helper.
 *
 * Both `FireblocksSettlementService` (on-chain settlement) and the asset
 * catalog (`ListAssetsFireblocksCatalog`) build off the same credentials.
 * Keeping the PEM-reading + SDK construction in one place means both
 * paths handle inline PEMs and file paths identically.
 */

import { FireblocksSDK } from 'fireblocks-sdk';
import { readFileSync } from 'fs';
import { FireblocksConfig } from '../repositories/interfaces/FacilitatorRepository';

export interface FireblocksSdkOptions {
  apiKey: string;
  /** Either a PEM string (starts with -----BEGIN) or a path on disk. */
  apiSecret: string;
  baseUrl?: string;
}

export function createFireblocksSdk(opts: FireblocksSdkOptions): FireblocksSDK {
  let privateKey = opts.apiSecret;
  if (!privateKey.trim().startsWith('-----BEGIN')) {
    privateKey = readFileSync(privateKey, 'utf8');
  }
  return new FireblocksSDK(
    privateKey,
    opts.apiKey,
    opts.baseUrl || 'https://api.fireblocks.io',
  );
}

/**
 * Construct an SDK instance from the repository's FireblocksConfig shape.
 */
export function createFireblocksSdkFromConfig(config: FireblocksConfig): FireblocksSDK {
  return createFireblocksSdk({
    apiKey: config.apiKey,
    apiSecret: config.apiSecretPath,
    baseUrl: config.baseUrl,
  });
}
