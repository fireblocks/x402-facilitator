import crypto from 'crypto';
import { ConfigFile } from '../../config/configFile';
import { TenantScope, formatScope } from '../../core/tenantScope';
import { ApiTokenPrincipal } from '../../auth/principals';
import {
  ApiTokenRecord,
  ApiTokenRepository,
  IssueTokenInput,
  IssueTokenResult,
} from '../interfaces/ApiTokenRepository';
import { randId } from '../../utils/randId';

/**
 * JSON-backed ApiTokenRepository.
 *
 * Each configuration in the config file has its own api_keys list. A
 * key issued for configuration `merchant-a` can only be used on
 * /api/payments/* requests that resolve to that configuration's scope;
 * verify() returns the configurationId the key was issued under.
 */
export class JsonApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly configFile: ConfigFile) {}

  async issue(scope: TenantScope, input: IssueTokenInput): Promise<IssueTokenResult> {
    this.assertScopeExists(scope);
    const keyId = randId('ak');
    const secret = crypto.randomBytes(24).toString('base64url');
    const token = `x402_${keyId}_${secret}`;
    const hash = hashToken(token);
    this.configFile.updateConfiguration(scope.configurationId, (cur) => ({
      ...cur,
      api_keys: [
        ...cur.api_keys,
        { key_id: keyId, hash, scopes: input.scopes, label: input.label ?? null },
      ],
    }));
    return {
      token,
      record: {
        keyId,
        hashedSecret: hash,
        scopes: input.scopes,
        label: input.label ?? null,
        tenantId: scope.tenantId,
        configurationId: scope.configurationId,
      },
    };
  }

  async revoke(scope: TenantScope, keyId: string): Promise<boolean> {
    this.assertScopeExists(scope);
    let found = false;
    this.configFile.updateConfiguration(scope.configurationId, (cur) => {
      const next = cur.api_keys.filter((k) => {
        if (k.key_id === keyId) {
          found = true;
          return false;
        }
        return true;
      });
      return { ...cur, api_keys: next };
    });
    return found;
  }

  async list(scope: TenantScope): Promise<ApiTokenRecord[]> {
    const cfg = this.configFile.findConfiguration(scope.configurationId);
    if (!cfg || this.configFile.get().tenant_id !== scope.tenantId) return [];
    return cfg.api_keys.map((k) => ({
      keyId: k.key_id,
      hashedSecret: k.hash,
      scopes: k.scopes,
      label: k.label ?? null,
      tenantId: scope.tenantId,
      configurationId: scope.configurationId,
    }));
  }

  async verify(token: string): Promise<ApiTokenPrincipal | null> {
    const hash = hashToken(token);
    const top = this.configFile.get();
    for (const cfg of top.configurations) {
      for (const key of cfg.api_keys) {
        if (timingSafeEqual(key.hash, hash)) {
          return {
            kind: 'apiToken',
            tenantId: top.tenant_id,
            configurationId: cfg.configuration_id,
            keyId: key.key_id,
            scopes: key.scopes,
            label: key.label ?? null,
          };
        }
      }
    }
    return null;
  }

  private assertScopeExists(scope: TenantScope): void {
    const top = this.configFile.get();
    if (scope.tenantId !== top.tenant_id) {
      throw new Error(
        `Tenant mismatch: scope=${formatScope(scope)} but config tenant_id=${top.tenant_id}`,
      );
    }
    if (!this.configFile.findConfiguration(scope.configurationId)) {
      throw new Error(
        `Configuration not found: ${scope.configurationId} (scope=${formatScope(scope)})`,
      );
    }
  }
}

export function hashToken(token: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
