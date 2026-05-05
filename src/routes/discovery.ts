/**
 * Discovery API (Bazaar) — lists discoverable resources for external directories.
 * Public: no auth.
 *
 * Each discoverable product surfaces one `accepts[]` entry per pricing
 * row whose amount is statically known (native-denomination). Live-
 * priced rows (USD + runtime conversion) are skipped in discovery —
 * clients should hit the live resource to get a fresh quote.
 */

import { Router, Request, Response } from 'express';
import { FacilitatorRepository } from '../repositories/interfaces/FacilitatorRepository';
import { AssetRepository } from '../repositories/interfaces/AssetRepository';
import { ProductRepository } from '../repositories/interfaces/ProductRepository';
import { ConfigurationResolver } from '../core/configurationResolver';

interface DiscoveredResource {
  resource: string;
  type: string;
  x402Version: 2;
  accepts: Array<{ scheme: string; network: string; amount: string; asset: string }>;
  lastUpdated: number;
  metadata: {
    category?: string;
    description?: string;
    mimeType?: string;
  };
}

export function createDiscoveryRoutes(
  facilitator: FacilitatorRepository,
  assets: AssetRepository,
  products: ProductRepository,
  resolver: ConfigurationResolver,
): Router {
  const router = Router();

  router.get('/resources', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const category = req.query.category as string | undefined;
      const type = req.query.type as string | undefined;

      const scope = resolver.fromProxyRequest(req);
      if (!scope) {
        res.status(200).json({
          x402Version: 2,
          items: [],
          pagination: { limit, offset, total: 0 },
        });
        return;
      }

      const cfg = facilitator.get(scope);
      const items: DiscoveredResource[] = [];
      const now = Math.floor(Date.now() / 1000);

      for (const product of products.list(scope)) {
        if (!product.isDiscoverable) continue;
        if (category && product.category !== category) continue;
        if (type && type !== 'http') continue;

        const accepts: DiscoveredResource['accepts'] = [];
        for (const row of product.pricing) {
          // Skip rows that need live pricing — discovery is a static catalog.
          if (row.amount === null) continue;
          const asset = assets.get(row.assetId);
          if (!asset) continue;
          accepts.push({
            scheme: product.scheme,
            network: `eip155:${asset.chainId}`,
            amount: row.amount.toString(),
            asset: asset.address,
          });
        }
        if (accepts.length === 0) continue;

        items.push({
          resource: `${cfg.publicHost}${product.endpoint}`,
          type: 'http',
          x402Version: 2,
          accepts,
          lastUpdated: now,
          metadata: {
            category: product.category || undefined,
            description: product.description || product.name,
            mimeType: product.mimeType || 'application/json',
          },
        });
      }

      const total = items.length;
      const paginated = items.slice(offset, offset + limit);
      res.status(200).json({
        x402Version: 2,
        items: paginated,
        pagination: { limit, offset, total },
      });
    } catch (err) {
      console.error('[discovery] error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
