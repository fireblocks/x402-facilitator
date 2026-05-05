/**
 * JWT verifier for management-API credentials.
 *
 * Two bundled implementations — pick via env:
 *   - `X402_ADMIN_JWT_SECRET` → HS256 (dev / single-operator deployments)
 *   - `X402_ADMIN_JWT_JWKS_URL` → RS256/ES256 via a remote JWKS
 *     (production / Fireblocks-issued tokens)
 *
 * If neither is set, the admin API rejects every request. The CLI
 * still works because it bypasses HTTP.
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  JWTPayload,
  errors as joseErrors,
} from 'jose';
import { resolveHs256Secret } from './jwtSecret';

export interface JwtVerifyOptions {
  issuer?: string;
  audience?: string;
  clockToleranceSec?: number;
}

export interface JwtVerifier {
  verify(token: string): Promise<JWTPayload>;
}

export class JwtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

export class HS256JwtVerifier implements JwtVerifier {
  private readonly secretKey: Uint8Array;

  constructor(secret: string, private readonly opts: JwtVerifyOptions = {}) {
    if (!secret) throw new Error('HS256JwtVerifier: secret must be non-empty');
    this.secretKey = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        clockTolerance: this.opts.clockToleranceSec ?? 30,
        algorithms: ['HS256'],
      });
      return payload;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        throw new JwtVerificationError(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  }
}

export class JwksJwtVerifier implements JwtVerifier {
  private readonly jwks;

  constructor(jwksUrl: string, private readonly opts: JwtVerifyOptions = {}) {
    if (!jwksUrl) throw new Error('JwksJwtVerifier: jwksUrl must be non-empty');
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        clockTolerance: this.opts.clockToleranceSec ?? 30,
      });
      return payload;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        throw new JwtVerificationError(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  }
}

/**
 * Env-driven factory. Returns null when no verifier is configured —
 * callers should reject admin requests in that case (or fall back to
 * a DenyUserAuthenticator).
 */
export function createJwtVerifier(): JwtVerifier | null {
  const opts: JwtVerifyOptions = {
    issuer: process.env.X402_ADMIN_JWT_ISSUER,
    audience: process.env.X402_ADMIN_JWT_AUDIENCE,
  };
  if (process.env.X402_ADMIN_JWT_JWKS_URL) {
    return new JwksJwtVerifier(process.env.X402_ADMIN_JWT_JWKS_URL, opts);
  }
  const resolved = resolveHs256Secret();
  if (resolved) return new HS256JwtVerifier(resolved.secret, opts);
  return null;
}
