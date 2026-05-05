/**
 * Admin assets API — read + import + sync.
 *
 *   GET    /api/admin/assets            — list the global catalog
 *   GET    /api/admin/assets/:assetId   — show one
 *   POST   /api/admin/assets            — import; hydrates address/decimals/chain_id/blockchain_id from Fireblocks
 *   POST   /api/admin/assets/sync       — diff the catalog against Fireblocks; apply=true writes
 *
 * The asset catalog is global (top-level). The only scope-specific
 * thing here is that the hydrator and sync use the caller's
 * configuration's Fireblocks credentials.
 */

import { Router, Request, Response } from 'express';
import { AssetRepository } from '../repositories/interfaces/AssetRepository';
import { ConfigFile } from '../config/configFile';
import { FireblocksAssetCatalog } from '../services/assets';
import { requireUserScope } from '../middleware/auth';
import { ADMIN_READ, ADMIN_WRITE } from '../auth/principals';
import { mainnetAllowed, MainnetAssetForbiddenError } from '../config/networkPolicy';

interface ImportBody {
  asset_id?: string;
  transfer_mechanism?: 'eip-3009' | 'permit2' | 'upto-permit2' | 'erc7710';
  eip712_name?: string;
  eip712_version?: string;
  stable?: boolean;
  price_symbol?: string | null;
  force?: boolean;
}

export function createAdminAssetRoutes(
  assets: AssetRepository,
  configFile: ConfigFile,
  catalog: FireblocksAssetCatalog,
): Router {
  const router = Router();

  router.get('/', requireUserScope(ADMIN_READ), (_req: Request, res: Response) => {
    res.status(200).json(assets.list());
  });

  router.get('/:assetId', requireUserScope(ADMIN_READ), (req: Request, res: Response) => {
    const asset = assets.get(req.params.assetId as string);
    if (!asset) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }
    res.status(200).json(asset);
  });

  router.post('/', requireUserScope(ADMIN_WRITE), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const body = (req.body || {}) as ImportBody;
    if (!body.asset_id || !body.transfer_mechanism || !body.eip712_name || !body.eip712_version) {
      res.status(400).json({
        error: 'asset_id, transfer_mechanism, eip712_name, and eip712_version are required',
      });
      return;
    }

    try {
      const hyd = await catalog.fetchAsset(scope, body.asset_id);
      if (!hyd.address) {
        res
          .status(400)
          .json({ error: `Fireblocks returned no contract address for '${body.asset_id}'.` });
        return;
      }
      if (hyd.chainId === null) {
        res.status(400).json({
          error: `Fireblocks returned no EIP-155 chainId for '${body.asset_id}' (non-EVM).`,
        });
        return;
      }
      if (!hyd.blockchainId) {
        res
          .status(400)
          .json({ error: `Fireblocks returned no blockchainId for '${body.asset_id}'.` });
        return;
      }
      if (hyd.isTestnet === null) {
        res.status(400).json({
          error:
            `Fireblocks did not report whether the blockchain for '${body.asset_id}' is a testnet. ` +
            `Refusing to register an asset without a definitive network classification.`,
        });
        return;
      }
      if (!hyd.isTestnet && !mainnetAllowed()) {
        const err = new MainnetAssetForbiddenError(
          [{ asset_id: hyd.legacyId, chain_id: hyd.chainId }],
          'import',
        );
        res.status(403).json({ error: err.message });
        return;
      }

      const canonicalId = hyd.legacyId;
      if (configFile.findAsset(canonicalId) && !body.force) {
        res.status(409).json({
          error: `Asset '${canonicalId}' already exists. Pass force:true to overwrite.`,
        });
        return;
      }

      const entry = {
        asset_id: canonicalId,
        blockchain_id: hyd.blockchainId,
        address: hyd.address,
        decimals: hyd.decimals,
        chain_id: hyd.chainId,
        eip712_name: body.eip712_name,
        eip712_version: body.eip712_version,
        transfer_mechanism: body.transfer_mechanism,
        is_testnet: hyd.isTestnet,
        stable: Boolean(body.stable),
        price_symbol: body.price_symbol ?? null,
      };
      configFile.upsertAsset(entry, { replaceExisting: true });
      res.status(201).json({
        asset: entry,
        fireblocks: {
          symbol: hyd.symbol,
          name: hyd.name,
          assetClass: hyd.assetClass,
          standards: hyd.standards,
          deprecated: hyd.deprecated,
        },
      });
    } catch (err) {
      console.error('[admin/assets] import error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/:assetId', requireUserScope(ADMIN_WRITE), (req: Request, res: Response) => {
    const assetId = req.params.assetId as string;
    const top = configFile.get();
    // Refuse deletion while any product still references this asset.
    const usedBy: Array<{ configurationId: string; productId: string }> = [];
    for (const conf of top.configurations) {
      for (const p of conf.products) {
        if (p.pricing.some((row) => row.asset_id === assetId)) {
          usedBy.push({ configurationId: conf.configuration_id, productId: p.product_id });
        }
      }
    }
    if (usedBy.length > 0) {
      res.status(409).json({
        error: `Asset ${assetId} is referenced by ${usedBy.length} product(s). Remove those first.`,
        usedBy,
      });
      return;
    }
    const removed = configFile.removeAsset(assetId);
    if (!removed) {
      res.status(404).json({ error: `No asset with asset_id=${assetId}` });
      return;
    }
    res.status(204).send();
  });

  router.post('/sync', requireUserScope(ADMIN_WRITE), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const apply = Boolean((req.body || {}).apply);
    try {
      const top = configFile.get();
      const diffs: Array<{
        asset_id: string;
        field: 'address' | 'decimals' | 'chain_id' | 'blockchain_id' | 'is_testnet';
        from: string | number | boolean | null;
        to: string | number | boolean | null;
      }> = [];
      const errors: Array<{ asset_id: string; error: string }> = [];
      const updated = new Map<string, typeof top.assets[number]>();

      for (const a of top.assets) {
        try {
          const hyd = await catalog.fetchAsset(scope, a.asset_id);
          if (hyd.address && hyd.address.toLowerCase() !== a.address.toLowerCase()) {
            diffs.push({ asset_id: a.asset_id, field: 'address', from: a.address, to: hyd.address });
          }
          if (hyd.decimals !== a.decimals) {
            diffs.push({ asset_id: a.asset_id, field: 'decimals', from: a.decimals, to: hyd.decimals });
          }
          if (hyd.chainId !== null && hyd.chainId !== a.chain_id) {
            diffs.push({ asset_id: a.asset_id, field: 'chain_id', from: a.chain_id, to: hyd.chainId });
          }
          if (hyd.blockchainId && hyd.blockchainId !== a.blockchain_id) {
            diffs.push({
              asset_id: a.asset_id,
              field: 'blockchain_id',
              from: a.blockchain_id,
              to: hyd.blockchainId,
            });
          }
          if (hyd.isTestnet !== null && hyd.isTestnet !== a.is_testnet) {
            diffs.push({
              asset_id: a.asset_id,
              field: 'is_testnet',
              from: a.is_testnet,
              to: hyd.isTestnet,
            });
          }
          if (hyd.address && hyd.chainId !== null && hyd.blockchainId && hyd.isTestnet !== null) {
            updated.set(a.asset_id, {
              ...a,
              address: hyd.address,
              decimals: hyd.decimals,
              chain_id: hyd.chainId,
              blockchain_id: hyd.blockchainId,
              is_testnet: hyd.isTestnet,
            });
          }
        } catch (err) {
          errors.push({ asset_id: a.asset_id, error: (err as Error).message });
        }
      }

      if (apply && diffs.length > 0) {
        configFile.update((cur) => ({
          ...cur,
          assets: cur.assets.map((a) => updated.get(a.asset_id) ?? a),
        }));
      }
      res.status(200).json({ diffs, errors, applied: apply && diffs.length > 0 });
    } catch (err) {
      console.error('[admin/assets] sync error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
