/**
 * ApiTokenRepository — authoritative store for API tokens.
 *
 * Today the JSON impl reads/writes the `facilitator.api_keys` block.
 * Tomorrow a DB-backed impl keeps tokens in a per-tenant table — same
 * interface, scoped by TenantScope.
 */

import { TenantScope } from '../../core/tenantScope';
import { ApiTokenPrincipal } from '../../auth/principals';

export interface ApiTokenRecord {
  keyId: string;
  hashedSecret: string;
  scopes: string[];
  label: string | null;
  tenantId: string;
  configurationId: string;
}

export interface IssueTokenInput {
  scopes: string[];
  label?: string | null;
}

export interface IssueTokenResult {
  /** Plaintext token — return to caller once, never persisted. */
  token: string;
  record: ApiTokenRecord;
}

export interface ApiTokenRepository {
  /**
   * Mint a new token for the given scope. Returns the plaintext exactly
   * once; only the hash survives in storage.
   */
  issue(scope: TenantScope, input: IssueTokenInput): Promise<IssueTokenResult>;

  /**
   * Remove a token by its keyId. Scope-guarded: only tokens belonging
   * to the given scope may be revoked.
   */
  revoke(scope: TenantScope, keyId: string): Promise<boolean>;

  /**
   * List tokens belonging to a scope (hashes excluded from display by
   * callers that render to humans).
   */
  list(scope: TenantScope): Promise<ApiTokenRecord[]>;

  /**
   * Exchange a plaintext bearer token for its principal, or null on
   * miss. Globally scoped (tokens are unique across tenants).
   */
  verify(token: string): Promise<ApiTokenPrincipal | null>;
}
