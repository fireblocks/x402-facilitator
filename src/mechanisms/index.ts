/**
 * Transfer Mechanism Registry
 * Maps mechanism names to implementations.
 * Adding Permit2 later = add one entry here + the implementation file.
 */

import { ethers } from 'ethers';
import { TransferMechanism } from './TransferMechanism';
import { Eip3009Mechanism } from './Eip3009Mechanism';
import { Permit2Mechanism } from './Permit2Mechanism';
import { UptoPermit2Mechanism } from './UptoPermit2Mechanism';
import { Erc7710Mechanism, ProviderFactory } from './Erc7710Mechanism';
import { FireblocksSettlementFactory } from '../services/fireblocksSettlementFactory';

export function createMechanismRegistry(fireblocksFactory: FireblocksSettlementFactory): MechanismRegistry {
  return new MechanismRegistry(fireblocksFactory);
}

/** Default factory: reads `X402_RPC_URL_<chainId>` from the env. Returning
 *  null is fine — the mechanism rejects verify with a configuration error
 *  rather than silently optimistic-accepting. */
const defaultProviderFactory: ProviderFactory = (chainId) => {
  const url = process.env[`X402_RPC_URL_${chainId}`];
  if (!url) return null;
  return new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
};

export class MechanismRegistry {
  private mechanisms: Record<string, TransferMechanism>;

  constructor(
    fireblocksFactory: FireblocksSettlementFactory,
    providerFactory: ProviderFactory = defaultProviderFactory,
  ) {
    this.mechanisms = {
      'eip-3009': new Eip3009Mechanism(fireblocksFactory),
      'permit2': new Permit2Mechanism(fireblocksFactory),
      'upto-permit2': new UptoPermit2Mechanism(fireblocksFactory),
      'erc7710': new Erc7710Mechanism(fireblocksFactory, providerFactory),
    };
    console.log(`Initialized ${Object.keys(this.mechanisms).length} transfer mechanism(s): ${this.getAvailable().join(', ')}`);
  }

  getMechanism(name: string): TransferMechanism | null {
    return this.mechanisms[name] || null;
  }

  getAvailable(): string[] {
    return Object.keys(this.mechanisms);
  }
}

export { TransferMechanism, VerifyParams, VerifyResult, SettleParams, SettleResult } from './TransferMechanism';
export { Eip3009Mechanism } from './Eip3009Mechanism';
export { Permit2Mechanism } from './Permit2Mechanism';
export { UptoPermit2Mechanism } from './UptoPermit2Mechanism';
export { Erc7710Mechanism } from './Erc7710Mechanism';
