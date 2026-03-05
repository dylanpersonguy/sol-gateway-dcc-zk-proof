/**
 * Initialize Committee on DCC Bridge Contract
 *
 * Registers 3 validator Ed25519 public keys as committee members
 * and sets the approval threshold for committeeMint.
 */
import { invokeScript, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

const NODE_URL = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY  = process.env.DCC_API_KEY;
const CHAIN_ID = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED = process.env.DCC_VALIDATOR_SEED;
const DCC_BRIDGE_CONTRACT = process.env.DCC_BRIDGE_CONTRACT;

const { seedWithNonce, privateKey, publicKey, address } = libs.crypto;

// Bridge contract is nonce 1
const SEED = seedWithNonce(BASE_SEED, 1);
const SIGNER = { privateKey: privateKey(SEED) };
const contractAddress = address(SEED, CHAIN_ID);
const contractPubKey = publicKey(SEED);

// Validator DCC signing public keys (base58 from @decentralchain/ts-lib-crypto)
// These are derived from: DCC_VALIDATOR_SEED + ':bridge-signer:validator-N'
const VALIDATOR_PUBKEYS_B58 = [
  'BARDgEpMkhmcaEDExMCbyYnNoXnAk8KPVhWZaTVoXad',   // validator-1
  'F1Ea6eLBEVzmz25Y3VEyDCSDa5DKbzYdW65S9PvWGCzE',  // validator-2
  '6zKmnzWBSjs2z7QzWrWUHpxNgJgpKzUEPPQv6R9ctLya',  // validator-3
];

async function broadcastTx(tx) {
  const r = await fetch(`${NODE_URL}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Node rejected: ${d.message || JSON.stringify(d)}`);
  return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTx(txId, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${NODE_URL}/transactions/info/${txId}`);
      const d = await r.json();
      if (d.id) return d;
    } catch {}
    console.log(`  Waiting... (${i + 1}/${attempts})`);
    await sleep(5000);
  }
  throw new Error(`Tx ${txId} not confirmed`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Initialize Bridge Committee');
  console.log('═══════════════════════════════════════════════════');
  console.log('Contract:', contractAddress);
  console.log('Expected:', DCC_BRIDGE_CONTRACT);
  console.log();

  if (contractAddress !== DCC_BRIDGE_CONTRACT) {
    console.error('CONTRACT ADDRESS MISMATCH!');
    console.error(`Derived: ${contractAddress}`);
    console.error(`Expected: ${DCC_BRIDGE_CONTRACT}`);
    process.exit(1);
  }

  // Check if committee already exists (info only)
  const existingData = await fetch(`${NODE_URL}/addresses/data/${contractAddress}/committee_size`).then(r => r.json());
  if (existingData && existingData.value && existingData.value > 0) {
    console.log('Existing committee size:', existingData.value, '(will overwrite)');
  }

  console.log('Committee members (base58):');
  VALIDATOR_PUBKEYS_B58.forEach((pk, i) => console.log(`  V${i+1}: ${pk}`));
  console.log('Threshold: 2 of 3');
  console.log();

  // Call initializeCommittee(pk1, pk2, pk3, threshold)
  const tx = invokeScript(
    {
      dApp: contractAddress,
      call: {
        function: 'initializeCommittee',
        args: [
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[0] },
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[1] },
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[2] },
          { type: 'integer', value: 2 }, // 2-of-3 threshold
        ],
      },
      payment: [],
      fee: 900000,
      chainId: CHAIN_ID,
      senderPublicKey: contractPubKey,
    },
    SIGNER,
  );

  console.log('Broadcasting initializeCommittee...');
  const resp = await broadcastTx(tx);
  console.log('Tx ID:', resp.id);
  await waitForTx(resp.id);
  console.log();
  console.log('✅ Committee initialized!');
  console.log('  Members:', VALIDATOR_PUBKEYS_B58.length);
  console.log('  Threshold: 2');

  // Verify
  const sizeData = await fetch(`${NODE_URL}/addresses/data/${contractAddress}/committee_size`).then(r => r.json());
  console.log('  On-chain committee_size:', sizeData?.value);
  const threshData = await fetch(`${NODE_URL}/addresses/data/${contractAddress}/approval_threshold`).then(r => r.json());
  console.log('  On-chain approval_threshold:', threshData?.value);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
