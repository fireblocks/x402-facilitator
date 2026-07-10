import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigFile } from '../../src/config/configFile';
import { DefaultConfigurationResolver } from '../../src/core/configurationResolver';

describe('DefaultConfigurationResolver.fromProxyRequest', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-resolver-'));
    configPath = path.join(tempDir, 'facilitator.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          tenant_id: 'tenant_test',
          default_configuration_id: 'cfg_a',
          assets: [],
          configurations: [
            {
              configuration_id: 'cfg_a',
              public_host: 'https://a.example.test',
              fireblocks: {
                api_key: 'key-a',
                api_secret_path: '/tmp/secret-a',
                receiver_vault: 'vault-a',
                base_url: 'https://api.fireblocks.io',
                deposit_address_cache: {},
              },
              api_keys: [],
              products: [],
            },
            {
              configuration_id: 'cfg_b',
              public_host: 'https://b.example.test:8443',
              fireblocks: {
                api_key: 'key-b',
                api_secret_path: '/tmp/secret-b',
                receiver_vault: 'vault-b',
                base_url: 'https://api.fireblocks.io',
                deposit_address_cache: {},
              },
              api_keys: [],
              products: [],
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches an exact configured host', () => {
    const resolver = new DefaultConfigurationResolver(new ConfigFile(configPath));
    const scope = resolver.fromProxyRequest({ headers: { host: 'a.example.test' } } as any);
    expect(scope).toEqual({ tenantId: 'tenant_test', configurationId: 'cfg_a' });
  });

  it('matches a configured host that includes a port', () => {
    const resolver = new DefaultConfigurationResolver(new ConfigFile(configPath));
    const scope = resolver.fromProxyRequest({ headers: { host: 'b.example.test:8443' } } as any);
    expect(scope).toEqual({ tenantId: 'tenant_test', configurationId: 'cfg_b' });
  });

  it('returns null for an unknown host', () => {
    const resolver = new DefaultConfigurationResolver(new ConfigFile(configPath));
    const scope = resolver.fromProxyRequest({ headers: { host: 'unknown.example.test' } } as any);
    expect(scope).toBeNull();
  });

  it('returns null when the host header is missing', () => {
    const resolver = new DefaultConfigurationResolver(new ConfigFile(configPath));
    const scope = resolver.fromProxyRequest({ headers: {} } as any);
    expect(scope).toBeNull();
  });
});
