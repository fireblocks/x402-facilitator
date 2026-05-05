export { InMemoryPaymentRepository } from './InMemoryPaymentRepository';
export { SqlitePaymentRepository } from './SqlitePaymentRepository';
export { SqlPaymentRepository } from './SqlPaymentRepository';

import type { PaymentRepository } from '../interfaces/PaymentRepository';
import { InMemoryPaymentRepository } from './InMemoryPaymentRepository';
import { SqlitePaymentRepository } from './SqlitePaymentRepository';
import { SqlPaymentRepository } from './SqlPaymentRepository';

/**
 * Select + construct a payment repository from env / explicit options.
 *
 * Honors PAYMENT_STORE = memory | sqlite | postgres (default: sqlite).
 */
export async function createPaymentRepository(backend?: string): Promise<PaymentRepository> {
  const choice = (backend || process.env.PAYMENT_STORE || 'sqlite').toLowerCase();
  switch (choice) {
    case 'memory':
      return new InMemoryPaymentRepository();
    case 'sqlite':
      return new SqlitePaymentRepository();
    case 'postgres':
    case 'pg':
    case 'sql': {
      const repo = new SqlPaymentRepository();
      await repo.init();
      return repo;
    }
    default:
      throw new Error(
        `Unknown PAYMENT_STORE '${choice}'. Valid: memory, sqlite, postgres`,
      );
  }
}
