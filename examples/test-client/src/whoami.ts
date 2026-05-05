/**
 * Print the wallet address for the configured PRIVATE_KEY. Useful
 * before funding — you paste this into Circle's USDC faucet.
 *
 *   PRIVATE_KEY=0x... npm run whoami
 *
 * If you don't have a key yet, generate one:
 *   node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
 */

import 'dotenv/config';
import { Wallet } from 'ethers';

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error('PRIVATE_KEY is not set.');
  console.error('Generate one with:');
  console.error(
    `  node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"`,
  );
  process.exit(1);
}
const w = new Wallet(pk);
console.log(w.address);
