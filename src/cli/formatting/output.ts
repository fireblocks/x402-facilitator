/**
 * Minimal CLI output helpers. No external deps — avoids pulling in cli-table3.
 */

export function printTable(columns: string[], rows: (string | number | null | undefined)[][]): void {
  const normalised = rows.map((r) =>
    r.map((v) => (v === null || v === undefined ? '' : String(v))),
  );
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...normalised.map((r) => r[i]?.length ?? 0)),
  );
  const pad = (s: string, w: number) => s.padEnd(w, ' ');
  const header = columns.map((c, i) => pad(c, widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  process.stdout.write(header + '\n');
  process.stdout.write(sep + '\n');
  for (const r of normalised) {
    process.stdout.write(r.map((v, i) => pad(v, widths[i])).join('  ') + '\n');
  }
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
  }
}

export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function success(msg: string): void {
  process.stdout.write(`✓ ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(msg + '\n');
}

export function fail(msg: string): never {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}
