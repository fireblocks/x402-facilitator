import { Router, Request, Response } from 'express';
import { FacilitatorRepository } from '../repositories/interfaces/FacilitatorRepository';
import { requireUserScope } from '../middleware/auth';
import { ADMIN_READ } from '../auth/principals';

export function createFacilitatorRoutes(facilitator: FacilitatorRepository): Router {
  const router = Router();

  router.get('/', requireUserScope(ADMIN_READ), (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const cfg = facilitator.get(req.scope);
    res.status(200).json({
      publicHost: cfg.publicHost,
      fireblocks: {
        apiKey: redact(cfg.fireblocks.apiKey),
        apiSecretPath: cfg.fireblocks.apiSecretPath,
        receiverVault: cfg.fireblocks.receiverVault,
        baseUrl: cfg.fireblocks.baseUrl,
        depositAddressCache: cfg.fireblocks.depositAddressCache,
      },
    });
  });

  return router;
}

function redact(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
