/**
 * Send DCC directly to an address (no bridge/gateway)
 */
import { transfer, libs, waitForTx } from '@decentralchain/decentralchain-transactions';
import axios from 'axios';

import dotenv from 'dotenv';
dotenv.config();

function required(name) { const v = process.env[name]; if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); } return v; }

const { address, publicKey, seedWithNonce, privateKey } = libs.crypto;

const BASE_SEED = required('DCC_VALIDATOR_SEED');
const CHAIN_ID = Number(process.env.DCC_CHAIN_ID) || 63;
const NODE = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY = required('DCC_API_KEY');

// Sender: nonce 0 (deployer account)
const FUND_SEED = seedWithNonce(BASE_SEED, 0);
const FUND_SIGNER = { privateKey: privateKey(FUND_SEED) };
const senderAddr = address(FUND_SEED, CHAIN_ID);
const senderPubKey = publicKey(FUND_SEED);

const RECIPIENT = '3DjBg7JHvarrCrPvvknWmbkbSAdQETyADcB';
const AMOUNT_DCC = 500;
const AMOUNT_WAVELETS = AMOUNT_DCC * 1e8; // 1 DCC = 100_000_000 wavelets

console.log(`Sender:    ${senderAddr}`);
console.log(`Recipient: ${RECIPIENT}`);
console.log(`Amount:    ${AMOUNT_DCC} DCC (${AMOUNT_WAVELETS} wavelets)`);

// Check sender balance
const balResp = await axios.get(`${NODE}/addresses/balance/${senderAddr}`);
const balanceDCC = balResp.data.balance / 1e8;
console.log(`Balance:   ${balanceDCC} DCC`);

if (balResp.data.balance < AMOUNT_WAVELETS + 500000) {
  console.error(`❌ Insufficient balance. Need ${AMOUNT_DCC} DCC + fee, have ${balanceDCC} DCC`);
  process.exit(1);
}

const tx = transfer({
  recipient: RECIPIENT,
  amount: AMOUNT_WAVELETS,
  fee: 500000,            // min fee for smart account
  chainId: CHAIN_ID,
  senderPublicKey: senderPubKey,
}, FUND_SIGNER);

console.log(`\nBroadcasting transfer...`);

try {
  const resp = await axios.post(`${NODE}/transactions/broadcast`, tx, {
    headers: { 'X-API-Key': API_KEY },
  });
  console.log(`✅ Transaction broadcast!`);
  console.log(`   Tx ID: ${resp.data.id}`);
  
  // Wait for confirmation
  console.log('Waiting for confirmation...');
  await waitForTx(resp.data.id, { apiBase: NODE, timeout: 60000 });
  console.log(`✅ Confirmed! Sent ${AMOUNT_DCC} DCC to ${RECIPIENT}`);
} catch (e) {
  console.error(`❌ Failed:`, e.response?.data || e.message);
  process.exit(1);
}
