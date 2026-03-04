/**
 * DCC Bridge Controller — MAINNET Deployment v2 (no "w" prefix)
 *
 * Deploys a FRESH bridge_controller.ride to a NEW DCC address using nonce 1.
 * Token names use clean symbols (SOL, USDC, BTC) instead of wrapped (wSOL, wUSDC, wBTC).
 *
 * Steps:
 *  1. Derive NEW deployer address from seedWithNonce(seed, 1)
 *  2. Fund new address from old address (nonce 0)
 *  3. Compile bridge_controller.ride on mainnet node
 *  4. SetScript tx — deploys the RIDE contract
 *  5. InvokeScript — calls initialize(guardian, minValidators)
 *  6. InvokeScript — calls registerValidator(pubKey)
 *  7. Register SPL tokens from token-registry
 *  8. Print final bridge contract address + SOL asset ID
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  setScript,
  invokeScript,
  transfer,
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

const MIN_VALIDATORS = 1;

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
    headers: { 'Content-Type': 'text/plain', 'X-API-Key': API_KEY },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;
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

// Old deployer (nonce 0) — used to fund the new address
const OLD_NONCE  = parseInt(process.env.DCC_OLD_NONCE || '0', 10);
const NEW_NONCE  = parseInt(process.env.DCC_NEW_NONCE || '1', 10);

const OLD_SEED   = seedWithNonce(BASE_SEED, OLD_NONCE);
const OLD_SIGNER = { privateKey: privateKey(OLD_SEED) };
const oldAddress  = address(OLD_SEED, CHAIN_ID);

// NEW deployer (nonce 1) — fresh address with no prior state
const NEW_SEED   = seedWithNonce(BASE_SEED, NEW_NONCE);
const NEW_SIGNER = { privateKey: privateKey(NEW_SEED) };
const newDeployer = {
  address:   address(NEW_SEED, CHAIN_ID),
  publicKey: publicKey(NEW_SEED),
};

console.log('═══════════════════════════════════════════════════');
console.log(' DCC Bridge Controller — MAINNET v2 (no w prefix)');
console.log('═══════════════════════════════════════════════════');
console.log('Node:              ', NODE_URL);
console.log('Chain ID:          ', CHAIN_ID, `(${CHAIN_ID.charCodeAt(0)})`);
console.log('Old address (n=0): ', oldAddress);
console.log('New address (n=1): ', newDeployer.address);
console.log('New pubkey:        ', newDeployer.publicKey);
console.log();

// ── Check if already initialized ─────────────────────────────────────────────
const newDataResp = await apiGet(`/addresses/data/${newDeployer.address}/admin`).catch(() => null);
const alreadyInit = newDataResp && !newDataResp.error;
if (alreadyInit) {
  console.log('⚠️  Bridge already initialized at', newDeployer.address);
  const sol = await apiGet(`/addresses/data/${newDeployer.address}/sol_asset_id`).catch(() => null);
  if (sol?.value) console.log('   SOL asset ID:', sol.value);
  console.log();
  console.log('Add to .env:');
  console.log(`DCC_NODE_URL=${NODE_URL}`);
  console.log(`DCC_BRIDGE_CONTRACT=${newDeployer.address}`);
  console.log(`DCC_CHAIN_ID=63`);
  console.log(`DCC_CHAIN_ID_CHAR=?`);
  if (sol?.value) console.log(`SOL_ASSET_ID=${sol.value}`);
  process.exit(0);
}

// ── Fund new address from old address ─────────────────────────────────────────
console.log('Step 0: Checking balances & funding new address...');
const oldBal = await apiGet(`/addresses/balance/${oldAddress}`);
const newBal = await apiGet(`/addresses/balance/${newDeployer.address}`);
const oldDcc = (oldBal.balance || 0) / 1e8;
const newDcc = (newBal.balance || 0) / 1e8;
console.log('   Old balance:', oldDcc.toFixed(4), 'DCC');
console.log('   New balance:', newDcc.toFixed(4), 'DCC');

// Need ~20 DCC for deployment (setScript + initialize + registerValidator + 16 registerToken)
const NEEDED = 20;
if (newDcc < NEEDED) {
  const toSend = Math.ceil((NEEDED - newDcc + 1) * 1e8); // send enough + 1 DCC buffer
  if (oldDcc < (toSend / 1e8) + 0.01) {
    throw new Error(`Insufficient DCC in old address. Have ${oldDcc.toFixed(4)}, need ${(toSend/1e8).toFixed(4)}`);
  }
  console.log(`   Transferring ${(toSend / 1e8).toFixed(4)} DCC from old → new address...`);
  
  const transferTx = transfer({
    recipient: newDeployer.address,
    amount: toSend,
    fee: 100000,   // 0.001 DCC
    chainId: CHAIN_ID,
    senderPublicKey: publicKey(OLD_SEED),
    version: 2,
  }, OLD_SIGNER);

  const txResp = await broadcastTx(transferTx);
  console.log('   Tx ID:', txResp.id);
  await waitForTx(txResp.id);
  console.log('   ✅ Transfer confirmed!');
  
  const updatedBal = await apiGet(`/addresses/balance/${newDeployer.address}`);
  console.log('   New balance:', ((updatedBal.balance || 0) / 1e8).toFixed(4), 'DCC');
}
console.log();

// ── STEP 1: Compile bridge_controller.ride ────────────────────────────────────
console.log('Step 1: Compiling bridge_controller.ride on mainnet node...');
const rideCode    = readFileSync(resolve(ROOT, 'dcc-contracts/bridge-controller/bridge_controller.ride'), 'utf8');
const compiledB64 = await compileScript(rideCode);
console.log('   Compiled OK —', Math.round(compiledB64.length * 3/4), 'bytes');

// ── STEP 2: SetScript tx ──────────────────────────────────────────────────────
console.log('Step 2: Broadcasting setScript...');
const setScriptTx = setScript({
  script: compiledB64,
  chainId: CHAIN_ID,
  fee: 14000000,   // 0.14 DCC
  senderPublicKey: newDeployer.publicKey,
  version: 1,
}, NEW_SIGNER);

const setScriptResp = await broadcastTx(setScriptTx);
console.log('   Tx ID:', setScriptResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(setScriptResp.id);
console.log('   ✅ Script deployed!');
console.log();

// ── STEP 3: Initialize bridge ─────────────────────────────────────────────────
console.log('Step 3: Calling initialize()...');
const initTx = invokeScript({
  dApp: newDeployer.address,
  call: {
    function: 'initialize',
    args: [
      { type: 'string', value: newDeployer.address },  // guardian = deployer
      { type: 'integer', value: MIN_VALIDATORS },
    ],
  },
  payment: [],
  chainId: CHAIN_ID,
  fee: 100500000,  // 1.005 DCC — invokeScript + Issue action fee
  senderPublicKey: newDeployer.publicKey,
  version: 1,
}, NEW_SIGNER);

const initResp = await broadcastTx(initTx);
console.log('   Tx ID:', initResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(initResp.id);
console.log('   ✅ Bridge initialized!');
console.log();

// ── STEP 4: Register validator ────────────────────────────────────────────────
console.log('Step 4: Registering deployer as validator...');
const regTx = invokeScript({
  dApp: newDeployer.address,
  call: {
    function: 'registerValidator',
    args: [
      { type: 'string', value: newDeployer.publicKey },
    ],
  },
  payment: [],
  chainId: CHAIN_ID,
  fee: 5000000,
  senderPublicKey: newDeployer.publicKey,
  version: 1,
}, NEW_SIGNER);

const regResp = await broadcastTx(regTx);
console.log('   Tx ID:', regResp.id);
console.log('   Waiting for confirmation...');
await waitForTx(regResp.id);
console.log('   ✅ Validator registered!');
console.log();

// ── STEP 5: Fetch SOL asset ID ────────────────────────────────────────────────
const solEntry = await apiGet(`/addresses/data/${newDeployer.address}/sol_asset_id`);
const solAssetId = solEntry?.value;
console.log('SOL asset ID:', solAssetId);

// ── STEP 6: Register SPL tokens ───────────────────────────────────────────────
console.log('Step 6: Registering SPL tokens...');
const { TOKEN_REGISTRY } = require('./dcc-contracts/token-registry.cjs');

for (let i = 0; i < TOKEN_REGISTRY.length; i++) {
  const t = TOKEN_REGISTRY[i];
  console.log(`   [${i + 1}/${TOKEN_REGISTRY.length}] ${t.symbol} (${t.splMint.slice(0, 8)}...)`);
  
  const regTokenTx = invokeScript({
    dApp: newDeployer.address,
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
    fee: 100500000,
    senderPublicKey: newDeployer.publicKey,
    version: 1,
  }, NEW_SIGNER);

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
const tokenCount = await apiGet(`/addresses/data/${newDeployer.address}/registered_token_count`).catch(() => null);
if (tokenCount?.value) {
  console.log(`   Total registered tokens: ${tokenCount.value} (incl. native SOL)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log('═══════════════════════════════════════════════════');
console.log(' MAINNET v2 DEPLOYMENT COMPLETE! (no w prefix)');
console.log('═══════════════════════════════════════════════════');
console.log();
console.log('Bridge contract address:', newDeployer.address);
console.log('SOL asset ID:          ', solAssetId);
console.log();
console.log('Add these to your .env:');
console.log(`DCC_NODE_URL=${NODE_URL}`);
console.log(`DCC_BRIDGE_CONTRACT=${newDeployer.address}`);
console.log(`DCC_CHAIN_ID=63`);
console.log(`DCC_CHAIN_ID_CHAR=?`);
console.log(`SOL_ASSET_ID=${solAssetId}`);
console.log();
console.log('Explorer:');
console.log(`https://decentralscan.com/address/${newDeployer.address}`);
