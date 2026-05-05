/**
 * Authentication + authorization + scope resolution middleware.
 *
 *   /api/admin/*     — createUserAuthMiddleware    → UserPrincipal
 *   /api/payments/*  — createApiTokenAuthMiddleware → ApiTokenPrincipal
 *
 * Scope resolution is route-kind-specific:
 *   - Admin:     createAdminScopeMiddleware   (header/query override, falls
 *                back to default; enforces principal has access).
 *   - Payment:   createApiTokenScopeMiddleware (scope = principal's own
 *                configurationId — tokens are per-configuration).
 *   - Proxy:     done inside the proxy handler (host-based).
 */

import { Request, Response, NextFunction } from 'express';
import { ApiTokenRepository } from '../repositories/interfaces/ApiTokenRepository';
import { UserAuthenticator } from '../auth/userAuthenticator';
import {
  Principal,
  principalAllowsConfiguration,
  principalHasScope,
  principalHasAdminScope,
  AdminScope,
} from '../auth/principals';
import { TenantScope } from '../core/tenantScope';
import { ConfigurationResolver } from '../core/configurationResolver';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      scope?: TenantScope;
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

export function createApiTokenAuthMiddleware(tokens: ApiTokenRepository) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const bearer = extractBearer(req);
    if (!bearer) {
      res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
      return;
    }
    const principal = await tokens.verify(bearer);
    if (!principal) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid API token' });
      return;
    }
    req.principal = principal;
    next();
  };
}

export function createUserAuthMiddleware(users: UserAuthenticator) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const principal = await users.verify(req.headers.authorization);
    if (!principal) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Management API requires a valid user credential',
      });
      return;
    }
    req.principal = principal;
    next();
  };
}

/**
 * Admin scope resolver: picks configuration from request (header/query),
 * falls back to default, and verifies the authenticated principal has
 * access to it. Use after createUserAuthMiddleware.
 */
export function createAdminScopeMiddleware(resolver: ConfigurationResolver) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.principal) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const scope = resolver.fromAdminRequest(req);
    // Principal must carry access to this configuration
    if (!principalAllowsConfiguration(req.principal, scope.configurationId)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Principal has no access to configuration '${scope.configurationId}'`,
      });
      return;
    }
    req.scope = scope;
    next();
  };
}

/**
 * Payment scope resolver: scope = the configuration the API token was
 * issued under. Use after createApiTokenAuthMiddleware. Requests cannot
 * override this; tokens are bound to one configuration.
 */
export function createApiTokenScopeMiddleware(resolver: ConfigurationResolver) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.principal) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.scope = resolver.fromPrincipal(req.principal, req);
    next();
  };
}

export function requireScope(scope: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.principal) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }
    if (!principalHasScope(req.principal, scope)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient permissions. Required scope: ${scope}`,
      });
      return;
    }
    next();
  };
}

/**
 * Declare which admin scope an /api/admin/* route needs. Each route
 * picks exactly one of: admin:read | admin:write | payments:read |
 * payments:write. `*` on the principal passes any requirement.
 */
export function requireUserScope(required: AdminScope) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.principal) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }
    if (!principalHasAdminScope(req.principal, required)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Required scope: ${required}`,
      });
      return;
    }
    next();
  };
}
