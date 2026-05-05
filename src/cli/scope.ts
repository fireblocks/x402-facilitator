/**
 * CLI-side scope resolver: picks the configuration to operate against.
 * Priority: --configuration flag > CONFIGURATION env var > default_configuration_id.
 */

import { getConfigFile } from '../config/configFile';
import { TenantScope } from '../core/tenantScope';

export function resolveCliScope(configurationOverride?: string): TenantScope {
  const file = getConfigFile();
  const top = file.get();
  const configurationId =
    configurationOverride ||
    process.env.CONFIGURATION ||
    top.default_configuration_id;
  if (!file.findConfiguration(configurationId)) {
    throw new Error(
      `Unknown configuration '${configurationId}'. Available: ${top.configurations
        .map((c) => c.configuration_id)
        .join(', ')}`,
    );
  }
  return { tenantId: top.tenant_id, configurationId };
}
