/**
 * x402 wire types the middleware uses. Kept narrow — callers don't
 * need to pull zod or anything else.
 */

export interface PaymentRequirements {
  scheme: 'exact' | 'upto';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod?: string;
    name: string;
    version: string;
    [k: string]: unknown;
  };
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
  /**
   * Optional Payment Instruction Integrity envelope (base64url JSON)
   * produced by the facilitator. When present, the middleware mirrors
   * it as the `X-402-Integrity` response header so spec-compliant
   * wallets can verify the 402 body wasn't tampered with.
   */
  integrity?: string;
}

export interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: {
    signature: string;
    authorization?: unknown;
    permit2Authorization?: unknown;
    delegation?: unknown;
  };
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}
