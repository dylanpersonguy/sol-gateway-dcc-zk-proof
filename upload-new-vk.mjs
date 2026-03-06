/**
 * Upload the new VK to Contract B (already redeployed with VK reset).
 */
import fs from 'fs';
import axios from 'axios';
import { invokeScript, libs } from '@decentralchain/decentralchain-transactions';
import jsSha3 from 'js-sha3';

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

async function broadcast(tx) {
  const r = await axios.post(NODE + '/transactions/broadcast', tx, {
    headers: { 'X-API-Key': API_KEY },
  });
  console.log('  TX broadcast OK:', r.data.id);
  return r.data.id;
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

// Check current VK status
const vkSetRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk_set');
console.log('Current groth16_vk_set:', vkSetRes.data.value);

if (vkSetRes.data.value === true) {
  console.log('VK is already set — need to reset first');
  process.exit(1);
}

// Serialize VK
const vkJson = JSON.parse(fs.readFileSync('zk/circuits/build/verification_key.json', 'utf8'));

function pointG1ToBytes(pt) {
  const x = BigInt(pt[0]);
  const y = BigInt(pt[1]);
  const buf = new Uint8Array(64);
  for (let i = 31; i >= 0; i--) { buf[31 - i] = Number((x >> BigInt(i * 8)) & 0xffn); }
  for (let i = 31; i >= 0; i--) { buf[63 - i] = Number((y >> BigInt(i * 8)) & 0xffn); }
  return buf;
}

function pointG2ToBytes(pt) {
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
vkBytes.set(pointG1ToBytes(vkJson.vk_alpha_1), offset); offset += 64;
vkBytes.set(pointG2ToBytes(vkJson.vk_beta_2), offset); offset += 128;
vkBytes.set(pointG2ToBytes(vkJson.vk_gamma_2), offset); offset += 128;
vkBytes.set(pointG2ToBytes(vkJson.vk_delta_2), offset); offset += 128;
for (let i = 0; i < vkJson.IC.length; i++) {
  vkBytes.set(pointG1ToBytes(vkJson.IC[i]), offset); offset += 64;
}
console.log('VK bytes:', offset, '(IC count:', vkJson.IC.length + ')');

// Hash
const keccak256Fn = jsSha3.keccak256;
const vkSlice = vkBytes.slice(0, offset);
const vkHash = Buffer.from(keccak256Fn.arrayBuffer(vkSlice));
console.log('VK keccak256:', vkHash.toString('hex'));

const vkBase64 = Buffer.from(vkSlice).toString('base64');
const hashBase64 = vkHash.toString('base64');

console.log('\nUploading VK...');
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

const txId = await broadcast(uploadTx);
await waitForTx(txId);

// Verify
const dataRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk_set');
console.log('\ngroth16_vk_set:', dataRes.data.value);
console.log('✅ New VK uploaded successfully!');
