/**
 * Redeploy Contract B (ZK Verifier) with fixed committee member check
 */
import fs from 'fs';
import axios from 'axios';
import { setScript, libs } from '@decentralchain/decentralchain-transactions';

const NODE = 'https://mainnet-node.decentralchain.io';
const API_KEY = '***REDACTED_API_KEY***';
const BASE_SEED = '***REDACTED_SEED_PHRASE***';
const CHAIN_ID = 63;

const { seedWithNonce, address, publicKey, privateKey } = libs.crypto;
const B_SEED = seedWithNonce(BASE_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractBAddr = address(B_SEED, CHAIN_ID);
const contractBPubKey = publicKey(B_SEED);
console.log('Contract B address:', contractBAddr);
console.log('Expected: 3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6');

const compiled = JSON.parse(fs.readFileSync('/tmp/zk_verifier_compiled.json', 'utf8'));
console.log('Script length:', compiled.script.length);

const tx = setScript({
  script: compiled.script,
  fee: 14000000,
  chainId: CHAIN_ID,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

console.log('SetScript tx id:', tx.id);
console.log('Broadcasting...');

try {
  const r = await axios.post(NODE + '/transactions/broadcast', tx, {
    headers: { 'X-API-Key': API_KEY }
  });
  console.log('Broadcast OK:', r.data.id);
} catch (e) {
  console.error('Broadcast failed:', e.response?.data || e.message);
}
