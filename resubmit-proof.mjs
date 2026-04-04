/**
 * Fast proof re-submission — reads saved proof data and re-submits with current serialization.
 * Use after modifying compression functions to iterate quickly.
 */
import fs from 'fs';
import {
  invokeScript,
  broadcast,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';
dotenv.config();

const DCC_NODE_URL = 'https://mainnet-node.decentralchain.io';
const DCC_SEED = process.env.DCC_VALIDATOR_SEED || (() => { throw new Error('Missing env var: DCC_VALIDATOR_SEED'); })();
const DCC_CHAIN_ID = process.env.DCC_CHAIN_ID_CHAR || String.fromCharCode(Number(process.env.DCC_CHAIN_ID) || 63);
const ZK_VERIFIER = '3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6';

const BN256_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const HALF_P = BN256_P / 2n;

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fieldElementToBytes(decStr) {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function toBase58(buf) {
  let num = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let result = '';
  while (num > 0n) {
    result = BS58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    result = '1' + result;
  }
  return result || '1';
}

function base58ToBytes(b58, targetLen) {
  let num = 0n;
  for (const char of b58) {
    const idx = BS58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const rawBytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  let leadingZeros = 0;
  for (const c of b58) { if (c === '1') leadingZeros++; else break; }
  const result = new Uint8Array(targetLen || (leadingZeros + rawBytes.length));
  result.set(rawBytes, result.length - rawBytes.length);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// SERIALIZATION FUNCTIONS — modify these to test different encodings
// ═══════════════════════════════════════════════════════════════

function serializeProofForRIDE(proof) {
  function compressG1(xDec, yDec) {
    const y = BigInt(yDec);
    const bytes = fieldElementToBytes(xDec);
    if (y > HALF_P) bytes[0] |= 0x80;
    return bytes;
  }

  function compressG2(xPair, yPair) {
    // snarkjs G2: xPair = [x_real, x_imag], yPair = [y_real, y_imag]
    // pairing_ce compressed: c1(imag) first, c0(real) second, y-flag on c1 of y
    const bytes = new Uint8Array(64);
    bytes.set(fieldElementToBytes(xPair[1]), 0);   // x_imag = c1 (first in compressed)
    bytes.set(fieldElementToBytes(xPair[0]), 32);  // x_real = c0 (second in compressed)
    const y_imag = BigInt(yPair[1]);
    if (y_imag > HALF_P) bytes[0] |= 0x80;
    return bytes;
  }

  const result = new Uint8Array(128);
  let offset = 0;
  result.set(compressG1(proof.pi_a[0], proof.pi_a[1]), offset); offset += 32;
  result.set(compressG2(proof.pi_b[0], proof.pi_b[1]), offset); offset += 64;
  result.set(compressG1(proof.pi_c[0], proof.pi_c[1]), offset); offset += 32;
  
  console.log(`  Proof bytes (128): ${bytesToHex(result).substring(0, 64)}...`);
  console.log(`  pi_a flag: ${(result[0] & 0x80) ? 'SET' : 'unset'}`);
  console.log(`  pi_b flag: ${(result[32] & 0x80) ? 'SET' : 'unset'}`);
  console.log(`  pi_c flag: ${(result[96] & 0x80) ? 'SET' : 'unset'}`);
  return result;
}

function serializeInputsForRIDE(publicSignals) {
  const result = new Uint8Array(256);
  for (let i = 0; i < 8; i++) {
    result.set(fieldElementToBytes(publicSignals[i]), i * 32);
  }
  console.log(`  Inputs bytes (256): ${bytesToHex(result).substring(0, 64)}...`);
  return result;
}

// ═══════════════════════════════════════════════════════════════

const data = JSON.parse(fs.readFileSync('/tmp/proof-data.json', 'utf8'));
const { proof, publicSignals, deposit, latestCheckpointId } = data;
const senderBytes = new Uint8Array(data.senderBytes);
const srcProgramId = new Uint8Array(data.srcProgramId);
const recipientPadded = new Uint8Array(data.recipientPadded);

console.log('Proof data loaded. Deposit:', deposit.nonce, 'Checkpoint:', latestCheckpointId);
console.log('Proof pi_a[0]:', proof.pi_a[0].substring(0, 30), '...');
console.log('Proof pi_b[0][0]:', proof.pi_b[0][0].substring(0, 30), '...');

const proofBytes = serializeProofForRIDE(proof);
const inputsBytes = serializeInputsForRIDE(publicSignals);
const proofBase64 = Buffer.from(proofBytes).toString('base64');
const inputsBase64 = Buffer.from(inputsBytes).toString('base64');

// Build transaction args
const recipientRawBytes = base58ToBytes(deposit.recipient, 26);
let lastNonZero = recipientRawBytes.length - 1;
while (lastNonZero > 0 && recipientRawBytes[lastNonZero] === 0) lastNonZero--;
const recipientTrimmed = recipientRawBytes.subarray(0, lastNonZero + 1);
const recipientAddress = toBase58(recipientTrimmed);

const srcProgramIdBase64 = Buffer.from(srcProgramId).toString('base64');
const senderBase64 = Buffer.from(senderBytes).toString('base64');
const recipientPaddedHex = bytesToHex(recipientPadded);
const recipientBytesBase64 = Buffer.from(recipientPaddedHex, 'hex').toString('base64');
const assetIdBase64 = Buffer.alloc(32).toString('base64');

const { seedWithNonce, privateKey, publicKey: pubKeyFn } = libs.crypto;
const B_SEED = seedWithNonce(DCC_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const bPubKey = pubKeyFn(B_SEED);

console.log(`\nSubmitting verifyAndMint...`);
console.log(`  Signer: ${bPubKey}`);
console.log(`  Recipient: ${recipientAddress}`);

const tx = invokeScript(
  {
    dApp: ZK_VERIFIER,
    call: {
      function: 'verifyAndMint',
      args: [
        { type: 'binary', value: `base64:${proofBase64}` },
        { type: 'binary', value: `base64:${inputsBase64}` },
        { type: 'integer', value: latestCheckpointId },
        { type: 'integer', value: 1 },
        { type: 'integer', value: 2 },
        { type: 'binary', value: `base64:${srcProgramIdBase64}` },
        { type: 'integer', value: deposit.slot },
        { type: 'integer', value: deposit.eventIndex },
        { type: 'binary', value: `base64:${senderBase64}` },
        { type: 'binary', value: `base64:${recipientBytesBase64}` },
        { type: 'integer', value: Number(deposit.amount) },
        { type: 'integer', value: Number(deposit.nonce) },
        { type: 'binary', value: `base64:${assetIdBase64}` },
        { type: 'string', value: recipientAddress },
      ],
    },
    payment: [],
    fee: 1800000,
    chainId: DCC_CHAIN_ID,
    senderPublicKey: bPubKey,
  },
  B_SIGNER,
);

try {
  const result = await broadcast(tx, DCC_NODE_URL);
  console.log(`\n✅ verifyAndMint tx broadcast: ${result.id}`);
} catch (err) {
  console.error(`\n❌ Broadcast failed: ${err.message}`);
  if (err.data) console.error('  Data:', JSON.stringify(err.data));
}
