import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findMainnetAssets,
  MainnetAssetForbiddenError,
  mainnetAllowed,
} from '../../src/config/networkPolicy';
import type { AssetShape } from '../../src/config/configSchema';

const makeAsset = (overrides: Partial<AssetShape> = {}): AssetShape => ({
  asset_id: 'USDC',
  blockchain_id: 'b-id',
  address: '0x0000000000000000000000000000000000000001',
  decimals: 6,
  chain_id: 84532,
  eip712_name: 'USDC',
  eip712_version: '2',
  transfer_mechanism: 'eip-3009',
  is_testnet: true,
  stable: true,
  price_symbol: null,
  ...overrides,
});

describe('networkPolicy.mainnetAllowed', () => {
  const prev = process.env.X402_ALLOW_MAINNET;
  afterEach(() => {
    if (prev === undefined) delete process.env.X402_ALLOW_MAINNET;
    else process.env.X402_ALLOW_MAINNET = prev;
  });

  it('defaults to false when env var unset', () => {
    delete process.env.X402_ALLOW_MAINNET;
    expect(mainnetAllowed()).toBe(false);
  });

  it('is false unless the string is exactly "true"', () => {
    process.env.X402_ALLOW_MAINNET = 'TRUE';
    expect(mainnetAllowed()).toBe(false);
    process.env.X402_ALLOW_MAINNET = '1';
    expect(mainnetAllowed()).toBe(false);
    process.env.X402_ALLOW_MAINNET = 'yes';
    expect(mainnetAllowed()).toBe(false);
  });

  it('is true when env var is exactly "true"', () => {
    process.env.X402_ALLOW_MAINNET = 'true';
    expect(mainnetAllowed()).toBe(true);
  });
});

describe('networkPolicy.findMainnetAssets', () => {
  it('returns empty when all assets are testnet', () => {
    const result = findMainnetAssets([
      makeAsset({ asset_id: 'USDC_TEST', is_testnet: true }),
      makeAsset({ asset_id: 'ETH_TEST', is_testnet: true, chain_id: 11155111 }),
    ]);
    expect(result).toEqual([]);
  });

  it('returns only mainnet assets', () => {
    const result = findMainnetAssets([
      makeAsset({ asset_id: 'USDC_TEST', is_testnet: true }),
      makeAsset({ asset_id: 'USDC_BASE', is_testnet: false, chain_id: 8453 }),
      makeAsset({ asset_id: 'ETH_TEST5', is_testnet: true, chain_id: 11155111 }),
      makeAsset({ asset_id: 'ETH', is_testnet: false, chain_id: 1 }),
    ]);
    expect(result).toEqual([
      { asset_id: 'USDC_BASE', chain_id: 8453 },
      { asset_id: 'ETH', chain_id: 1 },
    ]);
  });
});

describe('MainnetAssetForbiddenError', () => {
  it('formats a boot-context message', () => {
    const err = new MainnetAssetForbiddenError(
      [{ asset_id: 'USDC_BASE', chain_id: 8453 }],
      'boot',
    );
    expect(err.message).toContain('Refusing to start');
    expect(err.message).toContain('USDC_BASE (chain 8453)');
    expect(err.message).toContain('X402_ALLOW_MAINNET=true');
    expect(err.name).toBe('MainnetAssetForbiddenError');
  });

  it('formats an import-context message', () => {
    const err = new MainnetAssetForbiddenError(
      [{ asset_id: 'ETH', chain_id: 1 }],
      'import',
    );
    expect(err.message).toContain('Refusing to register mainnet asset');
  });
});
