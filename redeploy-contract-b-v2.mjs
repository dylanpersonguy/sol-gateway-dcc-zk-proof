/**
 * Redeploy Contract B (ZK Verifier) with resetVerifyingKey support,
 * then reset VK and upload the new VK from the fixed circuit.
 */
import fs from 'fs';
import axios from 'axios';
import { setScript, invokeScript, libs } from '@decentralchain/decentralchain-transactions';

import dotenv from 'dotenv';
dotenv.config();

function required(name) { const v = process.env[name]; if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); } return v; }

const NODE = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY = required('DCC_API_KEY');
const BASE_SEED = required('DCC_VALIDATOR_SEED');
const CHAIN_ID = Number(process.env.DCC_CHAIN_ID) || 63;

const { seedWithNonce, address, publicKey, privateKey } = libs.crypto;
const B_SEED = seedWithNonce(BASE_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractBAddr = address(B_SEED, CHAIN_ID);
const contractBPubKey = publicKey(B_SEED);

console.log('Contract B address:', contractBAddr);
console.log('Expected: 3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6');

async function broadcast(tx) {
  try {
    const r = await axios.post(NODE + '/transactions/broadcast', tx, {
      headers: { 'X-API-Key': API_KEY },
    });
    console.log('  TX broadcast OK:', r.data.id);
    return r.data.id;
  } catch (e) {
    console.error('  TX broadcast FAILED:', e.response?.data || e.message);
    throw e;
  }
}

async function waitForTx(txId, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const r = await axios.get(NODE + '/transactions/info/' + txId);
      if (r.data && r.data.id) {
        console.log('  TX confirmed:', txId);
        return r.data;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('TX not confirmed within ' + maxWait + 'ms');
}

// ═══════════════════════════════════════════════════════════
// STEP 1: Compile and redeploy the RIDE contract
// ═══════════════════════════════════════════════════════════
console.log('\n═══ STEP 1: Compile RIDE contract ═══');
const rideSource = fs.readFileSync('dcc/contracts/bridge/zk_verifier.ride', 'utf8');
const compileRes = await axios.post(NODE + '/utils/script/compileCode', rideSource, {
  headers: { 'Content-Type': 'text/plain', 'X-API-Key': API_KEY },
});

if (compileRes.data.error) {
  console.error('Compile failed:', compileRes.data.message);
  process.exit(1);
}

const compiledScript = compileRes.data.script;
console.log('Script length:', compiledScript.length);
console.log('Complexity:', compileRes.data.complexity);

console.log('\n═══ STEP 2: Redeploy (setScript) ═══');
const setScriptTx = setScript({
  script: compiledScript,
  fee: 14000000,
  chainId: CHAIN_ID,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const txId1 = await broadcast(setScriptTx);
await waitForTx(txId1);

// ═══════════════════════════════════════════════════════════
// STEP 3: Reset the VK
// ═══════════════════════════════════════════════════════════
console.log('\n═══ STEP 3: Reset verifying key ═══');
const resetTx = invokeScript({
  dApp: contractBAddr,
  call: { function: 'resetVerifyingKey', args: [] },
  payment: [],
  fee: 5000000,
  chainId: CHAIN_ID,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const txId2 = await broadcast(resetTx);
await waitForTx(txId2);

// ═══════════════════════════════════════════════════════════
// STEP 4: Serialize and upload the new VK
// ═══════════════════════════════════════════════════════════
console.log('\n═══ STEP 4: Upload new verifying key ═══');

const vkJson = JSON.parse(fs.readFileSync('zk/circuits/build/verification_key.json', 'utf8'));

// Serialize VK to bytes matching RIDE's groth16Verify_8inputs format
// Format: vk_alpha (64) + vk_beta (128) + vk_gamma (128) + vk_delta (128) + IC[0..8] (64 each = 576)
// Total: 64 + 128 + 128 + 128 + 576 = 1024 bytes
function pointG1ToBytes(pt) {
  // G1 point: x (32 bytes BE) + y (32 bytes BE)
  const x = BigInt(pt[0]);
  const y = BigInt(pt[1]);
  const buf = new Uint8Array(64);
  for (let i = 31; i >= 0; i--) { buf[31 - i] = Number((x >> BigInt(i * 8)) & 0xffn); }
  for (let i = 31; i >= 0; i--) { buf[63 - i] = Number((y >> BigInt(i * 8)) & 0xffn); }
  return buf;
}

function pointG2ToBytes(pt) {
  // G2 point: x1 (32 bytes) + x2 (32 bytes) + y1 (32 bytes) + y2 (32 bytes)
  const x1 = BigInt(pt[0][0]);
  const x2 = BigInt(pt[0][1]);
  const y1 = BigInt(pt[1][0]);
  const y2 = BigInt(pt[1][1]);
  const buf = new Uint8Array(128);
  for (let i = 31; i >= 0; i--) { buf[31 - i] = Number((x1 >> BigInt(i * 8)) & 0xffn); }
  for (let i = 31; i >= 0; i--) { buf[63 - i] = Number((x2 >> BigInt(i * 8)) & 0xffn); }
  for (let i = 31; i >= 0; i--) { buf[95 - i] = Number((y1 >> BigInt(i * 8)) & 0xffn); }
  for (let i = 31; i >= 0; i--) { buf[127 - i] = Number((y2 >> BigInt(i * 8)) & 0xffn); }
  return buf;
}

const vkBytes = new Uint8Array(1024);
let offset = 0;

// vk_alpha_1 (G1 = 64 bytes)
vkBytes.set(pointG1ToBytes(vkJson.vk_alpha_1), offset); offset += 64;

// vk_beta_2 (G2 = 128 bytes)
vkBytes.set(pointG2ToBytes(vkJson.vk_beta_2), offset); offset += 128;

// vk_gamma_2 (G2 = 128 bytes)
vkBytes.set(pointG2ToBytes(vkJson.vk_gamma_2), offset); offset += 128;

// vk_delta_2 (G2 = 128 bytes)
vkBytes.set(pointG2ToBytes(vkJson.vk_delta_2), offset); offset += 128;

// IC points (9 G1 points for 8 public inputs: IC[0..8])
for (let i = 0; i < vkJson.IC.length; i++) {
  vkBytes.set(pointG1ToBytes(vkJson.IC[i]), offset); offset += 64;
}

console.log('VK total bytes:', offset);
console.log('IC count:', vkJson.IC.length, '(expected 9 for 8 public inputs)');

// Compute keccak256 hash for integrity
const jsSha3 = await import('js-sha3');
const keccak256Fn = jsSha3.default.keccak256 || jsSha3.keccak256;
const vkHash = Buffer.from(keccak256Fn.arrayBuffer(vkBytes));
console.log('VK hash:', vkHash.toString('hex'));

// Upload
const vkBase64 = Buffer.from(vkBytes.buffer, vkBytes.byteOffset, offset).toString('base64');
const hashBase64 = vkHash.toString('base64');

const uploadTx = invokeScript({
  dApp: contractBAddr,
  call: {
    function: 'setVerifyingKey',
    args: [
      { type: 'binary', value: 'base64:' + vkBase64 },
      { type: 'binary', value: 'base64:' + hashBase64 },
    ],
  },
  payment: [],
  fee: 5000000,
  chainId: CHAIN_ID,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const txId3 = await broadcast(uploadTx);
await waitForTx(txId3);

// ═══════════════════════════════════════════════════════════
// STEP 5: Verify
// ═══════════════════════════════════════════════════════════
console.log('\n═══ STEP 5: Verify VK uploaded ═══');
const dataRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk_set');
console.log('groth16_vk_set:', dataRes.data);

const vkDataRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk');
console.log('VK stored, length:', vkDataRes.data.value ? 'base64 length ' + vkDataRes.data.value.length : 'NOT SET');

console.log('\n✅ Contract B redeployed and VK uploaded successfully!');
