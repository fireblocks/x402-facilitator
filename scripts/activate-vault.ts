#!/usr/bin/env ts-node
/**
 * Activate Fireblocks asset wallets on a given vault. One-off helper
 * for setting up a payer vault that the x402-agent can sign from.
 *
 * Uses the same Fireblocks credentials configured for the default
 * facilitator configuration (config/facilitator.json → configurations[0].fireblocks).
 *
 * Usage:
 *   npx ts-node scripts/activate-vault.ts <vaultId> [assetId ...]
 *
 * Example (the x402-agent testing setup):
 *   npx ts-node scripts/activate-vault.ts 1 \
 *     BASECHAIN_ETH_TEST5 USDC_BASECHAIN_ETH_TEST5_8SH8
 */

import fs from 'fs';
import path from 'path';
import { FireblocksSDK } from 'fireblocks-sdk';

async function main() {
  const [vaultId, ...assets] = process.argv.slice(2);
  if (!vaultId || assets.length === 0) {
    console.error('usage: activate-vault.ts <vaultId> <assetId> [assetId ...]');
    process.exit(1);
  }

  const configPath = path.resolve(process.env.CONFIG_PATH ?? './config/facilitator.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const fb = cfg.configurations[0].fireblocks;
  const pem = fs.readFileSync(path.resolve(fb.api_secret_path), 'utf-8');
  const sdk = new FireblocksSDK(pem, fb.api_key, fb.base_url);

  const vault = await sdk.getVaultAccountById(vaultId);
  console.log(`Vault ${vaultId}: '${vault.name}'`);

  for (const assetId of assets) {
    const existing = (vault.assets ?? []).some((a) => a.id === assetId);
    if (existing) {
      const addrs = await sdk.getDepositAddresses(vaultId, assetId);
      console.log(`  ${assetId}: already active → ${addrs[0]?.address}`);
      continue;
    }
    try {
      const result = await sdk.createVaultAsset(vaultId, assetId);
      console.log(`  ${assetId}: ACTIVATED → ${result.address}`);
    } catch (e) {
      console.error(`  ${assetId}: FAILED — ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(2);
});
