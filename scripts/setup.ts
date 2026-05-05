#!/usr/bin/env node
/**
 * Local-only bootstrap — scaffolds config/facilitator.json and
 * secrets/jwt-hs256.key.
 *
 * Run once per host via `npm run setup`. The remote CLI (`x402`) does
 * not own this surface because it has to work before a server exists.
 *
 * Flags:
 *   --force   Overwrite existing config and/or JWT secret
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveConfigPath, ConfigFile } from '../src/config/configFile';
import { DEFAULT_HS256_SECRET_PATH } from '../src/auth/jwtSecret';

const STARTER = {
  tenant_id: 'default',
  default_configuration_id: 'default',
  assets: [],
  configurations: [
    {
      configuration_id: 'default',
      public_host: 'http://localhost:3000',
      fireblocks: {
        api_key: '',
        api_secret_path: './secrets/fireblocks.pem',
        receiver_vault: '0',
        base_url: 'https://api.fireblocks.io',
        deposit_address_cache: {},
      },
      api_keys: [],
      products: [],
    },
  ],
};

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function ok(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}
function note(msg: string) {
  console.log(msg);
}
function warn(msg: string) {
  console.log(`${YELLOW}!${RESET} ${msg}`);
}
function die(msg: string): never {
  console.error(`${msg}`);
  process.exit(1);
}

const force = process.argv.slice(2).includes('--force');

// ── config file ──────────────────────────────────────────────────────
const configPath = resolveConfigPath();
if (fs.existsSync(configPath) && !force) {
  warn(`Config already present at ${configPath} — leaving it alone (pass --force to overwrite).`);
} else {
  const cfgDir = path.dirname(configPath);
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
  const file = new ConfigFile(configPath);
  try {
    file.write(STARTER as never);
  } catch (err) {
    die(`Failed to write config: ${(err as Error).message}`);
  }
  ok(`Wrote starter config to ${configPath}`);
}

// ── HS256 signing secret ─────────────────────────────────────────────
const secretPath = DEFAULT_HS256_SECRET_PATH;
const secretDir = path.dirname(secretPath);
if (!fs.existsSync(secretDir)) fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
if (fs.existsSync(secretPath) && !force) {
  warn(`JWT secret already present at ${secretPath} — leaving it alone (pass --force to rotate).`);
} else {
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  ok(`Wrote HS256 JWT secret to ${secretPath}`);
}

// ── ES256 integrity signing key (Payment Instruction Integrity) ─────
// Scaffold only — the configuration's `integrity` block is off by
// default; the operator opts in by flipping `enabled: true` and
// filling in the `did` that matches where the did.json will be served.
const integrityKeyPath = path.resolve('secrets/integrity-p256.pem');
if (fs.existsSync(integrityKeyPath) && !force) {
  warn(
    `Integrity key already present at ${integrityKeyPath} — leaving it alone (pass --force to rotate).`,
  );
} else {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  fs.writeFileSync(integrityKeyPath, pem, { mode: 0o600 });
  ok(`Wrote ES256 integrity key to ${integrityKeyPath}`);
}

// ── next steps ───────────────────────────────────────────────────────
note('');
note('Next steps:');
note(`  1. Edit ${configPath}: fill in fireblocks.api_key + api_secret_path`);
note('  2. npm run dev                                          # starts the facilitator');
note('  3. npm run setup:admin-token -- --preset full           # mint a token for the internal admin API');
note('     export X402_ADMIN_TOKEN=<the printed token>');
note('  4. x402 fireblocks test --create-missing                # activate vault assets');
note('  5. x402 assets import <ASSET_ID> --transfer-mechanism eip-3009 …');
note('  6. x402 products add --name Premium --endpoint /premium --asset <ID> --usd-price 0.01');
note('  7. x402 keys create --scopes process-payments --label merchant');
note('');
note('Optional — Payment Instruction Integrity (signed 402 bodies):');
note('  Add this to a configuration in config/facilitator.json to enable:');
note('    "integrity": {');
note('      "enabled": true,');
note('      "private_key_path": "./secrets/integrity-p256.pem",');
note('      "did": "did:web:localhost%3A3000",');
note('      "kid": "key-1",');
note('      "ttl_seconds": 300,');
note('      "serve_did_document": true');
note('    }');
