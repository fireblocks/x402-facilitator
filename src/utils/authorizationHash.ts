/**
 * Replay-protection hash for a signed x402 payment authorization.
 *
 * Canonicalises by sorting object keys recursively, then SHA-256s the
 * JSON. Same payload (regardless of property ordering) → same hash.
 * Covers the message + signature, so any modification produces a
 * different key.
 *
 * Used by `/api/payments/settle` to reject duplicate authorizations
 * against `PaymentRepository.isAuthorizationUsed`.
 */

import { createHash } from 'crypto';

export function computeAuthorizationHash(payload: unknown): string {
  const sortedJson = JSON.stringify(payload, sortKeysReplacer);
  return createHash('sha256').update(sortedJson).digest('hex');
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
