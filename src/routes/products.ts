import { Router, Request, Response } from 'express';
import {
  Product,
  ProductRepository,
} from '../repositories/interfaces/ProductRepository';
import { AssetRepository } from '../repositories/interfaces/AssetRepository';
import { TenantScope } from '../core/tenantScope';
import { requireUserScope } from '../middleware/auth';
import { ADMIN_READ, ADMIN_WRITE } from '../auth/principals';
import { ConfigFile } from '../config/configFile';
import { randId } from '../utils/randId';

/**
 * Hydrate a product's pricing rows with the referenced asset records.
 */
function withAssets(
  assets: AssetRepository,
  scope: TenantScope,
  product: Product,
) {
  return {
    ...product,
    pricing: product.pricing.map((row) => ({
      ...row,
      asset: assets.get(row.assetId) ?? null,
    })),
  };
}

interface CreateProductBody {
  name?: string;
  endpoint?: string;
  scheme?: 'exact' | 'upto';
  usd_price?: number | null;
  pricing?: Array<{ asset_id: string; amount?: number | null }>;
  description?: string | null;
  mime_type?: string | null;
  category?: string | null;
  is_discoverable?: boolean;
}

export function createProductRoutes(
  products: ProductRepository,
  assets: AssetRepository,
  configFile: ConfigFile,
): Router {
  const router = Router();

  router.get('/', requireUserScope(ADMIN_READ), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const all = products.list(scope).map((p) => withAssets(assets, scope, p));
    res.status(200).json(all);
  });

  router.get('/:productId', requireUserScope(ADMIN_READ), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const product = products.get(req.scope, req.params.productId as string);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.status(200).json(withAssets(assets, req.scope, product));
  });

  router.post('/', requireUserScope(ADMIN_WRITE), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const body = (req.body || {}) as CreateProductBody;

    if (!body.name || !body.endpoint || !body.pricing || body.pricing.length === 0) {
      res.status(400).json({ error: 'name, endpoint, and pricing[] are required' });
      return;
    }
    if (!body.endpoint.startsWith('/')) {
      res.status(400).json({ error: 'endpoint must start with /' });
      return;
    }
    const needsUsd = body.pricing.some((r) => r.amount === null || r.amount === undefined);
    if (needsUsd && (body.usd_price === null || body.usd_price === undefined)) {
      res.status(400).json({
        error:
          'usd_price is required when any pricing[].amount is omitted (needed for runtime conversion)',
      });
      return;
    }
    for (const row of body.pricing) {
      if (!configFile.findAsset(row.asset_id)) {
        res.status(400).json({
          error: `No asset with asset_id=${row.asset_id} in the global catalog. Import it first.`,
        });
        return;
      }
    }

    try {
      const cfg = configFile.getConfiguration(scope.configurationId);
      if (cfg.products.some((p) => p.endpoint === body.endpoint)) {
        res.status(409).json({
          error: `A product with endpoint ${body.endpoint} already exists in ${scope.configurationId}`,
        });
        return;
      }

      const productId = randId('prod');
      configFile.updateConfiguration(scope.configurationId, (cur) => ({
        ...cur,
        products: [
          ...cur.products,
          {
            product_id: productId,
            name: body.name!,
            endpoint: body.endpoint!,
            scheme: body.scheme ?? 'exact',
            usd_price: body.usd_price ?? null,
            pricing: body.pricing!.map((r) => ({
              asset_id: r.asset_id,
              amount: r.amount ?? null,
            })),
            description: body.description ?? null,
            mime_type: body.mime_type ?? 'application/json',
            category: body.category ?? null,
            is_discoverable: Boolean(body.is_discoverable),
          },
        ],
      }));
      const created = products.get(scope, productId);
      if (!created) {
        res.status(500).json({ error: 'Product persisted but not readable' });
        return;
      }
      res.status(201).json(withAssets(assets, scope, created));
    } catch (err) {
      console.error('[admin/products] create error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/:productId', requireUserScope(ADMIN_WRITE), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const scope = req.scope;
    const productId = req.params.productId as string;
    try {
      let found = false;
      configFile.updateConfiguration(scope.configurationId, (cur) => {
        const next = cur.products.filter((p) => {
          if (p.product_id === productId) {
            found = true;
            return false;
          }
          return true;
        });
        return { ...cur, products: next };
      });
      if (!found) {
        res.status(404).json({ error: `No product with product_id=${productId}` });
        return;
      }
      res.status(204).send();
    } catch (err) {
      console.error('[admin/products] delete error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
