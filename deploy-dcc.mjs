/**
 * DCC Bridge Controller Deployment Script
 *
 * Steps:
 *  1. Derive deployer address from DCC_VALIDATOR_SEED
 *  2. Compile zk_bridge.ride
 *  3. SetScript tx — deploys the RIDE contract to deployer address
 *  4. InvokeScript tx — calls initialize(guardian, minValidators)
 *  5. InvokeScript tx — calls registerValidator(pubKey)
 *  6. Print final bridge contract address + wSOL asset ID
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setScript,
  invokeScript,
  broadcast,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT   = __dir;  // deploy-dcc.mjs lives at the project root

// ── Config ─────────────────────────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE_URL   = process.env.DCC_NODE_URL || 'https://keough-node.decentralchain.io';
const CHAIN_ID   = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED  = required('DCC_VALIDATOR_SEED');
const BASE_NONCE = parseInt(process.env.DCC_VALIDATOR_NONCE || '0', 10);

const MIN_VALIDATORS = parseInt(process.env.DCC_MIN_VALIDATORS || '1', 10);
const GUARDIAN_ADDRESS = process.env.DCC_GUARDIAN_ADDRESS || '';

// ── Helpers ───────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch(NODE_URL + path);
  return r.json();
}

async function compileScript(code) {
  const r = await fetch(`${NODE_URL}/utils/script/compileCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;  // base64-encoded compiled script
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForTx(txId, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await apiGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    console.log(`  Waiting for tx ${txId.slice(0,12)}...`);
    await sleep(3000);
  }
  throw new Error(`Tx ${txId} not confirmed after ${attempts} attempts`);
}

// ── Derive keys ───────────────────────────────────────────────────────────────
const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

// seedWithNonce(seed, 0) gives the primary account (3DiwY...)
const SEED_WITH_NONCE = seedWithNonce(BASE_SEED, BASE_NONCE);
const SIGNER = { privateKey: privateKey(SEED_WITH_NONCE) };

const deployerKeys = {
  address:   address(SEED_WITH_NONCE, CHAIN_ID),
  publicKey: publicKey(SEED_WITH_NONCE),
};

console.log('═══════════════════════════════════════════════════');
console.log(' DCC Bridge Controller Deployment');
console.log('═══════════════════════════════════════════════════');
console.log('Deployer address:', deployerKeys.address);
console.log('Deployer pubkey: ', deployerKeys.publicKey);
console.log();

// ── Check balance ─────────────────────────────────────────────────────────────
const balInfo = await apiGet(`/addresses/balance/${deployerKeys.address}`);
const balDcc  = (balInfo.balance || 0) / 1e8;
console.log('Balance:', balDcc.toFixed(4), 'DCC');
if (balDcc < 1) {
  throw new Error('Insufficient DCC balance — need at least 1 DCC for fees (setScript costs ~0.01 DCC)');
}

// ── Check if already initialized ─────────────────────────────────────────────
const dataResp = await apiGet(`/addresses/data/${deployerKeys.address}/admin`).catch(() => null);
const alreadyInit = dataResp && !dataResp.error;
if (alreadyInit) {
  console.log('⚠️  Bridge already initialized at', deployerKeys.address);
  const wsol = await apiGet(`/addresses/data/${deployerKeys.address}/wsol_asset_id`).catch(() => null);
  if (wsol?.value) console.log('   wSOL asset ID:', wsol.value);
  process.exit(0);
}

// ── STEP 1: Compile zk_bridge.ride ────────────────────────────────────────────
console.log('Step 1: Compiling zk_bridge.ride...');
const RIDE_CONTRACT_PATH = process.env.DCC_RIDE_CONTRACT_PATH || 'dcc/contracts/bridge/zk_bridge.ride';
const rideCode    = readFileSync(resolve(ROOT, RIDE_CONTRACT_PATH), 'utf8');
const compiledB64 = await compileScript(rideCode);
console.log('   Compiled OK —', Math.round(compiledB64.length * 3/4), 'bytes');

// ── STEP 2: SetScript tx ──────────────────────────────────────────────────────
console.log('Step 2: Broadcasting setScript...');
const setScriptTx = setScript({
  script: compiledB64,
  chainId: CHAIN_ID,
  fee: 1400000,   // 0.014 DCC — setScript with large script
  senderPublicKey: deployerKeys.publicKey,
}, SIGNER);

const setScriptResp = await broadcast(setScriptTx, NODE_URL);
if (setScriptResp.error) throw new Error('setScript broadcast failed: ' + JSON.stringify(setScriptResp));
console.log('   Tx ID:', setScriptResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(setScriptResp.id);
console.log('   ✅ Script deployed!');
console.log();

// ── STEP 3: Initialize bridge ─────────────────────────────────────────────────
console.log('Step 3: Calling initialize()...');
const initTx = invokeScript({
  dApp: deployerKeys.address,
  call: {
    function: 'initialize',
    args: [
      { type: 'string', value: GUARDIAN_ADDRESS || deployerKeys.address },  // guardian (env or deployer fallback)
      { type: 'integer', value: MIN_VALIDATORS },
    ],
  },
  payment: [],
  chainId: CHAIN_ID,
  fee: 1300000,  // 0.013 DCC — invokeScript + Issue action fee
  senderPublicKey: deployerKeys.publicKey,
}, SIGNER);

const initResp = await broadcast(initTx, NODE_URL);
if (initResp.error) throw new Error('initialize broadcast failed: ' + JSON.stringify(initResp));
console.log('   Tx ID:', initResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(initResp.id);
console.log('   ✅ Bridge initialized!');
console.log();

// ── STEP 4: Register validator ────────────────────────────────────────────────
console.log('Step 4: Registering deployer as validator...');
const regTx = invokeScript({
  dApp: deployerKeys.address,
  call: {
    function: 'registerValidator',
    args: [
      { type: 'string', value: deployerKeys.publicKey },
    ],
  },
  payment: [],
  chainId: CHAIN_ID,
  fee: 500000,
  senderPublicKey: deployerKeys.publicKey,
}, SIGNER);

const regResp = await broadcast(regTx, NODE_URL);
if (regResp.error) throw new Error('registerValidator broadcast failed: ' + JSON.stringify(regResp));
console.log('   Tx ID:', regResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(regResp.id);
console.log('   ✅ Validator registered!');
console.log();

// ── STEP 5: Fetch wSOL asset ID ───────────────────────────────────────────────
const wsolEntry = await apiGet(`/addresses/data/${deployerKeys.address}/wsol_asset_id`);
const wsolAssetId = wsolEntry?.value;

console.log('═══════════════════════════════════════════════════');
console.log(' DEPLOYMENT COMPLETE!');
console.log('═══════════════════════════════════════════════════');
console.log('Bridge contract address:', deployerKeys.address);
console.log('wSOL asset ID:          ', wsolAssetId);
console.log();
console.log('Add these to your .env:');
console.log(`DCC_BRIDGE_CONTRACT=${deployerKeys.address}`);
console.log(`WSOL_ASSET_ID=${wsolAssetId}`);
console.log();
console.log('Explorer:');
console.log(`https://decentralscan.com/address/${deployerKeys.address}`);
