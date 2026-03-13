/**
 * Re-upload VK in compressed BN256 format (512 bytes for 8 inputs)
 * 
 * DCC bn256Groth16Verify expects compressed points:
 *   G1 = 32 bytes (x big-endian, MSB flag for y > p/2)
 *   G2 = 64 bytes (x_im(32) + x_re(32), MSB flag for y)
 */
import fs from 'fs';
import axios from 'axios';
import { invokeScript, libs } from '@decentralchain/decentralchain-transactions';

import dotenv from 'dotenv';
dotenv.config();

function required(name) { const v = process.env[name]; if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); } return v; }

const NODE = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY = required('DCC_API_KEY');
const BASE_SEED = required('DCC_VALIDATOR_SEED');
const { seedWithNonce, publicKey, privateKey, address } = libs.crypto;
const B_SEED = seedWithNonce(BASE_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractBPubKey = publicKey(B_SEED);
const contractBAddr = address(B_SEED, 63);

console.log('Contract B:', contractBAddr);

const BN256_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const HALF_P = BN256_P / 2n;

function fieldToBytes32BE(decStr) {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function compressG1(pt) {
  const x = BigInt(pt[0]);
  const y = BigInt(pt[1]);
  const bytes = fieldToBytes32BE(pt[0]);
  if (y > HALF_P) bytes[0] |= 0x80;
  return bytes;
}

function compressG2(pt) {
  // snarkjs G2: pt[0] = [x_real, x_imag], pt[1] = [y_real, y_imag]
  // pairing_ce compressed: c1(imag) first, c0(real) second, y-flag on c1 of y
  const bytes = new Uint8Array(64);
  bytes.set(fieldToBytes32BE(pt[0][1]), 0);   // x_imag = c1 (first in compressed)
  bytes.set(fieldToBytes32BE(pt[0][0]), 32);  // x_real = c0 (second in compressed)
  const y_imag = BigInt(pt[1][1]);
  if (y_imag > HALF_P) bytes[0] |= 0x80;
  return bytes;
}

const vkJson = JSON.parse(fs.readFileSync('zk/circuits/build/verification_key.json', 'utf8'));

// Compressed VK layout (512 bytes for 8 inputs):
// alpha (G1: 32B) + beta (G2: 64B) + gamma (G2: 64B) + delta (G2: 64B) + IC[0..8] (9 × G1: 288B)
const vkBytes = new Uint8Array(512);
let offset = 0;

console.log('alpha_1:', vkJson.vk_alpha_1[0].substring(0,20), '...');
vkBytes.set(compressG1(vkJson.vk_alpha_1), offset); offset += 32;

console.log('beta_2:', vkJson.vk_beta_2[0][0].substring(0,20), '...');
vkBytes.set(compressG2(vkJson.vk_beta_2), offset); offset += 64;

vkBytes.set(compressG2(vkJson.vk_gamma_2), offset); offset += 64;
vkBytes.set(compressG2(vkJson.vk_delta_2), offset); offset += 64;

for (let i = 0; i < vkJson.IC.length; i++) {
  vkBytes.set(compressG1(vkJson.IC[i]), offset); offset += 32;
}

console.log('VK total bytes:', offset);
console.log('IC count:', vkJson.IC.length);

// Compute hash
const jsSha3 = await import('js-sha3');
const keccak256Fn = jsSha3.default.keccak256 || jsSha3.keccak256;
const vkHash = Buffer.from(keccak256Fn.arrayBuffer(vkBytes));
console.log('VK hash:', vkHash.toString('hex'));

// Reset VK first
console.log('\nResetting VK...');
const resetTx = invokeScript({
  dApp: contractBAddr,
  call: { function: 'resetVerifyingKey', args: [] },
  payment: [],
  fee: 5000000,
  chainId: 63,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const r1 = await axios.post(NODE + '/transactions/broadcast', resetTx, {
  headers: { 'X-API-Key': API_KEY },
});
console.log('Reset TX:', r1.data.id);

// Wait for confirmation
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await axios.get(NODE + '/transactions/info/' + r1.data.id);
    if (r.data?.id) { console.log('Reset confirmed'); break; }
  } catch {}
}

// Upload compressed VK
console.log('\nUploading compressed VK (512 bytes)...');
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
  chainId: 63,
  senderPublicKey: contractBPubKey,
  version: 1,
}, B_SIGNER);

const r2 = await axios.post(NODE + '/transactions/broadcast', uploadTx, {
  headers: { 'X-API-Key': API_KEY },
});
console.log('Upload TX:', r2.data.id);

for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await axios.get(NODE + '/transactions/info/' + r2.data.id);
    if (r.data?.id) { console.log('Upload confirmed'); break; }
  } catch {}
}

// Verify
const vkSetRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk_set');
console.log('\nVK set:', vkSetRes.data.value);
const vkDataRes = await axios.get(NODE + '/addresses/data/' + contractBAddr + '/groth16_vk');
const storedLen = vkDataRes.data.value ? Buffer.from(vkDataRes.data.value.replace('base64:', ''), 'base64').length : 0;
console.log('VK stored size:', storedLen, 'bytes (expected 512)');

console.log('\n✅ Compressed VK uploaded successfully!');
