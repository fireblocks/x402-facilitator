import { ConfigFile } from '../../config/configFile';
import { Asset, AssetRepository } from '../interfaces/AssetRepository';
import { AssetShape } from '../../config/configSchema';

function toDomain(shape: AssetShape): Asset {
  return {
    assetId: shape.asset_id,
    blockchainId: shape.blockchain_id,
    address: shape.address,
    decimals: shape.decimals,
    chainId: shape.chain_id,
    eip712Name: shape.eip712_name,
    eip712Version: shape.eip712_version,
    transferMechanism: shape.transfer_mechanism,
    isTestnet: shape.is_testnet,
    stable: shape.stable,
    priceSymbol: shape.price_symbol ?? null,
  };
}

export class JsonAssetRepository implements AssetRepository {
  constructor(private readonly configFile: ConfigFile) {}

  get(assetId: string): Asset | undefined {
    const shape = this.configFile.get().assets.find((a) => a.asset_id === assetId);
    return shape ? toDomain(shape) : undefined;
  }

  list(): Asset[] {
    return this.configFile.get().assets.map(toDomain);
  }
}
