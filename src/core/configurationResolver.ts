/**
 * ConfigurationResolver — maps a request / principal to a TenantScope.
 *
 * Three strategies, used in three different places:
 *   - Proxy traffic            → byHost() matches Host → configuration's public_host.
 *   - Admin traffic            → fromAdminRequest() reads X-Configuration-ID header
 *                                or `configuration` query param, falling back to
 *                                the default_configuration_id.
 *   - Authenticated principal  → fromPrincipal() uses the scope baked into
 *                                the credential (ApiToken) or the UserPrincipal's
 *                                tenant with a provided / default configuration.
 */

import { Request } from 'express';
import { TenantScope } from './tenantScope';
import { Principal } from '../auth/principals';
import { ConfigFile } from '../config/configFile';

export interface ConfigurationResolver {
  /** Resolve scope for a proxy/x402 request by Host header. null = no match. */
  fromProxyRequest(req: Request): TenantScope | null;

  /** Resolve scope for an admin request (header/query override → default). */
  fromAdminRequest(req: Request): TenantScope;

  /** Scope implied by an authenticated principal. */
  fromPrincipal(principal: Principal, req?: Request): TenantScope;
}

/**
 * Default resolver: reads from the ConfigFile's `configurations[]`.
 * Matches Host (minus port if that's how configs declare themselves)
 * for proxy traffic; falls back to default_configuration_id everywhere.
 */
export class DefaultConfigurationResolver implements ConfigurationResolver {
  constructor(private readonly configFile: ConfigFile) {}

  fromProxyRequest(req: Request): TenantScope | null {
    const hostHeader = (req.headers.host || '').toLowerCase();
    if (!hostHeader) return this.defaultScope();
    const top = this.configFile.get();
    for (const cfg of top.configurations) {
      try {
        const url = new URL(cfg.public_host);
        const candidate = url.host.toLowerCase();
        if (candidate === hostHeader) {
          return { tenantId: top.tenant_id, configurationId: cfg.configuration_id };
        }
      } catch {
        // malformed public_host — skip
      }
    }
    // Fall back to default so single-host deployments Just Work.
    return this.defaultScope();
  }

  fromAdminRequest(req: Request): TenantScope {
    const top = this.configFile.get();
    const override =
      (req.headers['x-configuration-id'] as string | undefined) ||
      (req.query.configuration as string | undefined) ||
      top.default_configuration_id;
    return { tenantId: top.tenant_id, configurationId: override };
  }

  fromPrincipal(principal: Principal, req?: Request): TenantScope {
    if (principal.kind === 'apiToken') {
      return { tenantId: principal.tenantId, configurationId: principal.configurationId };
    }
    // UserPrincipal: allow a header/query override, else default.
    const top = this.configFile.get();
    const override =
      (req?.headers['x-configuration-id'] as string | undefined) ||
      (req?.query?.configuration as string | undefined) ||
      top.default_configuration_id;
    return { tenantId: principal.tenantId, configurationId: override };
  }

  defaultScope(): TenantScope {
    const top = this.configFile.get();
    return { tenantId: top.tenant_id, configurationId: top.default_configuration_id };
  }
}
