/**
 * UserAuthenticator — verifies a management-API credential and
 * produces a UserPrincipal.
 *
 * The only real implementation is `JwtUserAuthenticator`. In local dev,
 * the CLI mints short-lived HS256 tokens against a secret that's
 * scaffolded by `x402 init`. In production, the same interface fronts
 * a JWKS-backed verifier that validates Fireblocks-issued tokens.
 *
 * If no JWT verifier is configured (neither X402_ADMIN_JWT_SECRET,
 * X402_ADMIN_JWT_SECRET_FILE, nor X402_ADMIN_JWT_JWKS_URL), the server
 * installs a DenyUserAuthenticator and every admin request returns 401.
 */

import { UserPrincipal, ALL_CONFIGURATIONS } from './principals';
import { JwtVerifier, createJwtVerifier } from './jwtVerifier';
import { JWTPayload } from 'jose';

export interface UserAuthenticator {
  verify(authorizationHeader: string | undefined): Promise<UserPrincipal | null>;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

function parseScopes(payload: JWTPayload): string[] {
  // OAuth2 `scope` is space-separated; `scopes` (plural) is commonly an array.
  if (Array.isArray((payload as any).scopes)) {
    return (payload as any).scopes.map(String);
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  return [];
}

function parseConfigurationIds(
  payload: JWTPayload,
): string[] | typeof ALL_CONFIGURATIONS {
  const raw = (payload as any).configuration_ids;
  if (raw === '*') return ALL_CONFIGURATIONS;
  if (Array.isArray(raw)) return raw.map(String);
  // Fail closed. A missing or malformed `configuration_ids` claim must
  // NOT grant tenant-wide access — that's the kind of default that
  // turns a JWT minted for one configuration into a cross-tenant
  // super-user token. Routes will return 403 on access checks.
  return [];
}

export class JwtUserAuthenticator implements UserAuthenticator {
  constructor(private readonly verifier: JwtVerifier) {}

  async verify(authorizationHeader: string | undefined): Promise<UserPrincipal | null> {
    const token = extractBearer(authorizationHeader);
    if (!token) return null;
    try {
      const claims = await this.verifier.verify(token);
      const tenantId = (claims as any).tenant_id;
      if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
      return {
        kind: 'user',
        tenantId,
        userId: typeof claims.sub === 'string' ? claims.sub : '',
        email: typeof (claims as any).email === 'string' ? (claims as any).email : null,
        scopes: parseScopes(claims),
        configurationIds: parseConfigurationIds(claims),
      };
    } catch {
      return null;
    }
  }
}

export class DenyUserAuthenticator implements UserAuthenticator {
  async verify(): Promise<UserPrincipal | null> {
    return null;
  }
}

/**
 * Env-driven factory. Returns JwtUserAuthenticator if a verifier is
 * configured, DenyUserAuthenticator otherwise (admin API returns 401).
 */
export function createUserAuthenticator(): UserAuthenticator {
  const verifier = createJwtVerifier();
  if (!verifier) return new DenyUserAuthenticator();
  return new JwtUserAuthenticator(verifier);
}
