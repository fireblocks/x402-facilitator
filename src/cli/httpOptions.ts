/**
 * Helper to fold global program options (from `program.opts()`) with
 * per-subcommand overrides into a single CliHttpOptions object.
 */
import { Command } from 'commander';
import { CliHttpOptions, createCliHttpClient, CliHttpClient } from './httpClient';

export function cliClientFrom(cmd: Command, localOverrides?: CliHttpOptions): CliHttpClient {
  // walk up to root to collect --url / --token / -c
  let cursor: Command | null = cmd;
  let globals: CliHttpOptions = {};
  while (cursor) {
    const o = cursor.opts() as Record<string, unknown>;
    if (globals.url === undefined && typeof o.url === 'string') globals.url = o.url;
    if (globals.token === undefined && typeof o.token === 'string') globals.token = o.token;
    if (globals.configuration === undefined && typeof o.configuration === 'string') {
      globals.configuration = o.configuration;
    }
    cursor = cursor.parent;
  }
  return createCliHttpClient({ ...globals, ...(localOverrides ?? {}) });
}
