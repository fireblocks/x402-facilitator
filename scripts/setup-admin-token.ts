#!/usr/bin/env node
/**
 * Mint a token for the facilitator's **internal admin API** (`/api/admin/*`).
 *
 * The token is a local HS256 JWT signed with the secret on disk
 * (scaffolded by `npm run setup`); the server verifies it with the
 * same secret via `JwtUserAuthenticator`. Nothing about this token
 * touches the machine-facing payments API — that uses opaque API keys
 * issued through `x402 keys create`.
 *
 * Local-only by design: minting reads the signing secret from disk, so
 * the remote `x402` CLI deliberately has no equivalent.
 *
 * Flags:
 *   --preset <name>         readonly | payments-ops | full | wildcard
 *   --scopes "a:b c:d"      Raw scope list (overrides --preset)
 *   --tenant <id>           Tenant id (default: read from config)
 *   --sub <subject>         JWT sub (default: dev-admin)
 *   --configurations <ids>  Comma-separated configurationIds (default: *)
 *   --ttl <duration>        e.g. 1h, 30m, 7d (default: 1h)
 *   --issuer <iss>          iss claim (default: x402-dev)
 *   --audience <aud>        aud claim (optional)
 */

import { SignJWT } from 'jose';
import { resolveHs256Secret } from '../src/auth/jwtSecret';
import { getConfigFile } from '../src/config/configFile';
import {
  ADMIN_READ,
  ADMIN_WRITE,
  PAYMENTS_READ,
  PAYMENTS_WRITE,
  WILDCARD_SCOPE,
} from '../src/auth/principals';

const PRESETS: Record<string, string[]> = {
  readonly: [ADMIN_READ, PAYMENTS_READ],
  'payments-ops': [PAYMENTS_READ, PAYMENTS_WRITE],
  full: [ADMIN_READ, ADMIN_WRITE, PAYMENTS_READ, PAYMENTS_WRITE],
  wildcard: [WILDCARD_SCOPE],
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  let resolved;
  try {
    resolved = resolveHs256Secret();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (!resolved) {
    console.error(
      'No HS256 signing secret found. Run `npm run setup` first, or set X402_ADMIN_JWT_SECRET / X402_ADMIN_JWT_SECRET_FILE.',
    );
    process.exit(1);
  }

  let scopes: string[];
  if (args.scopes) {
    scopes = args.scopes.split(/[,\s]+/).filter(Boolean);
  } else {
    const preset = args.preset ?? 'readonly';
    if (!PRESETS[preset]) {
      console.error(
        `Unknown preset '${preset}'. Available: ${Object.keys(PRESETS).join(', ')}`,
      );
      process.exit(1);
    }
    scopes = PRESETS[preset];
  }

  let tenantId: string;
  try {
    tenantId = args.tenant || getConfigFile().get().tenant_id;
  } catch {
    if (!args.tenant) {
      console.error(
        'Could not read config/facilitator.json to pick a tenant_id. Pass --tenant <id>.',
      );
      process.exit(1);
    }
    tenantId = args.tenant;
  }

  const configurationIds = args.configurations
    ? args.configurations.split(',').map((s) => s.trim()).filter(Boolean)
    : '*';

  const sub = args.sub || 'dev-admin';
  const ttl = args.ttl || '1h';
  const issuer = args.issuer || 'x402-dev';
  const audience = args.audience;

  const key = new TextEncoder().encode(resolved.secret);
  const builder = new SignJWT({
    tenant_id: tenantId,
    scope: scopes.join(' '),
    configuration_ids: configurationIds,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(ttl);
  if (audience) builder.setAudience(audience);
  const jwt = await builder.sign(key);

  console.log('');
  console.log('Internal admin API token (HS256 JWT) — authenticates against /api/admin/*');
  console.log('');
  console.log(jwt);
  console.log('');
  console.log(`tenant_id:         ${tenantId}`);
  console.log(`scopes:            ${scopes.join(' ')}`);
  console.log(
    `configuration_ids: ${Array.isArray(configurationIds) ? configurationIds.join(',') : configurationIds}`,
  );
  console.log(`ttl:               ${ttl}`);
  console.log(
    `secret:            ${resolved.source === 'env' ? '(from X402_ADMIN_JWT_SECRET)' : resolved.path}`,
  );
  console.log('');
  console.log('Use via:');
  console.log('  export X402_ADMIN_TOKEN=<paste the token above>');
  console.log('  x402 payments list    # hits /api/admin/payments');
  console.log('');
  console.log('Note: this token is NOT valid on /api/payments/* (machine API).');
  console.log('      For that, mint an opaque API key: x402 keys create --scopes process-payments');
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
