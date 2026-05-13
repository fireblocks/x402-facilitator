import { Command } from 'commander';
import { cliClientFrom } from '../httpOptions';
import { printTable, printJson, success, fail } from '../formatting/output';

interface PaymentDTO {
  paymentId: string;
  status: string;
  productId: string;
  assetId: string;
  amountBaseUnits: string;
  createdAt: string;
  [k: string]: unknown;
}

export function registerPaymentsCommand(program: Command): void {
  const payments = program.command('payments').description('Inspect payment records');

  payments
    .command('list')
    .description('List payments in a configuration')
    .option('--status <status>', 'Filter by status')
    .option('--limit <n>', 'Max rows', '50')
    .option('--offset <n>', 'Skip rows', '0')
    .option('--json', 'Output JSON')
    .action(async function (this: Command, opts: {
      status?: string;
      limit: string;
      offset: string;
      json?: boolean;
    }) {
      try {
        const http = cliClientFrom(this);
        const all = await http.get<PaymentDTO[]>('/api/admin/payments', {
          status: opts.status,
          limit: Number(opts.limit),
          offset: Number(opts.offset),
        });
        if (opts.json) {
          printJson(all);
        } else {
          printTable(
            ['PAYMENT_ID', 'STATUS', 'PRODUCT', 'ASSET', 'AMOUNT', 'CREATED'],
            all.map((p) => [
              p.paymentId,
              p.status,
              p.productId,
              p.assetId,
              p.amountBaseUnits,
              p.createdAt,
            ]),
          );
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('get <paymentId>')
    .description('Print a single payment as JSON')
    .action(async function (this: Command, paymentId: string) {
      try {
        const http = cliClientFrom(this);
        const payment = await http.get(`/api/admin/payments/${encodeURIComponent(paymentId)}`);
        printJson(payment);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('mark-failed <paymentId>')
    .description('Force a stuck payment row into "failed" status with a reason (no on-chain action)')
    .requiredOption('-r, --reason <reason>', 'Operator-supplied explanation recorded in the error column')
    .action(async function (this: Command, paymentId: string, opts: { reason: string }) {
      try {
        const http = cliClientFrom(this);
        const updated = await http.post(
          `/api/admin/payments/${encodeURIComponent(paymentId)}/mark-failed`,
          { reason: opts.reason },
        );
        success(`Marked ${paymentId} failed`);
        printJson(updated);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('refund <paymentId>')
    .description(
      'Refund a completed/settled payment on-chain via Fireblocks. Only valid against rows whose on-chain leg landed.',
    )
    .action(async function (this: Command, paymentId: string) {
      try {
        const http = cliClientFrom(this);
        const updated = await http.post(
          `/api/admin/payments/${encodeURIComponent(paymentId)}/refund`,
        );
        success(`Refund submitted for ${paymentId}`);
        printJson(updated);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('refund-batch <paymentIds...>')
    .description(
      'Batch-refund N payments in one Fireblocks multi-destination TRANSFER. ' +
        'All payments must share the same asset and be completed/settled. ' +
        'Requires `wallet.ff.evm-multi-dest` enabled on the workspace.',
    )
    .action(async function (this: Command, paymentIds: string[]) {
      try {
        if (paymentIds.length === 0) {
          fail('Provide at least one paymentId.');
          return;
        }
        const http = cliClientFrom(this);
        const result = await http.post<{
          success: boolean;
          refunded: number;
          transactionHash: string;
          fireblocksTxId: string;
          blockNumber: number;
          paymentIds: string[];
        }>('/api/admin/payments/refund-batch', { paymentIds });
        success(
          `Batch refund of ${result.refunded} payment(s) — tx=${result.transactionHash} fbTx=${result.fireblocksTxId}`,
        );
        printJson(result);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('sync <paymentId>')
    .description(
      'Reconcile a settling payment against Fireblocks — asks Fireblocks what state the tx is in and transitions the row accordingly',
    )
    .action(async function (this: Command, paymentId: string) {
      try {
        const http = cliClientFrom(this);
        const updated = await http.post(
          `/api/admin/payments/${encodeURIComponent(paymentId)}/sync`,
        );
        success(`Synced ${paymentId}`);
        printJson(updated);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('sync-all')
    .description(
      'Reconcile every settling payment in the current configuration against Fireblocks',
    )
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        const summary = await http.post<{
          scanned: number;
          completed: number;
          failed: number;
          inFlight: number;
          skipped: number;
        }>('/api/admin/payments/sync-all');
        success(
          `scanned=${summary.scanned} completed=${summary.completed} failed=${summary.failed} in_flight=${summary.inFlight} skipped=${summary.skipped}`,
        );
      } catch (err) {
        fail((err as Error).message);
      }
    });

  payments
    .command('sweep-expired')
    .description('Bulk-expire every pending payment whose expiresAt is in the past')
    .action(async function (this: Command) {
      try {
        const http = cliClientFrom(this);
        const out = await http.post<{ expired: number }>(
          '/api/admin/payments/sweep-expired',
        );
        success(`Expired ${out.expired} row(s)`);
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
