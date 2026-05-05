/**
 * Shared HS256 secret resolver — used by both the server's JWT
 * verifier and the CLI's JWT minter.
 *
 * Resolution order (first hit wins):
 *   1. process.env.X402_ADMIN_JWT_SECRET     (raw string / base64 value)
 *   2. process.env.X402_ADMIN_JWT_SECRET_FILE (path to a file)
 *   3. ./secrets/jwt-hs256.key                (default, created by `x402 init`)
 *
 * Returns `null` if none are present — callers decide whether that's
 * a soft failure (server → DenyUserAuthenticator) or hard
 * (CLI → ask the user to run `x402 init`).
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_HS256_SECRET_PATH = path.resolve(
  process.cwd(),
  'secrets',
  'jwt-hs256.key',
);

export interface ResolvedHs256Secret {
  secret: string;
  source: 'env' | 'env-file' | 'default-file';
  path: string | null;
}

export function resolveHs256Secret(): ResolvedHs256Secret | null {
  const inline = process.env.X402_ADMIN_JWT_SECRET;
  if (inline && inline.trim().length > 0) {
    return { secret: inline, source: 'env', path: null };
  }

  const envPath = process.env.X402_ADMIN_JWT_SECRET_FILE;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `X402_ADMIN_JWT_SECRET_FILE points to '${resolved}', but the file is missing.`,
      );
    }
    return { secret: readKeyFile(resolved), source: 'env-file', path: resolved };
  }

  if (fs.existsSync(DEFAULT_HS256_SECRET_PATH)) {
    return {
      secret: readKeyFile(DEFAULT_HS256_SECRET_PATH),
      source: 'default-file',
      path: DEFAULT_HS256_SECRET_PATH,
    };
  }
  return null;
}

function readKeyFile(p: string): string {
  const raw = fs.readFileSync(p, 'utf-8').trim();
  if (raw.length === 0) {
    throw new Error(`JWT secret file ${p} is empty.`);
  }
  return raw;
}
