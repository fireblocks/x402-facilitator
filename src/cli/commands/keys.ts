import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printTable, success, info, fail } from '../formatting/output';

interface KeyDTO {
  keyId: string;
  label: string | null;
  scopes: string[];
  tenantId: string;
  configurationId: string;
}

interface IssueResponse {
  token: string;
  keyId: string;
  label: string | null;
  scopes: string[];
}

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage API keys');

  keys
    .command('list')
    .description('List API keys in a configuration')
    .option('--json', 'Output JSON')
    .action(async function (this: Command, opts: { json?: boolean }) {
      try {
        const http = cliClientFrom(this);
        const records = await http.get<KeyDTO[]>('/api/admin/tokens');
        if (opts.json) {
          process.stdout.write(JSON.stringify(records, null, 2) + '\n');
          return;
        }
        printTable(
          ['KEY_ID', 'LABEL', 'SCOPES', 'CONFIGURATION'],
          records.map((r) => [
            r.keyId,
            r.label ?? '(none)',
            r.scopes.join(','),
            r.configurationId,
          ]),
        );
      } catch (err) {
        fail((err as Error).message);
      }
    });

  keys
    .command('create')
    .description('Generate a new API key in a configuration')
    .option('-s, --scopes <scopes>', 'Comma-separated scopes', 'api:read')
    .option('-l, --label <label>', 'Human-readable label')
    .action(async function (this: Command, opts: { scopes: string; label?: string }) {
      try {
        const scopes = opts.scopes.split(',').map((s) => s.trim()).filter(Boolean);
        const http = cliClientFrom(this);
        const result = await http.post<IssueResponse>('/api/admin/tokens', {
          scopes,
          label: opts.label ?? null,
        });
        success('API key created. Copy it now — it will NOT be shown again:');
        info('');
        info(`  ${result.token}`);
        info('');
        info(`key_id:         ${result.keyId}`);
        info(`scopes:         ${result.scopes.join(',')}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  keys
    .command('revoke <keyId>')
    .description('Remove an API key from a configuration')
    .action(async function (this: Command, keyId: string) {
      try {
        const http = cliClientFrom(this);
        await http.del(`/api/admin/tokens/${encodeURIComponent(keyId)}`);
        success(`Revoked ${keyId}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
