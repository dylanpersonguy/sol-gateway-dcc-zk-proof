/**
 * Upgrade DCC Bridge Contract — Recompile & SetScript Only
 *
 * Deploys the updated zk_bridge.ride without re-initializing.
 * Used after modifying the RIDE contract (e.g., v6 → v5 downgrade).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { setScript, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE_URL   = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY    = required('DCC_API_KEY');
const CHAIN_ID   = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED  = required('DCC_VALIDATOR_SEED');
const BASE_NONCE = parseInt(process.env.DCC_VALIDATOR_NONCE || '1', 10);

const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

const SEED_WITH_NONCE = seedWithNonce(BASE_SEED, BASE_NONCE);
const SIGNER = { privateKey: privateKey(SEED_WITH_NONCE) };
const deployerKeys = {
  address:   address(SEED_WITH_NONCE, CHAIN_ID),
  publicKey: publicKey(SEED_WITH_NONCE),
};

async function apiGet(path) {
  const r = await fetch(NODE_URL + path);
  return r.json();
}

async function broadcastTx(tx) {
  const r = await fetch(`${NODE_URL}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Node rejected tx: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function compileScript(code) {
  const r = await fetch(`${NODE_URL}/utils/script/compileCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-API-Key': API_KEY },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTx(txId, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await apiGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    console.log(`  Waiting for tx ${txId.slice(0, 12)}... (${i + 1}/${attempts})`);
    await sleep(5000);
  }
  throw new Error(`Tx ${txId} not confirmed after ${attempts} attempts`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════');
console.log(' DCC Bridge Contract UPGRADE (SetScript only)');
console.log('═══════════════════════════════════════════════════');
console.log('Node:     ', NODE_URL);
console.log('Chain ID: ', CHAIN_ID);
console.log('Contract: ', deployerKeys.address);
console.log();

// Check balance
const balInfo = await apiGet(`/addresses/balance/${deployerKeys.address}`);
const balDcc = (balInfo.balance || 0) / 1e8;
console.log('Balance:', balDcc.toFixed(4), 'DCC');
if (balDcc < 0.2) {
  throw new Error('Insufficient DCC balance — need at least 0.2 DCC for SetScript fee');
}

// Compile
console.log('Compiling zk_bridge.ride (v5)...');
const RIDE_PATH = process.env.DCC_RIDE_CONTRACT_PATH || 'dcc/contracts/bridge/zk_bridge.ride';
const rideCode = readFileSync(resolve(__dir, RIDE_PATH), 'utf8');
const compiledB64 = await compileScript(rideCode);
console.log('  Compiled OK —', Math.round(compiledB64.length * 3 / 4), 'bytes');

// SetScript
console.log('Broadcasting SetScript...');
const tx = setScript({
  script: compiledB64,
  chainId: CHAIN_ID,
  fee: 14000000,   // 0.14 DCC
  senderPublicKey: deployerKeys.publicKey,
  version: 1,
}, SIGNER);

const resp = await broadcastTx(tx);
console.log('  Tx ID:', resp.id);
console.log('  Waiting for confirmation...');
await waitForTx(resp.id);

console.log();
console.log('✅ Contract upgraded to RIDE v5 on mainnet!');
console.log('  Contract:', deployerKeys.address);
console.log('  Tx:', resp.id);
