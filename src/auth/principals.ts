/**
 * Principal — the authenticated identity behind a request.
 *
 * Two auth surfaces, one uniform principal shape downstream:
 *   - UserPrincipal     ← management API, JWT-authenticated.
 *                          Scope list comes from the JWT `scope` claim
 *                          (OAuth2: space-separated string or array).
 *                          Admin routes each require one specific scope
 *                          (`admin:read`, `admin:write`, `payments:read`,
 *                          `payments:write`). `*` is a wildcard that
 *                          grants every admin scope.
 *   - ApiTokenPrincipal ← payment processing API, opaque bearer.
 *                          Scoped to one configuration. Cannot grant
 *                          management access under any circumstance.
 */

export const WILDCARD_SCOPE = '*';

/** Management-API scope vocabulary (OAuth2 `scope` claim). */
export const ADMIN_READ = 'admin:read';
export const ADMIN_WRITE = 'admin:write';
export const PAYMENTS_READ = 'payments:read';
export const PAYMENTS_WRITE = 'payments:write';

/** All admin scopes — used for wildcard expansion and preset definitions. */
export const ALL_ADMIN_SCOPES = [
  ADMIN_READ,
  ADMIN_WRITE,
  PAYMENTS_READ,
  PAYMENTS_WRITE,
] as const;

export type AdminScope = (typeof ALL_ADMIN_SCOPES)[number];

/** Sentinel meaning "all configurations in this tenant". */
export const ALL_CONFIGURATIONS = '*' as const;

export interface UserPrincipal {
  kind: 'user';
  tenantId: string;
  userId: string;
  email: string | null;
  scopes: string[];
  /** Which configurations this credential grants access to. */
  configurationIds: string[] | typeof ALL_CONFIGURATIONS;
}

export interface ApiTokenPrincipal {
  kind: 'apiToken';
  tenantId: string;
  configurationId: string;
  keyId: string;
  scopes: string[];
  label: string | null;
}

export type Principal = UserPrincipal | ApiTokenPrincipal;

/**
 * Scope check for payment-API middleware. For ApiToken principals a
 * `*` scope is a wildcard that grants every payment-API scope. For
 * UserPrincipals we check the literal scope — management tokens do
 * not magically gain payment-API privileges.
 */
export function principalHasScope(p: Principal, scope: string): boolean {
  if (p.kind === 'apiToken') {
    return p.scopes.includes(WILDCARD_SCOPE) || p.scopes.includes(scope);
  }
  return p.scopes.includes(scope);
}

/**
 * Admin scope check for /api/admin/* routes. Each admin route declares
 * its required scope (e.g. `admin:write`, `payments:read`); this
 * helper checks whether a UserPrincipal carries that scope or the
 * wildcard.
 *
 * ApiTokenPrincipals — regardless of the `*` scope — are never admins.
 * The two auth systems are separated by design so that compromising an
 * agent-facing API token does not grant management access.
 */
export function principalHasAdminScope(p: Principal, required: AdminScope): boolean {
  if (p.kind !== 'user') return false;
  if (p.scopes.includes(WILDCARD_SCOPE)) return true;
  return p.scopes.includes(required);
}

/**
 * Does this principal have access to the given configurationId?
 */
export function principalAllowsConfiguration(
  p: Principal,
  configurationId: string,
): boolean {
  if (p.kind === 'apiToken') {
    return p.configurationId === configurationId;
  }
  if (p.configurationIds === ALL_CONFIGURATIONS) return true;
  return p.configurationIds.includes(configurationId);
}
