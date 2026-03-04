#!/usr/bin/env node
/**
 * Compute all expected values for test vectors.
 * Reads spec/test-vectors.json, computes:
 *   - expected_preimage_hex
 *   - expected_message_id
 *   - expected_leaf_hash (Keccak256(0x00 || message_id))
 *   - expected_public_inputs (8 field elements for ZK circuit)
 * Writes back to spec/test-vectors.json.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vectorsPath = path.join(__dirname, '..', 'spec', 'test-vectors.json');

// ── helpers ──────────────────────────────────────────────────

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function writeU32LE(buf, offset, value) {
  buf[offset]     = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(buf, offset, value) {
  const v = BigInt(value);
  for (let i = 0; i < 8; i++)
    buf[offset + i] = Number((v >> BigInt(i * 8)) & 0xffn);
}

function writeI64LE(buf, offset, value) {
  const v = BigInt(value);
  const unsigned = v < 0n ? (1n << 64n) + v : v;
  writeU64LE(buf, offset, unsigned);
}

// BN128 scalar field
const BN128_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Split 32 bytes into two 128-bit LE unsigned integers.
 * Returns [lo, hi] where lo = bytes[0..16] as LE u128, hi = bytes[16..32] as LE u128.
 */
function splitTo128(bytes32) {
  let lo = 0n;
  for (let i = 15; i >= 0; i--) lo = (lo << 8n) | BigInt(bytes32[i]);
  let hi = 0n;
  for (let i = 31; i >= 16; i--) hi = (hi << 8n) | BigInt(bytes32[i]);
  return [lo, hi];
}

/**
 * Encode a field element as 32-byte big-endian for RIDE groth16Verify input packing.
 */
function fieldToBytes32BE(val) {
  const buf = new Uint8Array(32);
  let v = val;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// ── encode deposit ──────────────────────────────────────────

function encodeDeposit(f) {
  const domainBytes = new TextEncoder().encode(f.domain_sep);
  const totalLen = domainBytes.length + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
  const buf = new Uint8Array(totalLen);
  let off = 0;
  buf.set(domainBytes, off); off += domainBytes.length;
  writeU32LE(buf, off, f.src_chain_id); off += 4;
  writeU32LE(buf, off, f.dst_chain_id); off += 4;
  buf.set(hexToBytes(f.src_program_id), off); off += 32;
  writeU64LE(buf, off, f.slot); off += 8;
  writeU32LE(buf, off, f.event_index); off += 4;
  buf.set(hexToBytes(f.sender), off); off += 32;
  buf.set(hexToBytes(f.recipient), off); off += 32;
  writeU64LE(buf, off, f.amount); off += 8;
  writeU64LE(buf, off, f.nonce); off += 8;
  buf.set(hexToBytes(f.asset_id), off); off += 32;
  if (off !== totalLen) throw new Error(`Bad offset ${off} != ${totalLen}`);
  return buf;
}

function encodeUnlock(f) {
  const domainBytes = new TextEncoder().encode(f.domain_sep);
  const totalLen = domainBytes.length + 32 + 32 + 8 + 32 + 4 + 8;
  const buf = new Uint8Array(totalLen);
  let off = 0;
  buf.set(domainBytes, off); off += domainBytes.length;
  buf.set(hexToBytes(f.transfer_id), off); off += 32;
  buf.set(hexToBytes(f.recipient), off); off += 32;
  writeU64LE(buf, off, f.amount); off += 8;
  buf.set(hexToBytes(f.burn_tx_hash), off); off += 32;
  writeU32LE(buf, off, f.dcc_chain_id); off += 4;
  writeI64LE(buf, off, f.expiration); off += 8;
  if (off !== totalLen) throw new Error(`Bad offset ${off} != ${totalLen}`);
  return buf;
}

// ── compute ZK public inputs ────────────────────────────────

function computePublicInputs(messageIdBytes, f) {
  // Only for deposit messages with DCC_SOL_BRIDGE_V1 domain
  const recipientBytes = hexToBytes(f.recipient);
  const [rootLo, rootHi] = [0n, 0n]; // checkpoint root unknown — set to 0

  const [msgLo, msgHi] = splitTo128(messageIdBytes);
  const amount = BigInt(f.amount);
  const [recipLo, recipHi] = splitTo128(recipientBytes);
  const version = 1n;

  // Validate all fit in BN128 field
  for (const v of [msgLo, msgHi, amount, recipLo, recipHi, version]) {
    if (v >= BN128_ORDER) throw new Error(`Value ${v} exceeds BN128 order`);
  }

  return {
    checkpoint_root_lo: '0', // unknown / placeholder
    checkpoint_root_hi: '0',
    message_id_lo: msgLo.toString(),
    message_id_hi: msgHi.toString(),
    amount: amount.toString(),
    recipient_lo: recipLo.toString(),
    recipient_hi: recipHi.toString(),
    version: '1',
    // Also include the groth16Verify input packing (8x32-byte big-endian concat)
    ride_inputs_hex: bytesToHex(new Uint8Array([
      ...fieldToBytes32BE(0n),      // root_lo (placeholder)
      ...fieldToBytes32BE(0n),      // root_hi (placeholder)
      ...fieldToBytes32BE(msgLo),
      ...fieldToBytes32BE(msgHi),
      ...fieldToBytes32BE(amount),
      ...fieldToBytes32BE(recipLo),
      ...fieldToBytes32BE(recipHi),
      ...fieldToBytes32BE(version),
    ])),
  };
}

// ── main ────────────────────────────────────────────────────

const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8'));

for (const vec of data.vectors) {
  const isUnlock = vec.type === 'unlock';
  const f = vec.fields;

  // Encode
  let preimage;
  try {
    preimage = isUnlock ? encodeUnlock(f) : encodeDeposit(f);
  } catch (e) {
    console.error(`SKIP ${vec.id} (${vec.name}): ${e.message}`);
    continue;
  }

  // Verify preimage length
  if (preimage.length !== vec.expected_preimage_length) {
    console.error(`LENGTH MISMATCH ${vec.id}: got ${preimage.length}, expected ${vec.expected_preimage_length}`);
    continue;
  }

  vec.expected_preimage_hex = bytesToHex(preimage);

  // Hash
  const messageId = keccak_256(preimage);
  vec.expected_message_id = bytesToHex(messageId);

  // Leaf hash = Keccak256(0x00 || message_id)
  const leafPreimage = new Uint8Array(33);
  leafPreimage[0] = 0x00;
  leafPreimage.set(messageId, 1);
  vec.expected_leaf_hash = bytesToHex(keccak_256(leafPreimage));

  // ZK public inputs (deposit messages only)
  if (!isUnlock && f.domain_sep === 'DCC_SOL_BRIDGE_V1') {
    vec.expected_public_inputs = computePublicInputs(messageId, f);
  }
}

// Prettify and write
fs.writeFileSync(vectorsPath, JSON.stringify(data, null, 2) + '\n');
console.log(`Updated ${data.vectors.length} vectors in ${vectorsPath}`);

// Verify golden vector
const v001 = data.vectors[0];
if (v001.expected_message_id !== '6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444') {
  console.error('GOLDEN VECTOR MISMATCH!');
  process.exit(1);
} else {
  console.log('Golden vector V-001 verified ✓');
}
