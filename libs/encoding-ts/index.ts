/**
 * SOL ⇄ DCC Bridge — Canonical Encoding Library (TypeScript)
 *
 * Single source of truth for message encoding/hashing.
 * Must produce identical bytes to Rust `compute_message_id()` and RIDE `computeMessageId()`.
 */

import { keccak_256 } from '@noble/hashes/sha3';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface DepositEnvelope {
  domainSep?: string; // default: "DCC_SOL_BRIDGE_V1"
  srcChainId: number; // u32
  dstChainId: number; // u32
  srcProgramId: Uint8Array; // 32 bytes
  slot: bigint; // u64
  eventIndex: number; // u32
  sender: Uint8Array; // 32 bytes
  recipient: Uint8Array; // 32 bytes
  amount: bigint; // u64
  nonce: bigint; // u64
  assetId: Uint8Array; // 32 bytes
}

export interface UnlockEnvelope {
  domainSep?: string; // default: "SOL_DCC_BRIDGE_UNLOCK_V1"
  transferId: Uint8Array; // 32 bytes
  recipient: Uint8Array; // 32 bytes
  amount: bigint; // u64
  burnTxHash: Uint8Array; // 32 bytes
  dccChainId: number; // u32
  expiration: bigint; // i64
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const DOMAIN_SEP_DEPOSIT = 'DCC_SOL_BRIDGE_V1';
export const DOMAIN_SEP_UNLOCK = 'SOL_DCC_BRIDGE_UNLOCK_V1';
export const DOMAIN_SEP_MINT = 'SOL_DCC_BRIDGE_V1_MINT';

export const DEPOSIT_PREIMAGE_LENGTH = 181;
export const UNLOCK_PREIMAGE_LENGTH = 140;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

function writeI64LE(buf: Uint8Array, offset: number, value: bigint): void {
  // Two's complement for negative values
  const unsigned = value < 0n ? (1n << 64n) + value : value;
  writeU64LE(buf, offset, unsigned);
}

function copyBytes(dst: Uint8Array, offset: number, src: Uint8Array, length: number): void {
  const toCopy = Math.min(src.length, length);
  dst.set(src.subarray(0, toCopy), offset);
  // Zero-fill remainder (Uint8Array is already zeroed on creation)
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ═══════════════════════════════════════════════════════════════
// Encoders
// ═══════════════════════════════════════════════════════════════

/**
 * Encode a deposit message into canonical bytes.
 * Total: 181 bytes.
 */
export function encodeDepositMessage(env: DepositEnvelope): Uint8Array {
  const domainSep = env.domainSep || DOMAIN_SEP_DEPOSIT;
  const domainBytes = new TextEncoder().encode(domainSep);

  if (env.srcProgramId.length !== 32) throw new Error('srcProgramId must be 32 bytes');
  if (env.sender.length !== 32) throw new Error('sender must be 32 bytes');
  if (env.recipient.length !== 32) throw new Error('recipient must be 32 bytes');
  if (env.assetId.length !== 32) throw new Error('assetId must be 32 bytes');

  const totalLength = domainBytes.length + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
  const buf = new Uint8Array(totalLength);
  let offset = 0;

  // domain_sep
  buf.set(domainBytes, offset);
  offset += domainBytes.length;

  // src_chain_id (u32 LE)
  writeU32LE(buf, offset, env.srcChainId);
  offset += 4;

  // dst_chain_id (u32 LE)
  writeU32LE(buf, offset, env.dstChainId);
  offset += 4;

  // src_program_id (32 bytes)
  copyBytes(buf, offset, env.srcProgramId, 32);
  offset += 32;

  // slot (u64 LE)
  writeU64LE(buf, offset, env.slot);
  offset += 8;

  // event_index (u32 LE)
  writeU32LE(buf, offset, env.eventIndex);
  offset += 4;

  // sender (32 bytes)
  copyBytes(buf, offset, env.sender, 32);
  offset += 32;

  // recipient (32 bytes)
  copyBytes(buf, offset, env.recipient, 32);
  offset += 32;

  // amount (u64 LE)
  writeU64LE(buf, offset, env.amount);
  offset += 8;

  // nonce (u64 LE)
  writeU64LE(buf, offset, env.nonce);
  offset += 8;

  // asset_id (32 bytes)
  copyBytes(buf, offset, env.assetId, 32);
  offset += 32;

  if (offset !== totalLength) {
    throw new Error(`Encoding error: expected ${totalLength} bytes, wrote ${offset}`);
  }

  return buf;
}

/**
 * Encode an unlock message into canonical bytes.
 * Total: 140 bytes.
 */
export function encodeUnlockMessage(env: UnlockEnvelope): Uint8Array {
  const domainSep = env.domainSep || DOMAIN_SEP_UNLOCK;
  const domainBytes = new TextEncoder().encode(domainSep);

  if (env.transferId.length !== 32) throw new Error('transferId must be 32 bytes');
  if (env.recipient.length !== 32) throw new Error('recipient must be 32 bytes');
  if (env.burnTxHash.length !== 32) throw new Error('burnTxHash must be 32 bytes');

  const totalLength = domainBytes.length + 32 + 32 + 8 + 32 + 4 + 8;
  const buf = new Uint8Array(totalLength);
  let offset = 0;

  buf.set(domainBytes, offset);
  offset += domainBytes.length;

  copyBytes(buf, offset, env.transferId, 32);
  offset += 32;

  copyBytes(buf, offset, env.recipient, 32);
  offset += 32;

  writeU64LE(buf, offset, env.amount);
  offset += 8;

  copyBytes(buf, offset, env.burnTxHash, 32);
  offset += 32;

  writeU32LE(buf, offset, env.dccChainId);
  offset += 4;

  writeI64LE(buf, offset, env.expiration);
  offset += 8;

  if (offset !== totalLength) {
    throw new Error(`Encoding error: expected ${totalLength} bytes, wrote ${offset}`);
  }

  return buf;
}

/**
 * Hash a message preimage using Keccak-256.
 * Returns the 32-byte message_id.
 */
export function hashMessage(preimage: Uint8Array): Uint8Array {
  return keccak_256(preimage);
}

/**
 * Compute the message_id for a deposit envelope.
 */
export function computeDepositMessageId(env: DepositEnvelope): Uint8Array {
  const preimage = encodeDepositMessage(env);
  return hashMessage(preimage);
}

/**
 * Parse a deposit preimage back into an envelope.
 */
export function parseDepositMessage(bytes: Uint8Array): DepositEnvelope {
  if (bytes.length < DEPOSIT_PREIMAGE_LENGTH) {
    throw new Error(`Invalid preimage length: ${bytes.length}, expected >= ${DEPOSIT_PREIMAGE_LENGTH}`);
  }

  const domainSep = new TextDecoder().decode(bytes.subarray(0, 17));
  let offset = 17;

  const srcChainId = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  offset += 4;

  const dstChainId = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  offset += 4;

  const srcProgramId = bytes.slice(offset, offset + 32);
  offset += 32;

  let slot = 0n;
  for (let i = 0; i < 8; i++) slot |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  offset += 8;

  const eventIndex = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  offset += 4;

  const sender = bytes.slice(offset, offset + 32);
  offset += 32;

  const recipient = bytes.slice(offset, offset + 32);
  offset += 32;

  let amount = 0n;
  for (let i = 0; i < 8; i++) amount |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  offset += 8;

  let nonce = 0n;
  for (let i = 0; i < 8; i++) nonce |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  offset += 8;

  const assetId = bytes.slice(offset, offset + 32);

  return {
    domainSep,
    srcChainId: srcChainId >>> 0,
    dstChainId: dstChainId >>> 0,
    srcProgramId,
    slot,
    eventIndex: eventIndex >>> 0,
    sender,
    recipient,
    amount,
    nonce,
    assetId,
  };
}

// ═══════════════════════════════════════════════════════════════
// Exports for test vector validation
// ═══════════════════════════════════════════════════════════════

export { hexToBytes, bytesToHex };
