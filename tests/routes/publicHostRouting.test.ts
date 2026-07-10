import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigFile } from '../../src/config/configFile';
import { DefaultConfigurationResolver } from '../../src/core/configurationResolver';
import { JsonAssetRepository } from '../../src/repositories/json/JsonAssetRepository';
import { JsonFacilitatorRepository } from '../../src/repositories/json/JsonFacilitatorRepository';
import { JsonProductRepository } from '../../src/repositories/json/JsonProductRepository';
import { createDiscoveryRoutes } from '../../src/routes/discovery';
import { createWellKnownRoutes } from '../../src/routes/wellKnown';
import { IntegritySignerFactory } from '../../src/services/integrity/IntegritySigner';

describe('public host routing', () => {
  let tempDir: string;
  let configPath: string;
  let keyAPath: string;
  let keyBPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-public-host-'));
    configPath = path.join(tempDir, 'facilitator.json');
    keyAPath = path.join(tempDir, 'a-key.pem');
    keyBPath = path.join(tempDir, 'b-key.pem');
    fs.writeFileSync(
      keyAPath,
      crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }) as string,
    );
    fs.writeFileSync(
      keyBPath,
      crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }) as string,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          tenant_id: 'tenant_test',
          default_configuration_id: 'cfg_a',
          assets: [
            {
              asset_id: 'USDC_TEST',
              blockchain_id: 'chain-84532',
              address: '0x0000000000000000000000000000000000000001',
              decimals: 6,
              chain_id: 84532,
              eip712_name: 'USDC',
              eip712_version: '2',
              transfer_mechanism: 'permit2',
              is_testnet: true,
              stable: true,
              price_symbol: null,
            },
          ],
          configurations: [
            {
              configuration_id: 'cfg_a',
              public_host: 'https://a.example.test',
              fireblocks: {
                api_key: 'key-a',
                api_secret_path: '/tmp/secret-a',
                receiver_vault: 'vault-a',
                base_url: 'https://api.fireblocks.io',
                deposit_address_cache: { USDC_TEST: '0x00000000000000000000000000000000000000aa' },
              },
              api_keys: [],
              products: [
                {
                  product_id: 'prod_a',
                  name: 'Merchant A Product',
                  endpoint: '/premium-a',
                  scheme: 'exact',
                  pricing: [{ asset_id: 'USDC_TEST', amount: 1000 }],
                  description: 'A product',
                  mime_type: 'application/json',
                  category: 'content',
                  is_discoverable: true,
                },
              ],
              integrity: {
                enabled: true,
                private_key_path: keyAPath,
                did: 'did:web:a.example.test',
                kid: 'key-a',
                alg: 'ES256',
                ttl_seconds: 300,
                serve_did_document: true,
              },
            },
            {
              configuration_id: 'cfg_b',
              public_host: 'https://b.example.test',
              fireblocks: {
                api_key: 'key-b',
                api_secret_path: '/tmp/secret-b',
                receiver_vault: 'vault-b',
                base_url: 'https://api.fireblocks.io',
                deposit_address_cache: { USDC_TEST: '0x00000000000000000000000000000000000000bb' },
              },
              api_keys: [],
              products: [
                {
                  product_id: 'prod_b',
                  name: 'Merchant B Product',
                  endpoint: '/premium-b',
                  scheme: 'exact',
                  pricing: [{ asset_id: 'USDC_TEST', amount: 2000 }],
                  description: 'B product',
                  mime_type: 'application/json',
                  category: 'content',
                  is_discoverable: true,
                },
              ],
              integrity: {
                enabled: true,
                private_key_path: keyBPath,
                did: 'did:web:b.example.test',
                kid: 'key-b',
                alg: 'ES256',
                ttl_seconds: 300,
                serve_did_document: true,
              },
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

  function appForTests() {
    const configFile = new ConfigFile(configPath);
    const resolver = new DefaultConfigurationResolver(configFile);
    const app = express();
    app.use(
      '/api/discovery',
      createDiscoveryRoutes(
        new JsonFacilitatorRepository(configFile),
        new JsonAssetRepository(configFile),
        new JsonProductRepository(configFile),
        resolver,
      ),
    );
    app.use('/.well-known', createWellKnownRoutes(configFile, resolver, new IntegritySignerFactory()));
    return app;
  }

  it('serves discovery from the matched configuration host', async () => {
    const app = appForTests();
    const res = await request(app)
      .get('/api/discovery/resources')
      .set('Host', 'b.example.test');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].resource).toBe('https://b.example.test/premium-b');
  });

  it('returns an empty discovery result for an unknown host', async () => {
    const app = appForTests();
    const res = await request(app)
      .get('/api/discovery/resources')
      .set('Host', 'unknown.example.test');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('serves the matched DID document and does not fall back to the default host', async () => {
    const app = appForTests();
    const matched = await request(app)
      .get('/.well-known/did.json')
      .set('Host', 'b.example.test');
    expect(matched.status).toBe(200);
    expect(matched.body.id).toBe('did:web:b.example.test');

    const miss = await request(app)
      .get('/.well-known/did.json')
      .set('Host', 'unknown.example.test');
    expect(miss.status).toBe(404);
    expect(miss.body.error).toMatch(/not served for this host/i);
  });
});
