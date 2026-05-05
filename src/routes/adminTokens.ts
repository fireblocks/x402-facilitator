/**
 * Admin token management — issue, list, revoke API tokens used to access
 * the payment-processing API. Admin auth required.
 */

import { Router, Request, Response } from 'express';
import { ApiTokenRepository } from '../repositories/interfaces/ApiTokenRepository';
import { requireUserScope } from '../middleware/auth';
import { ADMIN_READ, ADMIN_WRITE } from '../auth/principals';

export function createAdminTokenRoutes(tokens: ApiTokenRepository): Router {
  const router = Router();

  router.get('/', requireUserScope(ADMIN_READ), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const records = await tokens.list(req.scope);
    res.status(200).json(
      records.map((r) => ({
        keyId: r.keyId,
        label: r.label,
        scopes: r.scopes,
        tenantId: r.tenantId,
        configurationId: r.configurationId,
      })),
    );
  });

  router.post('/', requireUserScope(ADMIN_WRITE), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const { scopes, label } = req.body as { scopes?: string[]; label?: string };
    if (!Array.isArray(scopes) || scopes.length === 0) {
      res.status(400).json({ error: 'scopes (non-empty string array) is required' });
      return;
    }
    try {
      const result = await tokens.issue(req.scope, { scopes, label: label ?? null });
      res.status(201).json({
        token: result.token,
        keyId: result.record.keyId,
        label: result.record.label,
        scopes: result.record.scopes,
      });
    } catch (err) {
      console.error('[admin/tokens] issue error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/:keyId', requireUserScope(ADMIN_WRITE), async (req: Request, res: Response) => {
    if (!req.scope) {
      res.status(400).json({ error: 'Scope not resolved' });
      return;
    }
    const revoked = await tokens.revoke(req.scope, req.params.keyId as string);
    if (!revoked) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
