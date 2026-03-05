import { libs } from '@decentralchain/decentralchain-transactions';
import axios from 'axios';

const { address, publicKey } = libs.crypto;
const BASE_SEED = '***REDACTED_SEED_PHRASE***';
const CHAIN_ID = 63;
const NODE = 'https://mainnet-node.decentralchain.io';

for (const nodeId of ['validator-1', 'validator-2', 'validator-3']) {
  const seed = `${BASE_SEED}:bridge-signer:${nodeId}`;
  const addr = address(seed, CHAIN_ID);
  const pk = publicKey(seed);
  try {
    const r = await axios.get(`${NODE}/addresses/balance/${addr}`);
    console.log(`${nodeId}: ${addr} (pk: ${pk}) — balance: ${r.data.balance / 100000000} DCC`);
  } catch (e) {
    console.log(`${nodeId}: ${addr} (pk: ${pk}) — balance: error`);
  }
}
