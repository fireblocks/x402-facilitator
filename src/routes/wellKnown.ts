/**
 * Public `/.well-known/did.json` route.
 *
 * When any configuration has `integrity.enabled: true` AND
 * `integrity.serve_did_document: true`, the facilitator serves that
 * configuration's DID document at `/.well-known/did.json`. The
 * configuration is resolved by matching the request's Host header
 * against each configuration's `public_host`. Misses fall through to
 * the default configuration if its integrity block also has
 * `serve_did_document: true`; otherwise 404.
 *
 * `did:web` resolution (from the wallet's perspective) will fetch:
 *   https://<domain-from-did>/.well-known/did.json
 * so this route must be reachable at the same domain the `did:web:…`
 * value encodes. Operators whose facilitator isn't at that domain
 * should leave `serve_did_document: false` and host their own.
 */

import { Router, Request, Response } from 'express';
import { ConfigFile } from '../config/configFile';
import { IntegritySignerFactory } from '../services/integrity/IntegritySigner';
import { DefaultConfigurationResolver } from '../core/configurationResolver';

export function createWellKnownRoutes(
  configFile: ConfigFile,
  resolver: DefaultConfigurationResolver,
  integrityFactory: IntegritySignerFactory,
): Router {
  const router = Router();

  router.get('/did.json', (req: Request, res: Response) => {
    // Prefer host-based resolution so multi-tenant deployments serve
    // each merchant's own DID doc. Falls back to default when no match.
    const scope = resolver.fromProxyRequest(req) ?? resolver.defaultScope();
    const conf = configFile.getConfiguration(scope.configurationId);
    const integrity = conf.integrity;
    if (!integrity || !integrity.enabled || !integrity.serve_did_document) {
      res.status(404).json({
        error: 'DID document not served for this configuration',
        details:
          'Set integrity.enabled and integrity.serve_did_document to true on the configuration whose public_host matches the request Host header.',
      });
      return;
    }
    try {
      const signer = integrityFactory.get(integrity);
      if (!signer) {
        res.status(500).json({ error: 'Integrity signer unavailable' });
        return;
      }
      res
        .status(200)
        .type('application/did+json')
        .json(signer.didDocument());
    } catch (err) {
      console.error('[well-known] did.json error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
