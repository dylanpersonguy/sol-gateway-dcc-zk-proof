/**
 * Fund validator signing accounts with DCC for checkpoint proposal fees
 */
import { transfer, libs, waitForTx, nodeInteraction } from '@decentralchain/decentralchain-transactions';
import axios from 'axios';

const { address, publicKey, seedWithNonce, privateKey } = libs.crypto;
const BASE_SEED = '***REDACTED_SEED_PHRASE***';
const CHAIN_ID = 63;
const NODE = 'https://mainnet-node.decentralchain.io';
const API_KEY = '***REDACTED_API_KEY***';

// Funder: nonce 0 (deployer) — this is a smart account, needs min 500000 fee
const FUND_SEED = seedWithNonce(BASE_SEED, 0);
const FUND_SIGNER = { privateKey: privateKey(FUND_SEED) };
const funderAddr = address(FUND_SEED, CHAIN_ID);
const funderPubKey = publicKey(FUND_SEED);

console.log('Funder:', funderAddr);

// Check funder balance
const funderBal = await axios.get(`${NODE}/addresses/balance/${funderAddr}`);
console.log('Funder balance:', funderBal.data.balance / 1e8, 'DCC');

// Fund each validator signing account with 1 DCC (100_000_000 wavelets)
for (const nodeId of ['validator-1', 'validator-2', 'validator-3']) {
  const seed = `${BASE_SEED}:bridge-signer:${nodeId}`;
  const recipientAddr = address(seed, CHAIN_ID);
  
  console.log(`\nFunding ${nodeId}: ${recipientAddr}`);
  
  const tx = transfer({
    recipient: recipientAddr,
    amount: 100_000_000,  // 1 DCC
    fee: 500000,          // min fee for smart account
    chainId: CHAIN_ID,
    senderPublicKey: funderPubKey,
  }, FUND_SIGNER);
  
  try {
    const resp = await axios.post(`${NODE}/transactions/broadcast`, tx, {
      headers: { 'X-API-Key': API_KEY }
    });
    console.log(`  Tx: ${resp.data.id}`);
    
    // Wait for confirmation
    await new Promise(r => setTimeout(r, 5000));
    console.log(`  ✅ Funded ${nodeId} with 1 DCC`);
  } catch (e) {
    console.error(`  ❌ Failed:`, e.response?.data || e.message);
  }
}

console.log('\nDone! Checking balances...');
await new Promise(r => setTimeout(r, 3000));

for (const nodeId of ['validator-1', 'validator-2', 'validator-3']) {
  const seed = `${BASE_SEED}:bridge-signer:${nodeId}`;
  const addr = address(seed, CHAIN_ID);
  const bal = await axios.get(`${NODE}/addresses/balance/${addr}`);
  console.log(`${nodeId}: ${addr} — ${bal.data.balance / 1e8} DCC`);
}
