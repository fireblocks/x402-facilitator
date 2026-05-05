/**
 * Thin client for the x402 facilitator's payment-processing API.
 * Uses native fetch — no extra dependencies.
 */

import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from './types';

export interface FacilitatorClientOptions {
  /** Base URL of the facilitator (e.g. "https://facilitator.example.com"). */
  baseUrl: string;
  /** Bearer API key with `process-payments` scope. */
  apiKey: string;
  /** Optional request timeout in ms (default 30s). */
  timeoutMs?: number;
}

export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: FacilitatorClientOptions) {
    if (!opts.baseUrl) throw new Error('FacilitatorClient: baseUrl required');
    if (!opts.apiKey) throw new Error('FacilitatorClient: apiKey required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Ask the facilitator to build a PaymentRequired body for a product.
   * Returns the exact quote the facilitator knows about — asset address,
   * decimals, EIP-712 domain, cached deposit address, all of it.
   */
  async createForProduct(productId: string): Promise<PaymentRequired> {
    return this.post<PaymentRequired>('/api/payments/create', {
      product_id: productId,
    });
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.post<VerifyResponse>('/api/payments/verify', {
      paymentPayload,
      paymentRequirements,
    });
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.post<SettlementResponse>('/api/payments/settle', {
      paymentPayload,
      paymentRequirements,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const msg =
          typeof (parsed as { error?: string }).error === 'string'
            ? (parsed as { error: string }).error
            : `HTTP ${res.status}`;
        throw new Error(`Facilitator ${path} failed: ${msg}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
