/**
 * Product — a payment-gated endpoint owned by a tenant/configuration.
 *
 * Pricing is multi-asset. Each pricing row either names an explicit
 * native-denomination amount (in the asset's base units), or leaves
 * `amount` null to indicate "convert from usdPrice at request time".
 */

import { TenantScope } from '../../core/tenantScope';

export interface ProductPricing {
  assetId: string;
  /**
   * Base-unit amount (e.g. 100000 = 0.10 USDC at 6 decimals). If null,
   * the product's `usdPrice` is converted to this asset at request time.
   */
  amount: number | null;
  /**
   * Optional per-row override of the transfer mechanism. Lets a single
   * asset be offered via multiple mechanisms (e.g. the same USDC as
   * both `eip-3009` and `permit2`). When undefined, the asset's own
   * `transferMechanism` is used.
   */
  transferMechanism?: 'eip-3009' | 'permit2' | 'upto-permit2' | 'erc7710';
}

export interface Product {
  productId: string;
  name: string;
  endpoint: string;
  scheme: string;
  /**
   * Merchant-denominated USD price (fractional dollars). Optional.
   * Required whenever any `pricing` row has a null `amount`.
   */
  usdPrice: number | null;
  pricing: ProductPricing[];
  description: string | null;
  mimeType: string | null;
  category: string | null;
  isDiscoverable: boolean;
}

export interface ProductRepository {
  get(scope: TenantScope, productId: string): Product | undefined;
  getByEndpoint(scope: TenantScope, endpoint: string): Product | undefined;
  list(scope: TenantScope): Product[];
}
