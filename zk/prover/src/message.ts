/**
 * DCC <-> Solana ZK Bridge — Shared Message Hashing Library
 *
 * This module implements the canonical message_id computation
 * that is identical across:
 *   - Solana (Rust)       → programs/sol-bridge-lock/src/instructions/deposit.rs
 *   - DCC (RIDE)          → dcc/contracts/bridge/zk_bridge.ride
 *   - ZK Prover (TypeScript) → this file
 *   - Circom circuit      → zk/circuits/bridge_deposit.circom
 *
 * SPEC:
 * message_id = Keccak256(
 *   "DCC_SOL_BRIDGE_V1"   (17 bytes, UTF-8)
 *   || src_chain_id       (4 bytes, LE u32)
 *   || dst_chain_id       (4 bytes, LE u32)
 *   || src_program_id     (32 bytes)
 *   || slot               (8 bytes, LE u64)
 *   || event_index        (4 bytes, LE u32)
 *   || sender             (32 bytes)
 *   || recipient          (32 bytes)
 *   || amount             (8 bytes, LE u64)
 *   || nonce              (8 bytes, LE u64)
 *   || asset_id           (32 bytes)
 * )
 * Total: 181 bytes
 *
 * leaf = Keccak256(message_id)
 */

import { keccak256 } from 'ethers';

export const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';
export const SOL_CHAIN_ID = 1;
export const DCC_CHAIN_ID = 2;
export const BRIDGE_VERSION = 1;
export const NATIVE_SOL_ASSET = 'So11111111111111111111111111111111111111112';
export const MERKLE_TREE_DEPTH = 20;

/**
 * Parameters for message_id computation
 */
export interface MessageFields {
  srcChainId: number;
  dstChainId: number;
  srcProgramId: Uint8Array; // 32 bytes
  slot: bigint;
  eventIndex: number;
  sender: Uint8Array;       // 32 bytes
  recipient: Uint8Array;    // 32 bytes
  amount: bigint;
  nonce: bigint;
  assetId: Uint8Array;      // 32 bytes
}

/**
 * Write a u32 in little-endian to a buffer at an offset
 */
function writeU32LE(buf: Uint8Array, value: number, offset: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Write a u64 in little-endian to a buffer at an offset
 */
function writeU64LE(buf: Uint8Array, value: bigint, offset: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

/**
 * Compute the canonical message_id for a bridge deposit event.
 * This MUST produce identical output to the Rust and RIDE implementations.
 */
export function computeMessageId(fields: MessageFields): Uint8Array {
  const preimage = new Uint8Array(181);
  let offset = 0;

  // Domain separator (17 bytes)
  const domainBytes = new TextEncoder().encode(DOMAIN_SEP);
  preimage.set(domainBytes, offset);
  offset += 17;

  // src_chain_id (4 bytes LE)
  writeU32LE(preimage, fields.srcChainId, offset);
  offset += 4;

  // dst_chain_id (4 bytes LE)
  writeU32LE(preimage, fields.dstChainId, offset);
  offset += 4;

  // src_program_id (32 bytes)
  preimage.set(fields.srcProgramId, offset);
  offset += 32;

  // slot (8 bytes LE)
  writeU64LE(preimage, fields.slot, offset);
  offset += 8;

  // event_index (4 bytes LE)
  writeU32LE(preimage, fields.eventIndex, offset);
  offset += 4;

  // sender (32 bytes)
  preimage.set(fields.sender, offset);
  offset += 32;

  // recipient (32 bytes)
  preimage.set(fields.recipient, offset);
  offset += 32;

  // amount (8 bytes LE)
  writeU64LE(preimage, fields.amount, offset);
  offset += 8;

  // nonce (8 bytes LE)
  writeU64LE(preimage, fields.nonce, offset);
  offset += 8;

  // asset_id (32 bytes)
  preimage.set(fields.assetId, offset);
  offset += 32;

  // Keccak256
  const hashHex = keccak256(preimage);
  return hexToBytes(hashHex);
}

/**
 * Compute the Merkle leaf: leaf = Keccak256(0x00 || message_id)
 * FIX: ZK-M3 — Domain-separated leaf hash (RFC 6962 §2.1)
 * 0x00 prefix distinguishes leaves from internal nodes (0x01)
 */
export function computeLeaf(messageId: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(1 + messageId.length);
  prefixed[0] = 0x00;  // leaf domain separator
  prefixed.set(messageId, 1);
  const hashHex = keccak256(prefixed);
  return hexToBytes(hashHex);
}

/**
 * Compute the empty leaf (used for padding in the Merkle tree)
 */
export function computeEmptyLeaf(): Uint8Array {
  const zero = new Uint8Array(32);
  const hashHex = keccak256(zero);
  return hexToBytes(hashHex);
}

/**
 * Compute Keccak256(0x01 || left || right) for Merkle tree inner nodes
 * FIX: ZK-M3 — Domain-separated node hash (RFC 6962 §2.1)
 * 0x01 prefix distinguishes internal nodes from leaves (0x00)
 */
export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(1 + 64);
  combined[0] = 0x01;  // internal node domain separator
  combined.set(left, 1);
  combined.set(right, 33);
  const hashHex = keccak256(combined);
  return hexToBytes(hashHex);
}

/**
 * Convert hex string (with 0x prefix) to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string (with 0x prefix)
 */
export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert bytes to an array of bits (LSB first within each byte)
 */
export function bytesToBitsLE(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
  }
  return bits;
}

/**
 * Convert a number to LE bit array of specified width
 */
export function numberToBitsLE(value: bigint | number, width: number): number[] {
  const v = BigInt(value);
  const bits: number[] = [];
  for (let i = 0; i < width; i++) {
    bits.push(Number((v >> BigInt(i)) & 1n));
  }
  return bits;
}

/**
 * Convert a byte array (first `len` bytes) to a BigInt interpreting as little-endian.
 * Used to split 256-bit hashes into two 128-bit field elements.
 *
 * FIX: ZK-H2 — Field-element public input packing
 */
export function bytesToLEBigInt(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    val = (val << 8n) | BigInt(bytes[i]);
  }
  return val;
}

/**
 * Split a 256-bit hash into two 128-bit field elements (lo, hi).
 *
 * lo = LE-interpret(hash[0..15])
 * hi = LE-interpret(hash[16..31])
 *
 * Both values are < 2^128 and always fit in the BN128 scalar field.
 */
export function hashToFieldElements(hash: Uint8Array): { lo: bigint; hi: bigint } {
  if (hash.length !== 32) throw new Error(`Expected 32-byte hash, got ${hash.length}`);
  return {
    lo: bytesToLEBigInt(hash.slice(0, 16)),
    hi: bytesToLEBigInt(hash.slice(16, 32)),
  };
}
