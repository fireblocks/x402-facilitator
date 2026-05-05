#!/usr/bin/env node
/**
 * x402 — remote admin CLI.
 *
 * Pure HTTP client for the facilitator's /api/admin/* routes. Never
 * touches the server's filesystem, so it's safe to run from a laptop,
 * CI, or a dashboard against a remote facilitator.
 *
 * Needs:
 *   X402_ADMIN_TOKEN   management JWT — mint one locally via
 *                      `npm run setup:token` (or your IDP in prod).
 *   X402_URL           facilitator base URL (default http://localhost:3000)
 *   CONFIGURATION      optional X-Configuration-ID override
 *
 * Local-only operations (init, token-minting, SQLite migration,
 * Fireblocks credential writes) live in `scripts/` and run through
 * `npm run setup[:token|:migrate]`.
 */

import 'dotenv/config';
import { Command } from 'commander';
import { registerConfigCommand } from './commands/config';
import { registerFireblocksCommand } from './commands/fireblocks';
import { registerKeysCommand } from './commands/keys';
import { registerAssetsCommand } from './commands/assets';
import { registerProductsCommand } from './commands/products';
import { registerPaymentsCommand } from './commands/payments';

const program = new Command();
program
  .name('x402')
  .description('x402 facilitator admin CLI (remote HTTP client)')
  .version('1.0.0')
  .option(
    '--url <url>',
    'Facilitator base URL (falls back to X402_URL, then http://localhost:3000)',
  )
  .option(
    '--token <token>',
    'Admin bearer token (falls back to X402_ADMIN_TOKEN)',
  )
  .option(
    '-c, --configuration <id>',
    'Target configuration (sent as X-Configuration-ID; falls back to CONFIGURATION env, then server default)',
  );

registerConfigCommand(program);
registerFireblocksCommand(program);
registerKeysCommand(program);
registerAssetsCommand(program);
registerProductsCommand(program);
registerPaymentsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
