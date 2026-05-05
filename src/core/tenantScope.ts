/**
 * TenantScope — identifies the tenant + configuration a request operates in.
 *
 * The tenant is essentially a container today; the *configuration* is
 * the meaningful unit of isolation (its own Fireblocks creds, products,
 * API keys). A tenant may hold many configurations; a payment-service
 * provider deploys one facilitator per tenant and declares a
 * configuration per merchant.
 */

export interface TenantScope {
  tenantId: string;
  configurationId: string;
}

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_CONFIGURATION_ID = 'default';

export const DEFAULT_SCOPE: TenantScope = {
  tenantId: DEFAULT_TENANT_ID,
  configurationId: DEFAULT_CONFIGURATION_ID,
};

export function scopesEqual(a: TenantScope, b: TenantScope): boolean {
  return a.tenantId === b.tenantId && a.configurationId === b.configurationId;
}

export function formatScope(s: TenantScope): string {
  return `${s.tenantId}/${s.configurationId}`;
}
