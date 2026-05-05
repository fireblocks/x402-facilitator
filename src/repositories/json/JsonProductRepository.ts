import { ConfigFile } from '../../config/configFile';
import { TenantScope } from '../../core/tenantScope';
import { Product, ProductRepository } from '../interfaces/ProductRepository';
import { ProductShape } from '../../config/configSchema';

function toDomain(shape: ProductShape): Product {
  return {
    productId: shape.product_id,
    name: shape.name,
    endpoint: shape.endpoint,
    scheme: shape.scheme,
    usdPrice: shape.usd_price ?? null,
    pricing: shape.pricing.map((row) => ({
      assetId: row.asset_id,
      amount: row.amount ?? null,
      transferMechanism: row.transfer_mechanism,
    })),
    description: shape.description ?? null,
    mimeType: shape.mime_type ?? null,
    category: shape.category ?? null,
    isDiscoverable: shape.is_discoverable,
  };
}

export class JsonProductRepository implements ProductRepository {
  constructor(private readonly configFile: ConfigFile) {}

  get(scope: TenantScope, productId: string): Product | undefined {
    const cfg = this.resolveConfig(scope);
    if (!cfg) return undefined;
    const shape = cfg.products.find((p) => p.product_id === productId);
    return shape ? toDomain(shape) : undefined;
  }

  getByEndpoint(scope: TenantScope, endpoint: string): Product | undefined {
    const cfg = this.resolveConfig(scope);
    if (!cfg) return undefined;
    const shape = cfg.products.find((p) => p.endpoint === endpoint);
    return shape ? toDomain(shape) : undefined;
  }

  list(scope: TenantScope): Product[] {
    const cfg = this.resolveConfig(scope);
    if (!cfg) return [];
    return cfg.products.map(toDomain);
  }

  private resolveConfig(scope: TenantScope) {
    const top = this.configFile.get();
    if (scope.tenantId !== top.tenant_id) return undefined;
    return this.configFile.findConfiguration(scope.configurationId);
  }
}
