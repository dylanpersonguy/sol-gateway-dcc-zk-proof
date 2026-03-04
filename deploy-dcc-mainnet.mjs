/**
 * DCC Bridge Controller — MAINNET Deployment Script
 *
 * Deploys zk_bridge.ride to DecentralChain mainnet via
 * https://mainnet-node.decentralchain.io
 *
 * Steps:
 *  1. Derive deployer address from DCC_VALIDATOR_SEED
 *  2. Compile zk_bridge.ride on the mainnet node
 *  3. SetScript tx — deploys the RIDE contract
 *  4. InvokeScript — calls initialize(guardian, minValidators)
 *  5. InvokeScript — calls registerValidator(pubKey)
 *  6. Register SPL tokens from token-registry
 *  7. Print final bridge contract address + wSOL asset ID
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  setScript,
  invokeScript,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = __dir;

// ── Config ─────────────────────────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE_URL   = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY    = required('DCC_API_KEY');
const CHAIN_ID   = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED  = required('DCC_VALIDATOR_SEED');
const BASE_NONCE = parseInt(process.env.DCC_VALIDATOR_NONCE || '0', 10);

const MIN_VALIDATORS = parseInt(process.env.DCC_MIN_VALIDATORS || '3', 10);
const GUARDIAN_ADDRESS = process.env.DCC_GUARDIAN_ADDRESS || ''; // Must be set for production!

// ── Production Safety Checks ─────────────────────────────────────────────────
if (MIN_VALIDATORS < 3) {
  console.warn('⚠️  WARNING: MIN_VALIDATORS < 3 is NOT recommended for production.');
  console.warn('   Set DCC_MIN_VALIDATORS=3 (or higher) in your .env');
}
if (!GUARDIAN_ADDRESS) {
  console.warn('⚠️  WARNING: No DCC_GUARDIAN_ADDRESS set — will use deployer as guardian.');
  console.warn('   For production, set DCC_GUARDIAN_ADDRESS to a separate multisig address.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    headers: {
      'Content-Type': 'text/plain',
      'X-API-Key': API_KEY,
    },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;  // base64-encoded compiled script
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForTx(txId, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await apiGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    console.log(`  Waiting for tx ${txId.slice(0,12)}... (${i + 1}/${attempts})`);
    await sleep(5000);
  }
  throw new Error(`Tx ${txId} not confirmed after ${attempts} attempts`);
}

// ── Derive keys ───────────────────────────────────────────────────────────────
const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

const SEED_WITH_NONCE = seedWithNonce(BASE_SEED, BASE_NONCE);
const SIGNER = { privateKey: privateKey(SEED_WITH_NONCE) };

const deployerKeys = {
  address:   address(SEED_WITH_NONCE, CHAIN_ID),
  publicKey: publicKey(SEED_WITH_NONCE),
};

console.log('═══════════════════════════════════════════════════');
console.log(' DCC Bridge Controller — MAINNET Deployment');
console.log('═══════════════════════════════════════════════════');
console.log('Node:             ', NODE_URL);
console.log('Chain ID:         ', CHAIN_ID, `(${CHAIN_ID.charCodeAt(0)})`);
console.log('Deployer address: ', deployerKeys.address);
console.log('Deployer pubkey:  ', deployerKeys.publicKey);
console.log();

// ── Check balance ─────────────────────────────────────────────────────────────
const balInfo = await apiGet(`/addresses/balance/${deployerKeys.address}`);
const balDcc  = (balInfo.balance || 0) / 1e8;
console.log('Balance:', balDcc.toFixed(4), 'DCC');
if (balDcc < 2) {
  throw new Error('Insufficient DCC balance — need at least 2 DCC for deployment fees');
}

// ── Check if already initialized ─────────────────────────────────────────────
const dataResp = await apiGet(`/addresses/data/${deployerKeys.address}/admin`).catch(() => null);
const alreadyInit = dataResp && !dataResp.error;
if (alreadyInit) {
  console.log('⚠️  Bridge already initialized at', deployerKeys.address);
  const wsol = await apiGet(`/addresses/data/${deployerKeys.address}/wsol_asset_id`).catch(() => null);
  if (wsol?.value) console.log('   wSOL asset ID:', wsol.value);
  console.log();
  console.log('Add to .env:');
  console.log(`DCC_NODE_URL=${NODE_URL}`);
  console.log(`DCC_BRIDGE_CONTRACT=${deployerKeys.address}`);
  console.log(`DCC_CHAIN_ID=63`);
  console.log(`DCC_CHAIN_ID_CHAR=?`);
  if (wsol?.value) console.log(`WSOL_ASSET_ID=${wsol.value}`);
  process.exit(0);
}

// ── STEP 1: Compile zk_bridge.ride ────────────────────────────────────────────
console.log('Step 1: Compiling zk_bridge.ride on mainnet node...');
const RIDE_CONTRACT_PATH = process.env.DCC_RIDE_CONTRACT_PATH || 'dcc/contracts/bridge/zk_bridge.ride';
const rideCode    = readFileSync(resolve(ROOT, RIDE_CONTRACT_PATH), 'utf8');
const compiledB64 = await compileScript(rideCode);
console.log('   Compiled OK —', Math.round(compiledB64.length * 3/4), 'bytes');

// ── STEP 2: SetScript tx ──────────────────────────────────────────────────────
console.log('Step 2: Broadcasting setScript...');
const setScriptTx = setScript({
  script: compiledB64,
  chainId: CHAIN_ID,
  fee: 14000000,   // 0.14 DCC — setScript with large script
  senderPublicKey: deployerKeys.publicKey,
  version: 1,
}, SIGNER);

const setScriptResp = await broadcastTx(setScriptTx);
console.log('   Tx ID:', setScriptResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(setScriptResp.id);
console.log('   ✅ Script deployed to mainnet!');
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
  fee: 100500000,  // 1.005 DCC — invokeScript + Issue action fee
  senderPublicKey: deployerKeys.publicKey,
  version: 1,
}, SIGNER);

const initResp = await broadcastTx(initTx);
console.log('   Tx ID:', initResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(initResp.id);
console.log('   ✅ Bridge initialized on mainnet!');
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
  fee: 5000000,
  senderPublicKey: deployerKeys.publicKey,
  version: 1,
}, SIGNER);

const regResp = await broadcastTx(regTx);
console.log('   Tx ID:', regResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(regResp.id);
console.log('   ✅ Validator registered!');
console.log();

// ── STEP 5: Fetch wSOL asset ID ───────────────────────────────────────────────
const wsolEntry = await apiGet(`/addresses/data/${deployerKeys.address}/wsol_asset_id`);
const wsolAssetId = wsolEntry?.value;
console.log('wSOL asset ID:', wsolAssetId);

// ── STEP 6: Register SPL tokens ───────────────────────────────────────────────
console.log('Step 6: Registering SPL tokens...');
const { TOKEN_REGISTRY } = require('./dcc-contracts/token-registry.cjs');

for (let i = 0; i < TOKEN_REGISTRY.length; i++) {
  const t = TOKEN_REGISTRY[i];
  console.log(`   [${i + 1}/${TOKEN_REGISTRY.length}] ${t.symbol} (${t.splMint.slice(0, 8)}...)`);
  
  const regTokenTx = invokeScript({
    dApp: deployerKeys.address,
    call: {
      function: 'registerToken',
      args: [
        { type: 'string',  value: t.splMint },
        { type: 'string',  value: t.name },
        { type: 'string',  value: t.symbol },
        { type: 'string',  value: t.description },
        { type: 'integer', value: t.solDecimals },
        { type: 'integer', value: t.dccDecimals },
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 100500000,   // 1.005 DCC — InvokeScript + Issue action
    senderPublicKey: deployerKeys.publicKey,
    version: 1,
  }, SIGNER);

  let resp;
  try {
    resp = await broadcastTx(regTokenTx);
  } catch (err) {
    console.log(`   ⚠️  ${t.symbol} failed: ${err.message}`);
    continue;
  }
  console.log(`      Tx ID: ${resp.id}`);
  await waitForTx(resp.id);
  console.log(`      ✅ ${t.symbol} registered!`);
}

// ── Read registered token count ─────────────────────────────────────────────
const tokenCount = await apiGet(`/addresses/data/${deployerKeys.address}/registered_token_count`).catch(() => null);
if (tokenCount?.value) {
  console.log(`   Total registered tokens: ${tokenCount.value} (incl. native SOL)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log('═══════════════════════════════════════════════════');
console.log(' MAINNET DEPLOYMENT COMPLETE!');
console.log('═══════════════════════════════════════════════════');
console.log();
console.log('Bridge contract address:', deployerKeys.address);
console.log('wSOL asset ID:          ', wsolAssetId);
console.log();
console.log('Add these to your .env:');
console.log(`DCC_NODE_URL=${NODE_URL}`);
console.log(`DCC_BRIDGE_CONTRACT=${deployerKeys.address}`);
console.log(`DCC_CHAIN_ID=63`);
console.log(`DCC_CHAIN_ID_CHAR=?`);
console.log(`WSOL_ASSET_ID=${wsolAssetId}`);
console.log();
console.log('Explorer:');
console.log(`https://decentralscan.com/address/${deployerKeys.address}`);
