import { ConfigFile } from '../../config/configFile';
import { TenantScope, formatScope } from '../../core/tenantScope';
import {
  FacilitatorConfig,
  FacilitatorRepository,
} from '../interfaces/FacilitatorRepository';

export class JsonFacilitatorRepository implements FacilitatorRepository {
  constructor(private readonly configFile: ConfigFile) {}

  get(scope: TenantScope): FacilitatorConfig {
    this.assertTenant(scope);
    const block = this.configFile.getConfiguration(scope.configurationId);
    return {
      publicHost: block.public_host,
      fireblocks: {
        apiKey: block.fireblocks.api_key,
        apiSecretPath: block.fireblocks.api_secret_path,
        receiverVault: block.fireblocks.receiver_vault,
        baseUrl: block.fireblocks.base_url,
        depositAddressCache: { ...block.fireblocks.deposit_address_cache },
      },
    };
  }

  reload(): void {
    this.configFile.reload();
  }

  private assertTenant(scope: TenantScope): void {
    const tenant = this.configFile.get().tenant_id;
    if (scope.tenantId !== tenant) {
      throw new Error(
        `Scope tenant '${scope.tenantId}' does not match configured tenant '${tenant}' (scope=${formatScope(scope)})`,
      );
    }
  }
}
