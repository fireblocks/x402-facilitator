import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printTable, printJson, success, info, fail } from '../formatting/output';

interface AssetDTO {
  assetId: string;
  blockchainId: string;
  address: string;
  decimals: number;
  chainId: number;
  eip712Name: string;
  eip712Version: string;
  transferMechanism: 'eip-3009' | 'permit2' | 'upto-permit2' | 'erc7710';
  isTestnet: boolean;
  stable: boolean;
  priceSymbol: string | null;
}

// The asset import endpoint still returns snake_case for the
// persisted config entry (since it mirrors the JSON config shape).
interface PersistedAssetShape {
  asset_id: string;
  address: string;
  decimals: number;
  chain_id: number;
}
interface ImportResponse {
  asset: PersistedAssetShape;
  fireblocks: {
    symbol?: string;
    name?: string;
    assetClass?: string;
    standards?: string[];
    deprecated?: boolean;
  };
}

interface SyncResponse {
  diffs: Array<{
    asset_id: string;
    field: 'address' | 'decimals' | 'chain_id' | 'blockchain_id';
    from: string | number | null;
    to: string | number | null;
  }>;
  errors: Array<{ asset_id: string; error: string }>;
  applied: boolean;
}

export function registerAssetsCommand(program: Command): void {
  const assets = program
    .command('assets')
    .description('Manage the global asset catalog (shared across configurations)');

  assets
    .command('list')
    .description('List all assets in the global catalog')
    .option('--json', 'Output JSON')
    .action(async function (this: Command, opts: { json?: boolean }) {
      try {
        const http = cliClientFrom(this);
        const all = await http.get<AssetDTO[]>('/api/admin/assets');
        if (opts.json) return printJson(all);
        printTable(
          ['ASSET_ID', 'ADDRESS', 'DECIMALS', 'CHAIN', 'NET', 'MECHANISM', 'STABLE'],
          all.map((a) => [
            a.assetId,
            a.address,
            a.decimals,
            a.chainId,
            a.isTestnet ? 'testnet' : 'mainnet',
            a.transferMechanism,
            a.stable ? 'yes' : '',
          ]),
        );
      } catch (err) {
        fail((err as Error).message);
      }
    });

  assets
    .command('show <assetId>')
    .description('Show full asset record')
    .action(async function (this: Command, assetId: string) {
      try {
        const http = cliClientFrom(this);
        const asset = await http.get<AssetDTO>(`/api/admin/assets/${encodeURIComponent(assetId)}`);
        printJson(asset);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  assets
    .command('remove <assetId>')
    .description('Remove an asset from the global catalog')
    .action(async function (this: Command, assetId: string) {
      try {
        const http = cliClientFrom(this);
        await http.del(`/api/admin/assets/${encodeURIComponent(assetId)}`);
        success(`Removed ${assetId}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  assets
    .command('import <assetId>')
    .description(
      'Register an asset in the global catalog. The server pulls chain fields (address, decimals, chain_id, blockchain_id) from Fireblocks; x402-specific fields come from flags.',
    )
    .requiredOption(
      '--transfer-mechanism <name>',
      'eip-3009 | permit2 | upto-permit2 | erc7710',
    )
    .requiredOption('--eip712-name <name>', 'EIP-712 domain name (e.g. "USD Coin")')
    .requiredOption('--eip712-version <version>', 'EIP-712 domain version (e.g. "2")')
    .option('--stable', 'Mark as 1:1 USD-pegged', false)
    .option('--price-symbol <symbol>', 'External oracle id (e.g. CoinGecko "ethereum")')
    .option('--force', 'Overwrite an existing asset with this id', false)
    .action(async function (
      this: Command,
      assetId: string,
      opts: {
        transferMechanism: 'eip-3009' | 'permit2' | 'upto-permit2' | 'erc7710';
        eip712Name: string;
        eip712Version: string;
        stable?: boolean;
        priceSymbol?: string;
        force?: boolean;
      },
    ) {
      try {
        const http = cliClientFrom(this);
        info(`POST /api/admin/assets (Fireblocks hydration runs server-side)...`);
        const out = await http.post<ImportResponse>('/api/admin/assets', {
          asset_id: assetId,
          transfer_mechanism: opts.transferMechanism,
          eip712_name: opts.eip712Name,
          eip712_version: opts.eip712Version,
          stable: Boolean(opts.stable),
          price_symbol: opts.priceSymbol ?? null,
          force: Boolean(opts.force),
        });
        if (out.fireblocks.deprecated) {
          info(`⚠ Fireblocks marks this asset as deprecated — registered anyway.`);
        }
        success(`Imported ${out.asset.asset_id} into the global catalog`);
        info(`  address:    ${out.asset.address}`);
        info(`  decimals:   ${out.asset.decimals}`);
        info(`  chain_id:   ${out.asset.chain_id}`);
        info(`  fb symbol:  ${out.fireblocks.symbol ?? ''}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  assets
    .command('sync')
    .description(
      'Re-fetch address/decimals/chain_id/blockchain_id for every asset and show diffs.',
    )
    .option('--apply', 'Write the diffs back to config (default: dry run)')
    .action(async function (this: Command, opts: { apply?: boolean }) {
      try {
        const http = cliClientFrom(this);
        const out = await http.post<SyncResponse>('/api/admin/assets/sync', {
          apply: Boolean(opts.apply),
        });
        if (out.errors.length > 0) {
          for (const e of out.errors) {
            info(`  ⚠ ${e.asset_id}: ${e.error}`);
          }
        }
        if (out.diffs.length === 0) {
          success('Catalog is in sync with Fireblocks.');
          return;
        }
        printTable(
          ['ASSET_ID', 'FIELD', 'FROM', 'TO'],
          out.diffs.map((r) => [r.asset_id, r.field, String(r.from), String(r.to)]),
        );
        if (out.applied) {
          success(`Applied ${out.diffs.length} field update(s).`);
        } else {
          info('\nDry run — re-run with --apply to write these changes.');
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
