import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printJson, success, info, fail } from '../formatting/output';

interface FacilitatorDTO {
  publicHost: string;
  fireblocks: {
    apiKey: string; // redacted server-side
    apiSecretPath: string;
    receiverVault: string;
    baseUrl: string;
    depositAddressCache: Record<string, string>;
  };
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Inspect facilitator config (remote)');

  config
    .command('show')
    .description('Print the facilitator config for the selected configuration (secrets redacted server-side)')
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        const data = await http.get<FacilitatorDTO>('/api/admin/facilitator');
        printJson(data);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  config
    .command('validate')
    .description('Ping the facilitator and confirm config loads (server /api/health + /api/admin/facilitator)')
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        await http.get('/api/admin/facilitator');
        success('Config loads on the server');
      } catch (err) {
        fail((err as Error).message);
      }
    });

  config
    .command('configurations')
    .description('List configurations in this tenant (from the server)')
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        // No list endpoint yet — hit /api/admin/facilitator for the resolved configuration.
        const data = await http.get<FacilitatorDTO>('/api/admin/facilitator');
        info(`selected configuration: ${http.configuration ?? '(server default)'}`);
        info(`public_host:            ${data.publicHost}`);
        info(`receiver_vault:         ${data.fireblocks.receiverVault}`);
        info(`api_secret_path:        ${data.fireblocks.apiSecretPath}`);
        info(`base_url:               ${data.fireblocks.baseUrl}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
