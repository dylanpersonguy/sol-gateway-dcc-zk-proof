/**
 * Quick redeploy of Contract B — script only, no VK reset.
 */
import fs from 'fs';
import axios from 'axios';
import { setScript, libs } from '@decentralchain/decentralchain-transactions';

import dotenv from 'dotenv';
dotenv.config();

function required(name) { const v = process.env[name]; if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); } return v; }

const NODE = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY = required('DCC_API_KEY');
const BASE_SEED = required('DCC_VALIDATOR_SEED');
const { seedWithNonce, publicKey, privateKey } = libs.crypto;
const B_SEED = seedWithNonce(BASE_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractBPubKey = publicKey(B_SEED);

const rideSource = fs.readFileSync('dcc/contracts/bridge/zk_verifier.ride', 'utf8');
const compileRes = await axios.post(NODE + '/utils/script/compileCode', rideSource, {
  headers: { 'Content-Type': 'text/plain', 'X-API-Key': API_KEY },
});

if (compileRes.data.error) {
  console.error('Compile failed:', compileRes.data.message);
  process.exit(1);
}
console.log('Compiled. Complexity:', compileRes.data.complexity);

const tx = setScript({
  script: compileRes.data.script,
  fee: 14000000,
  chainId: 63,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const broadcastRes = await axios.post(NODE + '/transactions/broadcast', tx, {
  headers: { 'X-API-Key': API_KEY },
});
console.log('SetScript broadcast:', broadcastRes.data.id);

// Wait for confirmation
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await axios.get(NODE + '/transactions/info/' + broadcastRes.data.id);
    if (r.data?.id) {
      console.log('Confirmed!');
      break;
    }
  } catch {}
}

console.log('Done — Contract B updated');
