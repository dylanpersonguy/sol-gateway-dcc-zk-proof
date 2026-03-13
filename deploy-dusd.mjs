/**
 * DUSD (Decentral USD) Stablecoin — DCC Contract Deployment Script
 *
 * Steps:
 *  1. Derive deployer address from DCC_VALIDATOR_SEED + nonce
 *  2. Fund deployer if needed (from nonce 0)
 *  3. Compile dusd_stablecoin.ride
 *  4. SetScript tx — deploys the RIDE contract
 *  5. InvokeScript tx — calls initialize(guardian, bridgeController, minValidators)
 *  6. InvokeScript tx — calls registerValidator(pubKey)
 *  7. Print DUSD contract address + DUSD asset ID
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setScript,
  invokeScript,
  transfer,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = __dir;

// ── Config ──────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE_URL     = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY      = process.env.DCC_API_KEY || '';
const CHAIN_ID     = process.env.DCC_CHAIN_ID_CHAR || '?';
const CHAIN_ID_NUM = parseInt(process.env.DCC_CHAIN_ID || '63', 10);
const BASE_SEED    = process.env.DCC_DUSD_SEED || required('DCC_VALIDATOR_SEED');
const DUSD_NONCE   = parseInt(process.env.DCC_DUSD_NONCE || '3', 10);

const MIN_VALIDATORS   = parseInt(process.env.DCC_MIN_VALIDATORS || '1', 10);
const GUARDIAN_ADDRESS  = process.env.DCC_GUARDIAN_ADDRESS || '';
const BRIDGE_CONTROLLER = process.env.DCC_BRIDGE_CONTROLLER || process.env.DCC_BRIDGE_CONTRACT || '';
if (!BRIDGE_CONTROLLER) throw new Error('Missing required env var: DCC_BRIDGE_CONTROLLER or DCC_BRIDGE_CONTRACT');

const MIN_BALANCE_DCC = 5; // need ~5 DCC for setScript + init (with Issue) + registerValidator

// ── Helpers ─────────────────────────────────────────────────
const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

async function apiGet(path) {
  const r = await fetch(NODE_URL + path);
  return r.json();
}

async function broadcastTx(tx) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const r = await fetch(`${NODE_URL}/transactions/broadcast`, {
    method: 'POST',
    headers,
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Node rejected tx: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function compileScript(code) {
  const headers = { 'Content-Type': 'text/plain' };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const r = await fetch(`${NODE_URL}/utils/script/compileCode`, {
    method: 'POST',
    headers,
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;
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
    console.log(`  Waiting for tx ${txId.slice(0, 12)}...`);
    await sleep(3000);
  }
  throw new Error(`Tx ${txId} not confirmed after ${attempts} attempts`);
}

// ── Derive keys ─────────────────────────────────────────────
const DUSD_SEED = seedWithNonce(BASE_SEED, DUSD_NONCE);
const DUSD_SIGNER = { privateKey: privateKey(DUSD_SEED) };
const deployerKeys = {
  address:   address(DUSD_SEED, CHAIN_ID),
  publicKey: publicKey(DUSD_SEED),
};

// Funder: nonce 0 (main wallet)
const FUND_SEED = seedWithNonce(BASE_SEED, 0);
const FUND_SIGNER = { privateKey: privateKey(FUND_SEED) };
const funderKeys = {
  address:   address(FUND_SEED, CHAIN_ID),
  publicKey: publicKey(FUND_SEED),
};

console.log('═══════════════════════════════════════════════════');
console.log(' Decentral USD (DUSD) Contract Deployment');
console.log('═══════════════════════════════════════════════════');
console.log('Deployer address:    ', deployerKeys.address);
console.log('Deployer pubkey:     ', deployerKeys.publicKey);
console.log('Funder address:      ', funderKeys.address);
console.log('Bridge controller:   ', BRIDGE_CONTROLLER);
console.log('Min validators:      ', MIN_VALIDATORS);
console.log('Nonce:               ', DUSD_NONCE);
console.log();

// ── Check if already initialized ────────────────────────────
const dataResp = await apiGet(`/addresses/data/${deployerKeys.address}/dusd_asset_id`).catch(() => null);
const alreadyInit = dataResp && !dataResp.error && dataResp.value;
if (alreadyInit) {
  console.log('⚠️  DUSD contract already initialized at', deployerKeys.address);
  console.log('   DUSD asset ID:', dataResp.value);
  process.exit(0);
}

// ── Fund deployer if needed ─────────────────────────────────
const balInfo = await apiGet(`/addresses/balance/${deployerKeys.address}`);
const balDcc = (balInfo.balance || 0) / 1e8;
console.log('Deployer balance:', balDcc.toFixed(4), 'DCC');

if (balDcc < MIN_BALANCE_DCC) {
  const needed = Math.ceil((MIN_BALANCE_DCC - balDcc + 1) * 1e8);
  console.log(`Funding deployer with ${(needed / 1e8).toFixed(4)} DCC from funder...`);

  const funderBal = await apiGet(`/addresses/balance/${funderKeys.address}`);
  const funderDcc = (funderBal.balance || 0) / 1e8;
  console.log('  Funder balance:', funderDcc.toFixed(4), 'DCC');

  if (funderDcc < needed / 1e8 + 0.01) {
    throw new Error(`Insufficient funder balance: ${funderDcc.toFixed(4)} DCC`);
  }

  const fundTx = transfer({
    recipient: deployerKeys.address,
    amount: needed,
    fee: 500000,
    chainId: CHAIN_ID_NUM,
    senderPublicKey: funderKeys.publicKey,
    version: 2,
  }, FUND_SIGNER);
  const fundResp = await broadcastTx(fundTx);
  console.log('  Fund txId:', fundResp.id);
  await waitForTx(fundResp.id);
  console.log('  ✅ Deployer funded');

  // Verify new balance
  await sleep(2000);
  const newBal = await apiGet(`/addresses/balance/${deployerKeys.address}`);
  console.log('  New balance:', ((newBal.balance || 0) / 1e8).toFixed(4), 'DCC');
}

// ── STEP 1: Compile dusd_stablecoin.ride ────────────────────
console.log('\nStep 1: Compiling dusd_stablecoin.ride...');
const RIDE_PATH = 'dcc-contracts/dusd/dusd_stablecoin.ride';
const rideCode = readFileSync(resolve(ROOT, RIDE_PATH), 'utf8');
const compiledB64 = await compileScript(rideCode);
console.log('   Compiled OK —', Math.round(compiledB64.length * 3 / 4), 'bytes');

// ── STEP 2: SetScript tx ────────────────────────────────────
console.log('Step 2: Deploying DUSD contract...');
const setScriptTx = setScript(
  {
    script: compiledB64,
    chainId: CHAIN_ID,
    fee: 1400000,
    senderPublicKey: deployerKeys.publicKey,
    version: 1,
  },
  DUSD_SIGNER,
);
const setScriptResp = await broadcastTx(setScriptTx);
console.log('   SetScript txId:', setScriptResp.id);
await waitForTx(setScriptResp.id);
console.log('   ✅ Contract deployed');

// ── STEP 3: Initialize ─────────────────────────────────────
console.log('Step 3: Initializing DUSD contract...');
const guardianAddr = GUARDIAN_ADDRESS || deployerKeys.address;
const initTx = invokeScript(
  {
    dApp: deployerKeys.address,
    call: {
      function: 'initialize',
      args: [
        { type: 'string', value: guardianAddr },
        { type: 'string', value: BRIDGE_CONTROLLER },
        { type: 'integer', value: MIN_VALIDATORS },
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 100900000,
    senderPublicKey: deployerKeys.publicKey,
    version: 1,
  },
  DUSD_SIGNER,
);
const initResp = await broadcastTx(initTx);
console.log('   Initialize txId:', initResp.id);
await waitForTx(initResp.id);
console.log('   ✅ DUSD initialized');

// ── STEP 4: Register first validator ────────────────────────
console.log('Step 4: Registering deployer as validator...');
const regTx = invokeScript(
  {
    dApp: deployerKeys.address,
    call: {
      function: 'registerValidator',
      args: [
        { type: 'string', value: deployerKeys.publicKey },
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 900000,
    senderPublicKey: deployerKeys.publicKey,
    version: 1,
  },
  DUSD_SIGNER,
);
const regResp = await broadcastTx(regTx);
console.log('   RegisterValidator txId:', regResp.id);
await waitForTx(regResp.id);
console.log('   ✅ Validator registered');

// ── Fetch DUSD asset ID ─────────────────────────────────────
await sleep(2000);
const dusdAssetData = await apiGet(`/addresses/data/${deployerKeys.address}/dusd_asset_id`);
const dusdAssetId = dusdAssetData?.value || '(check explorer)';

console.log();
console.log('═══════════════════════════════════════════════════');
console.log(' DUSD Deployment Complete');
console.log('═══════════════════════════════════════════════════');
console.log('Contract address:', deployerKeys.address);
console.log('DUSD asset ID:   ', dusdAssetId);
console.log('Guardian:        ', guardianAddr);
console.log('Bridge ctrl:     ', BRIDGE_CONTROLLER);
console.log();
console.log('Add to .env:');
console.log(`  DCC_DUSD_CONTRACT=${deployerKeys.address}`);
console.log(`  DCC_DUSD_ASSET_ID=${dusdAssetId}`);
console.log('═══════════════════════════════════════════════════');
