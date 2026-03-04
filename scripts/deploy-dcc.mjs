/**
 * deploy-dcc.mjs — Deploy DCC bridge contracts
 *
 * Correct deployment order:
 * 1. Issue wSOL token from addr0 (before any script is on the account)
 * 2. Compile + setScript bridge_controller.ride on addr0
 * 3. Initialize bridge_controller (guardian, minValidators=1, wsolAssetId)
 * 4. RegisterValidator with the Ed25519 pubkey
 * 5. Write validator key files
 *
 * The wSOL asset is issued BY addr0, so bridge_controller(addr0) can Reissue it.
 */
import * as dcc from '@decentralchain/decentralchain-transactions';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { randomBytes, createCipheriv } from 'crypto';
import * as nacl from 'tweetnacl';
import dotenv from 'dotenv';

dotenv.config();

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE     = 'https://keough-node.decentralchain.io';
const SEED0    = required('DCC_VALIDATOR_SEED');
const CHAIN_ID = '?';

const addr0   = dcc.libs.crypto.address(SEED0, CHAIN_ID);
const pk0_b58 = dcc.libs.crypto.publicKey(SEED0);

const SETSCRIPT_FEE  = 1400000;    // 0.014 DCC for dApp setScript
const INVOKE_FEE     = 500000;     // 0.005 DCC for InvokeScript
const INVOKE_ISSUE_FEE = 100500000;// 1.005 DCC for InvokeScript + Issue action

console.log('bridge_controller account:', addr0);
console.log('PubKey base58:            ', pk0_b58);
console.log();

async function getBalance(address) {
  const r = await fetch(`${NODE}/addresses/balance/${address}`, {signal: AbortSignal.timeout(10000)});
  return (await r.json()).balance;
}

async function getDataEntry(address, key) {
  try {
    const r = await fetch(`${NODE}/addresses/data/${address}/${encodeURIComponent(key)}`, {signal: AbortSignal.timeout(10000)});
    if (!r.ok) return null;
    return (await r.json()).value;
  } catch { return null; }
}

async function broadcastAndWait(tx, desc) {
  process.stdout.write('  ' + desc + '... ');
  const result = await dcc.broadcast(tx, NODE);
  process.stdout.write('tx ' + result.id.slice(0, 20) + '... ');
  await dcc.waitForTx(result.id, {apiBase: NODE});
  console.log('confirmed');
  return result;
}

async function compileRide(scriptText) {
  const resp = await fetch(NODE + '/utils/script/compileCode', {
    method: 'POST',
    headers: {'Content-Type': 'text/plain'},
    body: scriptText,
    signal: AbortSignal.timeout(30000),
  });
  const json = await resp.json();
  if (!json.script) throw new Error('Compile failed: ' + JSON.stringify(json));
  return json.script;
}

// ── Balance check ─────────────────────────────────────────────────────────────
const bal = await getBalance(addr0);
console.log('Balance:', (bal/1e8).toFixed(4), 'DCC');
if (bal < INVOKE_ISSUE_FEE + SETSCRIPT_FEE + INVOKE_FEE * 2) {
  throw new Error('Insufficient DCC. Need at least ~' + ((INVOKE_ISSUE_FEE + SETSCRIPT_FEE + INVOKE_FEE*2)/1e8) + ' DCC');
}
console.log();

// ── Step 1: Compile zk_bridge.ride ─────────────────────────────────────────
console.log('Step 1: Compiling zk_bridge.ride...');
const RIDE_CONTRACT_PATH = process.env.DCC_RIDE_CONTRACT_PATH || 'dcc/contracts/bridge/zk_bridge.ride';
const bridgeRide = readFileSync(RIDE_CONTRACT_PATH, 'utf8');
const compiledBridge = await compileRide(bridgeRide);
console.log('  OK');
console.log();

// ── Step 3: Deploy zk_bridge.ride to addr0 ───────────────────────────────
console.log('Step 3: Deploy zk_bridge.ride to', addr0);
const scriptInfo = await fetch(NODE + '/addresses/scriptInfo/' + addr0, {signal: AbortSignal.timeout(10000)}).then(r => r.json()).catch(() => null);
const alreadyDeployed = scriptInfo && scriptInfo.scriptText && scriptInfo.scriptText !== 'base64:';

if (alreadyDeployed) {
  console.log('  Script already deployed');
} else {
  const ssRx = dcc.setScript({
    script: compiledBridge,
    fee: SETSCRIPT_FEE,
    chainId: CHAIN_ID,
  }, SEED0);
  await broadcastAndWait(ssRx, 'Deploying bridge_controller script');
}
console.log();

// ── Step 3: Initialize bridge_controller (Issues wSOL internally) ────────────
console.log('Step 3: Initialize bridge_controller (creates wSOL asset)');
const adminVal = await getDataEntry(addr0, 'admin');
let wsolAssetId;
if (adminVal) {
  wsolAssetId = await getDataEntry(addr0, 'wsol_asset_id');
  console.log('  Already initialized, wsolAssetId:', wsolAssetId);
} else {
  const initTx = dcc.invokeScript({
    dApp: addr0,
    call: {
      function: 'initialize',
      args: [
        {type: 'string',  value: addr0}, // guardian
        {type: 'integer', value: 1},     // minValidators
      ],
    },
    payment: [],
    fee: INVOKE_ISSUE_FEE, // includes 1 DCC for the Issue action
    chainId: CHAIN_ID,
  }, SEED0);
  await broadcastAndWait(initTx, 'Calling initialize() + issuing wSOL');
  wsolAssetId = await getDataEntry(addr0, 'wsol_asset_id');
  console.log('  wSOL asset ID:', wsolAssetId);
}
console.log();

// ── Step 4: Register validator pubkey ─────────────────────────────────────────
console.log('Step 4: Register validator pubkey', pk0_b58);
const valActive = await getDataEntry(addr0, 'validator_active_' + pk0_b58);
if (valActive === true) {
  console.log('  Already registered');
} else {
  const regTx = dcc.invokeScript({
    dApp: addr0,
    call: {
      function: 'registerValidator',
      args: [{type: 'string', value: pk0_b58}],
    },
    payment: [],
    fee: INVOKE_FEE,
    chainId: CHAIN_ID,
  }, SEED0);
  await broadcastAndWait(regTx, 'Calling registerValidator()');
}
console.log();

// ── Step 6: Save validator keypair file ──────────────────────────────────────
console.log('Step 6: Generate validator key files');
const dccKP = dcc.libs.crypto.keyPair(SEED0);
// DCC privateKey is the 32-byte seed, reconstruct full Ed25519 secretKey
const seedBytes32 = Buffer.from(dccKP.privateKey, 'base64');
const naclKP = nacl.sign.keyPair.fromSeed(new Uint8Array(seedBytes32));
const secretKey = Buffer.from(naclKP.secretKey);  // 64 bytes
const publicKey = Buffer.from(naclKP.publicKey);  // 32 bytes

console.log('  Pubkey (hex):', publicKey.toString('hex'));

const encKey = randomBytes(32);
const ivBuf  = randomBytes(16);
const cipher = createCipheriv('aes-256-gcm', encKey, ivBuf);
const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()]);
const authTag   = cipher.getAuthTag();
const keyFileData = Buffer.concat([ivBuf, authTag, encrypted]);

const keyDir  = '/tmp/validator-keys';
const keyPath = keyDir + '/validator.key';
if (!existsSync(keyDir)) mkdirSync(keyDir, {recursive: true});
writeFileSync(keyPath, keyFileData, {mode: 0o600});
writeFileSync(keyPath + '.key', encKey.toString('hex'), {mode: 0o600});
console.log('  Key files written to', keyDir);

const deployResult = {
  bridgeContract: addr0,
  wsolAssetId,
  validatorPubkeyB58: pk0_b58,
  validatorPubkeyHex: publicKey.toString('hex'),
  keyPath,
  dccNode: NODE,
};
writeFileSync('/tmp/validator-keys/deploy-result.json', JSON.stringify(deployResult, null, 2));
console.log();

console.log('═══════════════════════════════════════════════');
console.log(' DEPLOYMENT COMPLETE');
console.log('═══════════════════════════════════════════════');
console.log('DCC_BRIDGE_CONTRACT=' + addr0);
console.log('WSOL_ASSET_ID=      ' + wsolAssetId);
