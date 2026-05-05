import { describe, expect, it } from 'vitest';
import { computeAuthorizationHash } from '../../src/utils/authorizationHash';

describe('computeAuthorizationHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = { authorization: { from: '0xA', to: '0xB', value: '100' }, signature: 'sig' };
    expect(computeAuthorizationHash(a)).toBe(computeAuthorizationHash(a));
  });

  it('is property-order-insensitive (canonical-JSON property)', () => {
    const a = {
      authorization: { from: '0xA', to: '0xB', value: '100', nonce: '0x1' },
      signature: { v: 27, r: '0xr', s: '0xs' },
    };
    const b = {
      signature: { s: '0xs', r: '0xr', v: 27 },
      authorization: { nonce: '0x1', to: '0xB', from: '0xA', value: '100' },
    };
    expect(computeAuthorizationHash(a)).toBe(computeAuthorizationHash(b));
  });

  it('changes when ANY field changes (including signature)', () => {
    const base = {
      authorization: { from: '0xA', to: '0xB', value: '100' },
      signature: { v: 27, r: '0xr', s: '0xs' },
    };
    const sigDiff = {
      authorization: { from: '0xA', to: '0xB', value: '100' },
      signature: { v: 28, r: '0xr', s: '0xs' }, // v flipped
    };
    expect(computeAuthorizationHash(base)).not.toBe(computeAuthorizationHash(sigDiff));
  });

  it('changes when the signed message changes (amount)', () => {
    const base = { authorization: { from: '0xA', to: '0xB', value: '100' }, signature: 'sig' };
    const tampered = { authorization: { from: '0xA', to: '0xB', value: '101' }, signature: 'sig' };
    expect(computeAuthorizationHash(base)).not.toBe(computeAuthorizationHash(tampered));
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeAuthorizationHash({ x: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for permit2 vs erc7710 shapes', () => {
    const permit2 = {
      permit2Authorization: { permitted: { token: '0xT', amount: '100' }, witness: { to: '0xR' } },
      signature: 'sig',
    };
    const erc7710 = {
      delegation: { delegationManager: '0xM', permissionContext: '0xCTX', delegator: '0xD' },
      signature: 'sig',
    };
    expect(computeAuthorizationHash(permit2)).not.toBe(computeAuthorizationHash(erc7710));
  });

  it('arrays preserve their order (not sorted)', () => {
    const a = { items: [1, 2, 3] };
    const b = { items: [3, 2, 1] };
    expect(computeAuthorizationHash(a)).not.toBe(computeAuthorizationHash(b));
  });
});
