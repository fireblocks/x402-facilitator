/**
 * Admin Fireblocks API.
 *
 *   GET  /api/admin/fireblocks        — show the configured Fireblocks
 *                                       block, with the API key redacted
 *   POST /api/admin/fireblocks/test   — for each asset in the global
 *                                       catalog: activate its vault wallet
 *                                       (if asked) and cache its deposit
 *                                       address. Optionally narrow to a
 *                                       single chain's native asset.
 *
 * Writing credentials via the API is intentionally not supported today;
 * the API key + PEM path live on the server's filesystem, so `fireblocks
 * set` remains a local-only command.
 */

import { Router, Request, Response } from 'express';
import { ConfigFile } from '../config/configFile';
import { JsonFacilitatorRepository } from '../repositories/json';
import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';
import { createFireblocksSdkFromConfig } from '../services/fireblocksClient';
import { requireUserScope } from '../middleware/auth';
import { ADMIN_READ, ADMIN_WRITE } from '../auth/principals';

interface TestBody {
  chain_id?: number;
  create_missing?: boolean;
}

function redact(s: string): string {
  if (!s) return '(empty)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function createAdminFireblocksRoutes(configFile: ConfigFile): Router {
  const router = Router();

  router.get('/', requireUserScope(ADMIN_READ), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    try {
      const fb = configFile.getConfiguration(scope.configurationId).fireblocks;
      res.status(200).json({
        configuration_id: scope.configurationId,
        api_key_redacted: redact(fb.api_key),
        api_secret_path: fb.api_secret_path,
        receiver_vault: fb.receiver_vault,
        base_url: fb.base_url,
        deposit_address_cache: fb.deposit_address_cache,
      });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/test', requireUserScope(ADMIN_WRITE), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const body = (req.body || {}) as TestBody;
    const createMissing = Boolean(body.create_missing);
    const repo = new JsonFacilitatorRepository(configFile);

    try {
      // Single-chain mode — just activate the native gas asset.
      if (body.chain_id) {
        const factory = new FireblocksSettlementFactory(repo);
        const svc = factory.get(scope, Number(body.chain_id));
        const { address, created } = createMissing
          ? await svc.ensureWalletAddress()
          : { address: await svc.getWalletAddress(), created: false };
        res.status(200).json({
          mode: 'single-chain',
          chain_id: Number(body.chain_id),
          address,
          created,
          note: 'No per-asset cache written in single-chain mode.',
        });
        return;
      }

      // Multi-asset mode — iterate the global catalog.
      const assets = configFile.get().assets;
      if (assets.length === 0) {
        res.status(400).json({
          error:
            'No assets configured. Import one first (POST /api/admin/assets) or pass chain_id.',
        });
        return;
      }

      const fbCfg = repo.get(scope).fireblocks;
      const sdk = createFireblocksSdkFromConfig(fbCfg);
      const results: Array<{
        asset_id: string;
        chain_id: number;
        address?: string;
        created?: boolean;
        error?: string;
      }> = [];

      for (const a of assets) {
        try {
          let existing = await sdk.getDepositAddresses(fbCfg.receiverVault, a.asset_id);
          let created = false;
          if ((!existing || existing.length === 0) && createMissing) {
            await sdk.createVaultAsset(fbCfg.receiverVault, a.asset_id);
            created = true;
            existing = await sdk.getDepositAddresses(fbCfg.receiverVault, a.asset_id);
          }
          const address = existing?.[0]?.address;
          if (!address) {
            results.push({
              asset_id: a.asset_id,
              chain_id: a.chain_id,
              error: 'no deposit address (retry with create_missing: true)',
            });
          } else {
            results.push({ asset_id: a.asset_id, chain_id: a.chain_id, address, created });
          }
        } catch (err) {
          results.push({
            asset_id: a.asset_id,
            chain_id: a.chain_id,
            error: (err as Error).message,
          });
        }
      }

      // Activate native gas assets on each unique chain so CONTRACT_CALL
      // has gas. Only when create_missing: true.
      const nativeGasNotes: string[] = [];
      if (createMissing) {
        const factory = new FireblocksSettlementFactory(repo);
        const chains = Array.from(new Set(assets.map((a) => a.chain_id)));
        for (const chainId of chains) {
          try {
            await factory.get(scope, chainId).ensureWalletAddress();
          } catch (err) {
            nativeGasNotes.push(`chain ${chainId}: ${(err as Error).message}`);
          }
        }
      }

      const updates: Record<string, string> = {};
      for (const r of results) if (r.address) updates[r.asset_id] = r.address;
      if (Object.keys(updates).length > 0) {
        configFile.updateConfiguration(scope.configurationId, (cur) => ({
          ...cur,
          fireblocks: {
            ...cur.fireblocks,
            deposit_address_cache: {
              ...cur.fireblocks.deposit_address_cache,
              ...updates,
            },
          },
        }));
      }

      const ok = results.filter((r) => r.address).length;
      res.status(200).json({
        mode: 'multi-asset',
        results,
        ok_count: ok,
        failed_count: results.length - ok,
        native_gas_notes: nativeGasNotes,
        cache_updated: Object.keys(updates).length,
      });
    } catch (err) {
      console.error('[admin/fireblocks] test error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
