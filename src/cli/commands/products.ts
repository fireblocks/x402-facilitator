import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printTable, printJson, success, fail } from '../formatting/output';

function parseAssetSpec(raw: string): { asset_id: string; amount: number | null } {
  const [id, amt] = raw.split(':');
  if (!id) throw new Error(`Invalid --asset value: ${raw}`);
  if (amt === undefined) return { asset_id: id, amount: null };
  const parsed = Number(amt);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid amount in --asset ${raw}: expected a non-negative number`);
  }
  return { asset_id: id, amount: parsed };
}

interface ProductDTO {
  productId: string;
  name: string;
  endpoint: string;
  scheme: string;
  usdPrice: number | null;
  pricing: Array<{ assetId: string; amount: number | null }>;
  [k: string]: unknown;
}

export function registerProductsCommand(program: Command): void {
  const products = program.command('products').description('Manage configured products');

  products
    .command('list')
    .description('List products in a configuration')
    .option('--json', 'Output JSON')
    .action(async function (this: Command, opts: { json?: boolean }) {
      try {
        const http = cliClientFrom(this);
        const all = await http.get<ProductDTO[]>('/api/admin/products');
        if (opts.json) return printJson(all);
        printTable(
          ['PRODUCT_ID', 'NAME', 'ENDPOINT', 'USD', 'PRICING', 'SCHEME'],
          all.map((p) => [
            p.productId,
            p.name,
            p.endpoint,
            p.usdPrice ?? '',
            p.pricing
              .map((r) => (r.amount !== null && r.amount !== undefined ? `${r.assetId}:${r.amount}` : r.assetId))
              .join(','),
            p.scheme,
          ]),
        );
      } catch (err) {
        fail((err as Error).message);
      }
    });

  products
    .command('show <productId>')
    .description('Show full product record')
    .action(async function (this: Command, productId: string) {
      try {
        const http = cliClientFrom(this);
        const p = await http.get(`/api/admin/products/${encodeURIComponent(productId)}`);
        printJson(p);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  products
    .command('add')
    .description('Add a new product. Pass --asset multiple times to accept several assets.')
    .requiredOption('-n, --name <name>', 'Display name')
    .requiredOption('-e, --endpoint <path>', 'URL path to gate (starts with /)')
    .option(
      '-a, --asset <spec>',
      'Accepted asset. Repeat for multi-asset. Use "id" to convert from --usd-price, or "id:amount" for a native base-unit amount.',
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option('-u, --usd-price <amount>', 'USD price (fractional dollars); required when any --asset has no explicit amount')
    .option('-p, --price <amount>', 'Legacy shorthand for a single-asset native amount; pairs with one --asset <id>')
    .option('--scheme <scheme>', 'x402 scheme: exact | upto', 'exact')
    .option('--description <text>')
    .option('--mime <type>', 'Response MIME type', 'application/json')
    .option('--category <category>')
    .option('--discoverable', 'Publish in the discovery API', false)
    .action(async function (
      this: Command,
      opts: {
        name: string;
        endpoint: string;
        asset: string[];
        usdPrice?: string;
        price?: string;
        scheme: 'exact' | 'upto';
        description?: string;
        mime: string;
        category?: string;
        discoverable?: boolean;
      },
    ) {
      try {
        let pricing = opts.asset.map(parseAssetSpec);
        if (pricing.length === 0) fail('At least one --asset <id>[:amount] is required');

        if (opts.price !== undefined) {
          if (pricing.length !== 1 || pricing[0].amount !== null) {
            fail('--price only works with exactly one --asset <id> (no :amount).');
          }
          pricing = [{ asset_id: pricing[0].asset_id, amount: Number(opts.price) }];
        }

        const usd_price = opts.usdPrice !== undefined ? Number(opts.usdPrice) : null;
        const http = cliClientFrom(this);
        const created = await http.post<ProductDTO>('/api/admin/products', {
          name: opts.name,
          endpoint: opts.endpoint,
          scheme: opts.scheme,
          usd_price,
          pricing,
          description: opts.description ?? null,
          mime_type: opts.mime,
          category: opts.category ?? null,
          is_discoverable: Boolean(opts.discoverable),
        });
        success(`Added product ${created.productId}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  products
    .command('remove <productId>')
    .description('Remove a product from a configuration')
    .action(async function (this: Command, productId: string) {
      try {
        const http = cliClientFrom(this);
        await http.del(`/api/admin/products/${encodeURIComponent(productId)}`);
        success(`Removed ${productId}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
