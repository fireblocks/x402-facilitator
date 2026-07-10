import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPaymentRoutes } from '../../src/routes/payments';
import type { PaymentRoutesDeps } from '../../src/routes/payments';
import type { Asset } from '../../src/repositories/interfaces/AssetRepository';
import type { Product } from '../../src/repositories/interfaces/ProductRepository';
import type { TenantScope } from '../../src/core/tenantScope';

const SCOPE: TenantScope = { tenantId: 'tenant_test', configurationId: 'cfg_a' };
const FACILITATOR = '0x00000000000000000000000000000000000000fa';

const asset: Asset = {
  assetId: 'USDC_TEST',
  blockchainId: 'chain-84532',
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  decimals: 6,
  chainId: 84532,
  eip712Name: 'USDC',
  eip712Version: '2',
  transferMechanism: 'upto-permit2',
  isTestnet: true,
  stable: true,
  priceSymbol: null,
};

const unusedAsset: Asset = {
  assetId: 'ETH_UNUSED',
  blockchainId: 'chain-11155111',
  address: '0x0000000000000000000000000000000000000009',
  decimals: 18,
  chainId: 11155111,
  eip712Name: 'ETH',
  eip712Version: '1',
  transferMechanism: 'permit2',
  isTestnet: true,
  stable: false,
  priceSymbol: 'ethereum',
};

const product: Product = {
  productId: 'prod_upto',
  name: 'Upto Product',
  endpoint: '/premium',
  scheme: 'upto',
  usdPrice: null,
  pricing: [{ assetId: asset.assetId, amount: 1000, transferMechanism: 'upto-permit2' }],
  description: 'test product',
  mimeType: 'application/json',
  category: 'content',
  isDiscoverable: false,
};

function makeDeps(mechanismVerify = vi.fn().mockResolvedValue({ valid: true, signer: '0xpayer' })): PaymentRoutesDeps {
  const mechanismSettle = vi.fn().mockResolvedValue({
    success: true,
    transactionHash: '0xsettled',
    blockNumber: 1,
  });
  return {
    facilitator: {
      get: vi.fn().mockReturnValue({
        publicHost: 'https://a.example.test',
        fireblocks: {
          apiKey: 'key',
          apiSecretPath: '/tmp/secret',
          receiverVault: 'vault',
          baseUrl: 'https://api.fireblocks.io',
          depositAddressCache: { [asset.assetId]: FACILITATOR },
        },
      }),
      reload: vi.fn(),
    } as any,
    assets: {
      get: vi.fn((assetId: string) => {
        if (assetId === asset.assetId) return asset;
        if (assetId === unusedAsset.assetId) return unusedAsset;
        return undefined;
      }),
      list: vi.fn(() => [asset, unusedAsset]),
    } as any,
    products: {
      get: vi.fn((_scope: TenantScope, productId: string) => (productId === product.productId ? product : undefined)),
      list: vi.fn(() => [product]),
      getByEndpoint: vi.fn(),
    } as any,
    payments: {
      create: vi.fn().mockResolvedValue({ paymentId: 'pay_1' }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      markVerified: vi.fn().mockResolvedValue(undefined),
      markSettling: vi.fn().mockResolvedValue(undefined),
      attachFireblocksTxId: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    } as any,
    mechanismRegistry: {
      getMechanism: vi.fn().mockReturnValue({
        verify: mechanismVerify,
        settle: mechanismSettle,
      }),
      getAvailable: vi.fn(() => ['upto-permit2']),
    } as any,
    fireblocksFactory: {} as any,
    pricing: {
      quoteProduct: vi.fn().mockResolvedValue({
        quotes: [{ asset, mechanism: 'upto-permit2', amountBaseUnits: 1000n, priceUsd: null, pricedAt: null, gasCostUsd: 0, source: 'native' }],
        rejected: [],
      }),
    } as any,
    integrityFactory: {} as any,
    configFile: {
      getConfiguration: vi.fn().mockReturnValue({ integrity: undefined }),
    } as any,
  };
}

function makeApp(deps: PaymentRoutesDeps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.scope = SCOPE;
    req.principal = {
      kind: 'apiToken',
      tenantId: SCOPE.tenantId,
      configurationId: SCOPE.configurationId,
      keyId: 'ak_1',
      scopes: ['process-payments'],
      label: null,
    };
    next();
  });
  app.use('/api/payments', createPaymentRoutes(deps));
  return app;
}

function uptoBody(withFacilitatorAddress: boolean) {
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: 'upto',
        network: 'eip155:84532',
        amount: '1000',
        asset: asset.address,
        payTo: FACILITATOR,
        maxTimeoutSeconds: 300,
        extra: withFacilitatorAddress
          ? { name: 'USDC', version: '2', productId: product.productId, facilitatorAddress: FACILITATOR }
          : { name: 'USDC', version: '2', productId: product.productId },
      },
      payload: {
        signature: {
          v: 27,
          r: '0x' + '1'.repeat(64),
          s: '0x' + '2'.repeat(64),
        },
        permit2Authorization: {
          permitted: { token: asset.address, amount: '1000' },
          from: '0x00000000000000000000000000000000000000ab',
          spender: '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002',
          nonce: '1',
          deadline: String(Math.floor(Date.now() / 1000) + 3600),
          witness: {
            to: FACILITATOR,
            facilitator: FACILITATOR,
            validAfter: '0',
          },
        },
      },
    },
    paymentRequirements: {
      scheme: 'upto',
      network: 'eip155:84532',
      amount: '1000',
      asset: asset.address,
      payTo: FACILITATOR,
      maxTimeoutSeconds: 300,
      extra: withFacilitatorAddress
        ? { name: 'USDC', version: '2', productId: product.productId, facilitatorAddress: FACILITATOR }
        : { name: 'USDC', version: '2', productId: product.productId },
    },
  };
}

describe('payment routes upto-permit2 facilitator binding', () => {
  it('rejects /verify when facilitatorAddress is missing', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app).post('/api/payments/verify').send(uptoBody(false));
    expect(res.status).toBe(400);
    expect(res.body.details).toMatch(/facilitatorAddress/i);
  });

  it('threads facilitatorAddress into the mechanism verifier', async () => {
    const mechanismVerify = vi.fn().mockResolvedValue({ valid: true, signer: '0xpayer' });
    const app = makeApp(makeDeps(mechanismVerify));
    const res = await request(app).post('/api/payments/verify').send(uptoBody(true));
    expect(res.status).toBe(200);
    const verifyArgs = mechanismVerify.mock.calls[0][0];
    expect(verifyArgs.message.expectedFacilitator).toBe(FACILITATOR);
  });

  it('rejects /settle when facilitatorAddress is missing', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app).post('/api/payments/settle').send(uptoBody(false));
    expect(res.status).toBe(400);
    expect(res.body.details).toMatch(/facilitatorAddress/i);
  });

  it('limits /supported to assets referenced by products in scope', async () => {
    const app = makeApp(makeDeps());
    const res = await request(app).get('/api/payments/supported');
    expect(res.status).toBe(200);
    expect(res.body.kinds).toEqual([
      { x402Version: 2, scheme: 'upto', network: 'eip155:84532' },
    ]);
    expect(res.body.signers).toEqual({
      'eip155:84532': [FACILITATOR],
    });
    expect(res.body.signers['eip155:11155111']).toBeUndefined();
  });
});
