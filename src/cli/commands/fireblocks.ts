import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printTable, success, info, fail } from '../formatting/output';

interface ShowDTO {
  configuration_id: string;
  api_key_redacted: string;
  api_secret_path: string;
  receiver_vault: string;
  base_url: string;
  deposit_address_cache: Record<string, string>;
}

type TestResult =
  | {
      mode: 'single-chain';
      chain_id: number;
      address: string;
      created: boolean;
      note?: string;
    }
  | {
      mode: 'multi-asset';
      results: Array<{
        asset_id: string;
        chain_id: number;
        address?: string;
        created?: boolean;
        error?: string;
      }>;
      ok_count: number;
      failed_count: number;
      native_gas_notes: string[];
      cache_updated: number;
    };

export function registerFireblocksCommand(program: Command): void {
  const fb = program.command('fireblocks').description('Manage Fireblocks config (remote)');

  fb.command('show')
    .description('Print Fireblocks config for the selected configuration (api_key redacted)')
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        const cfg = await http.get<ShowDTO>('/api/admin/fireblocks');
        info(`configuration:   ${cfg.configuration_id}`);
        info(`api_key:         ${cfg.api_key_redacted}`);
        info(`api_secret_path: ${cfg.api_secret_path}`);
        info(`receiver_vault:  ${cfg.receiver_vault}`);
        info(`base_url:        ${cfg.base_url}`);
        const entries = Object.entries(cfg.deposit_address_cache);
        if (entries.length === 0) {
          info(`deposit_address_cache: (empty — run 'fireblocks test' to populate)`);
        } else {
          info(`deposit_address_cache:`);
          for (const [assetId, addr] of entries) {
            info(`  ${assetId}: ${addr}`);
          }
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });

  fb.command('test')
    .description(
      'For each configured asset: ensure its vault wallet is activated and cache its deposit address. ' +
        'Pass --chain-id to only activate the native gas asset for one chain (no asset caching).',
    )
    .option('--chain-id <id>', 'Single-chain mode: activate the native gas asset for one chain')
    .option('--create-missing', 'Auto-create vault wallets when the asset is not yet activated', false)
    .action(async function (
      this: Command,
      opts: { chainId?: string; createMissing?: boolean },
    ) {
      try {
        const http = cliClientFrom(this);
        const out = await http.post<TestResult>('/api/admin/fireblocks/test', {
          chain_id: opts.chainId ? Number(opts.chainId) : undefined,
          create_missing: Boolean(opts.createMissing),
        });
        if (out.mode === 'single-chain') {
          printTable(
            ['CHAIN_ID', 'NATIVE ADDRESS', 'CREATED'],
            [[out.chain_id, out.address, out.created ? 'yes' : '']],
          );
          success(out.note ?? `Native gas asset ready on chain ${out.chain_id}.`);
          return;
        }

        printTable(
          ['ASSET_ID', 'CHAIN', 'ADDRESS / ERROR', 'CREATED'],
          out.results.map((r) => [
            r.asset_id,
            r.chain_id,
            r.address ?? `✗ ${r.error ?? ''}`,
            r.created ? 'yes' : '',
          ]),
        );
        if (out.native_gas_notes.length > 0) {
          info('\nNative gas activation notes:');
          for (const n of out.native_gas_notes) info(`  ⚠ ${n}`);
        }
        if (out.failed_count === 0) {
          success(`All ${out.ok_count} asset(s) cached.`);
        } else {
          info(`\n${out.ok_count} ok, ${out.failed_count} failed.`);
          if (!opts.createMissing) {
            info('Tip: re-run with --create-missing to auto-activate missing vault wallets.');
          }
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });

}
