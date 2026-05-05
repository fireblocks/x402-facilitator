// x402 v2 protocol types. Domain entities (Payment, Product, Asset, etc.)
// live in src/repositories/interfaces/.

/**
 * Standardized error codes from x402 spec section 9
 */
export enum X402ErrorCode {
  InsufficientFunds = "insufficient_funds",
  InvalidSignature = "invalid_exact_evm_payload_signature",
  InvalidPayloadAuthorizationValidBefore = "invalid_exact_evm_payload_authorization_valid_before",
  InvalidPayloadAuthorizationValidAfter = "invalid_exact_evm_payload_authorization_valid_after",
  InvalidPayloadAuthorizationValueMismatch = "invalid_exact_evm_payload_authorization_value_mismatch",
  InvalidPayloadRecipientMismatch = "invalid_exact_evm_payload_recipient_mismatch",
  InvalidPayload = "invalid_payload",
  InvalidPaymentRequirements = "invalid_payment_requirements",
  InvalidNetwork = "invalid_network",
  InvalidScheme = "invalid_scheme",
  InvalidTransactionState = "invalid_transaction_state",
  UnexpectedSettleError = "unexpected_settle_error",
  UnexpectedVerifyError = "unexpected_verify_error",
  UnsupportedScheme = "unsupported_scheme",
  Permit2AllowanceRequired = "permit2_allowance_required",
}

export interface V2PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod?: string;
    name: string;
    version: string;
    [key: string]: unknown;
  };
}

export interface V2Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface V2PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: V2Resource;
  accepts: V2PaymentRequirements[];
  extensions?: Record<string, unknown>;
  /**
   * Optional Payment Instruction Integrity envelope (base64url JSON).
   * When present, wallets SHOULD fetch the DID document identified by
   * the envelope's `did` field and verify the signature covers the
   * canonical form of this body. The merchant SDK mirrors this value
   * onto the response as `X-402-Integrity`.
   */
  integrity?: string;
}

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface Permit2Authorization {
  permitted: { token: string; amount: string };
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; validAfter: string };
}

export interface UptoPermit2Authorization {
  permitted: { token: string; amount: string };
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; facilitator: string; validAfter: string };
}

export interface Erc7710DelegationPayload {
  delegationManager: string;
  permissionContext: string;
  delegator: string;
}

export interface V2PaymentPayload {
  x402Version: 2;
  resource?: V2Resource;
  accepted: V2PaymentRequirements;
  payload: {
    signature: string;
    authorization?: Eip3009Authorization;
    permit2Authorization?: Permit2Authorization | UptoPermit2Authorization;
    delegation?: Erc7710DelegationPayload;
  };
  extensions?: Record<string, unknown>;
}

export interface V2SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export interface V2VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface V2FacilitatorRequest {
  x402Version: 2;
  paymentPayload: V2PaymentPayload;
  paymentRequirements: V2PaymentRequirements;
}

export interface V2SupportedResponse {
  kinds: Array<{ x402Version: 2; scheme: string; network: string }>;
  extensions: string[];
  signers: Record<string, string[]>;
}
