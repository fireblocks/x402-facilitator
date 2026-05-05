/**
 * Payment Instruction Integrity (PII) signer.
 *
 * Produces the signed envelope the facilitator emits alongside
 * `/api/payments/create` responses, letting wallets verify that the
 * 402 body wasn't tampered with between the service provider and the
 * wallet.
 *
 * Envelope (base64url JSON):
 *   {
 *     v: 1,
 *     did: "did:web:…",
 *     kid: "key-1",
 *     alg: "ES256",
 *     iat: <unix s>,
 *     exp: <unix s>,
 *     sig: <base64url(P1363 signature)>
 *   }
 *
 * Canonical payload (extension of the draft spec for V2 multi-accept):
 *   SHA-256( JCS({x402Version, accepts}) || "\n" || iat || "\n" || exp )
 *
 * where JCS is RFC 8785 JSON Canonicalization of the payment-critical
 * slice of the V2PaymentRequired body: the version marker and the
 * accepts[] array. `resource.url`, `error`, and `extensions` are
 * intentionally excluded — the merchant SDK rewrites resource.url to
 * its own public origin before emitting the 402, so signing it would
 * invalidate every response. The spec's single-accept canonical form
 * (version || scheme || network || amount || asset || payTo || iat ||
 * exp) is a strict subset of JCS(accepts[i]) for length-1 accepts[].
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import canonicalize from 'canonicalize';
import { IntegrityShape } from '../../config/configSchema';

export interface IntegrityEnvelope {
  v: 1;
  did: string;
  kid: string;
  alg: 'ES256';
  iat: number;
  exp: number;
  sig: string;
}

export interface SignedIntegrity {
  /** Base64url-encoded JSON of the envelope (what ships in the header). */
  envelope: string;
  /** Decoded envelope — useful for logging/testing. */
  decoded: IntegrityEnvelope;
}

function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Distill the payment-critical slice wallets verify against.
 * `body` is the full V2PaymentRequired; we keep only the fields a
 * tampering attacker could use to misroute or inflate a payment.
 */
export function integritySlice(body: { x402Version?: number; accepts?: unknown[] }): {
  x402Version: number;
  accepts: unknown[];
} {
  return {
    x402Version: body.x402Version ?? 2,
    accepts: Array.isArray(body.accepts) ? body.accepts : [],
  };
}

/**
 * Compute the canonical bytes the signature covers.
 * Exported so wallets / tests can reconstruct it deterministically.
 */
export function canonicalPayload(body: unknown, iat: number, exp: number): Uint8Array {
  const slice = integritySlice(body as { x402Version?: number; accepts?: unknown[] });
  const jcs = canonicalize(slice);
  if (jcs === undefined) throw new Error('Failed to canonicalize body (undefined)');
  const text = `${jcs}\n${iat}\n${exp}`;
  return Buffer.from(text, 'utf-8');
}

export class IntegritySigner {
  private readonly keyObject: crypto.KeyObject;
  private readonly cachedPublicJwk: crypto.JsonWebKey;

  constructor(private readonly config: IntegrityShape) {
    const keyPath = path.resolve(config.private_key_path);
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        `Integrity private key not found at ${keyPath}. Run \`npm run setup:integrity\` to scaffold one, or point integrity.private_key_path at an existing PEM.`,
      );
    }
    const pem = fs.readFileSync(keyPath, 'utf-8');
    this.keyObject = crypto.createPrivateKey({ key: pem, format: 'pem' });
    if (this.keyObject.asymmetricKeyType !== 'ec') {
      throw new Error(
        `Integrity key must be EC (P-256 for ES256). Got asymmetricKeyType=${this.keyObject.asymmetricKeyType}.`,
      );
    }
    // Derive + cache the public JWK for the DID document route.
    const publicKey = crypto.createPublicKey(this.keyObject);
    this.cachedPublicJwk = publicKey.export({ format: 'jwk' });
    if (this.cachedPublicJwk.crv !== 'P-256') {
      throw new Error(
        `Integrity key must be P-256 (crv=P-256). Got crv=${this.cachedPublicJwk.crv}.`,
      );
    }
  }

  sign(body: unknown): SignedIntegrity {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.config.ttl_seconds;
    const canonical = canonicalPayload(body, iat, exp);
    // Node's sign('SHA256') with an EC key produces DER; we need the
    // JOSE P1363 (R||S, 64 bytes) form, so we pass dsaEncoding: 'ieee-p1363'.
    const sig = crypto.sign('SHA256', canonical, {
      key: this.keyObject,
      dsaEncoding: 'ieee-p1363',
    });
    const envelope: IntegrityEnvelope = {
      v: 1,
      did: this.config.did,
      kid: this.config.kid,
      alg: 'ES256',
      iat,
      exp,
      sig: base64url(sig),
    };
    const envJson = JSON.stringify(envelope);
    return { envelope: base64url(Buffer.from(envJson, 'utf-8')), decoded: envelope };
  }

  /**
   * Build the `did:web` document this signer publishes. Consumed by
   * GET /.well-known/did.json when `serve_did_document: true`.
   */
  didDocument(): Record<string, unknown> {
    const verificationMethodId = `${this.config.did}#${this.config.kid}`;
    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
      ],
      id: this.config.did,
      verificationMethod: [
        {
          id: verificationMethodId,
          type: 'JsonWebKey2020',
          controller: this.config.did,
          publicKeyJwk: {
            kty: this.cachedPublicJwk.kty,
            crv: this.cachedPublicJwk.crv,
            x: this.cachedPublicJwk.x,
            y: this.cachedPublicJwk.y,
          },
        },
      ],
      assertionMethod: [verificationMethodId],
    };
  }
}

/**
 * Factory — caches one signer per (integrityConfig identity) so we
 * don't re-parse the PEM on every request.
 */
export class IntegritySignerFactory {
  private cache = new Map<string, IntegritySigner>();

  get(config: IntegrityShape | undefined): IntegritySigner | null {
    if (!config || !config.enabled) return null;
    const key = `${config.private_key_path}::${config.did}::${config.kid}`;
    const existing = this.cache.get(key);
    if (existing) return existing;
    const signer = new IntegritySigner(config);
    this.cache.set(key, signer);
    return signer;
  }
}
