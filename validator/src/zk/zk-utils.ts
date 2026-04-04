/**
 * ZK Utility Functions — extracted from zk-bridge-service.ts
 *
 * Message ID computation, Merkle tree, proof serializers, and bit/byte helpers.
 */

// ═══════════════════════════════════════════════════════════════
// MESSAGE ID COMPUTATION (mirrors zk/prover/src/message.ts)
// ═══════════════════════════════════════════════════════════════

export const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';

export function writeU32LE(buf: Uint8Array, value: number, offset: number): void {
  buf[offset]     = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

export function writeU64LE(buf: Uint8Array, value: bigint, offset: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

export function computeMessageId(
  srcChainId: number,
  dstChainId: number,
  srcProgramId: Uint8Array,
  slot: bigint,
  eventIndex: number,
  sender: Uint8Array,
  recipient: Uint8Array,
  amount: bigint,
  nonce: bigint,
  assetId: Uint8Array,
): Uint8Array {
  const preimage = new Uint8Array(181);
  let offset = 0;

  // domain separator (17 bytes)
  const domainBytes = new TextEncoder().encode(DOMAIN_SEP);
  preimage.set(domainBytes, offset); offset += 17;

  // src_chain_id (4 bytes LE)
  writeU32LE(preimage, srcChainId, offset); offset += 4;
  // dst_chain_id (4 bytes LE)
  writeU32LE(preimage, dstChainId, offset); offset += 4;
  // src_program_id (32 bytes)
  preimage.set(srcProgramId.subarray(0, 32), offset); offset += 32;
  // slot (8 bytes LE)
  writeU64LE(preimage, slot, offset); offset += 8;
  // event_index (4 bytes LE)
  writeU32LE(preimage, eventIndex, offset); offset += 4;
  // sender (32 bytes)
  preimage.set(sender.subarray(0, 32), offset); offset += 32;
  // recipient (32 bytes)
  preimage.set(recipient.subarray(0, 32), offset); offset += 32;
  // amount (8 bytes LE)
  writeU64LE(preimage, amount, offset); offset += 8;
  // nonce (8 bytes LE)
  writeU64LE(preimage, nonce, offset); offset += 8;
  // asset_id (32 bytes)
  preimage.set(assetId.subarray(0, 32), offset); offset += 32;

  // Keccak256 hash
  const keccak256 = require('js-sha3').keccak256;
  const hash = keccak256(preimage);
  return new Uint8Array(hash.match(/.{2}/g).map((b: string) => parseInt(b, 16)));
}

// ═══════════════════════════════════════════════════════════════
// MERKLE TREE (mirrors zk/prover/src/merkle.ts)
// ═══════════════════════════════════════════════════════════════

export const TREE_DEPTH = 20;
const ZERO_LEAF = new Uint8Array(32); // 32 zero bytes

export function keccak256Hash(data: Uint8Array): Uint8Array {
  const keccak256 = require('js-sha3').keccak256;
  const hash = keccak256(data);
  return new Uint8Array(hash.match(/.{2}/g).map((b: string) => parseInt(b, 16)));
}

export function computeLeaf(messageId: Uint8Array): Uint8Array {
  // Domain-separated: keccak256(0x00 || messageId)
  const leafPreimage = new Uint8Array(33);
  leafPreimage[0] = 0x00;
  leafPreimage.set(messageId, 1);
  return keccak256Hash(leafPreimage);
}

export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  // Domain-separated: keccak256(0x01 || left || right)
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(left, 1);
  nodePreimage.set(right, 33);
  return keccak256Hash(nodePreimage);
}

export function buildMerkleTree(messageIds: Uint8Array[]): {
  root: Uint8Array;
  leaves: Uint8Array[];
} {
  const maxLeaves = 1 << TREE_DEPTH; // 2^20

  // Compute leaves
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < maxLeaves; i++) {
    if (i < messageIds.length) {
      leaves.push(computeLeaf(messageIds[i]));
    } else {
      leaves.push(computeLeaf(ZERO_LEAF));
    }
  }

  // Build tree bottom-up
  let currentLevel = leaves;
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(hashNode(currentLevel[i], currentLevel[i + 1]));
    }
    currentLevel = nextLevel;
  }

  return { root: currentLevel[0], leaves };
}

export function getMerkleProof(
  messageIds: Uint8Array[],
  eventIdx: number,
): { siblings: Uint8Array[]; pathIndices: number[] } {
  const maxLeaves = 1 << TREE_DEPTH;
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < maxLeaves; i++) {
    if (i < messageIds.length) {
      leaves.push(computeLeaf(messageIds[i]));
    } else {
      leaves.push(computeLeaf(ZERO_LEAF));
    }
  }

  const siblings: Uint8Array[] = [];
  const pathIndices: number[] = [];
  let currentLevel = leaves;
  let idx = eventIdx;

  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(currentLevel[siblingIdx]);
    pathIndices.push(idx % 2);

    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(hashNode(currentLevel[i], currentLevel[i + 1]));
    }
    currentLevel = nextLevel;
    idx = Math.floor(idx / 2);
  }

  return { siblings, pathIndices };
}

// ═══════════════════════════════════════════════════════════════
// SERIALIZERS (mirrors zk/prover/src/serializer.ts)
// ═══════════════════════════════════════════════════════════════

export function fieldElementToBytes(decStr: string): Uint8Array {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

export function serializeProofForRIDE(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Uint8Array {
  const result = new Uint8Array(256);
  let offset = 0;
  result.set(fieldElementToBytes(proof.pi_a[0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_a[1]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[1][1]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_c[0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_c[1]), offset); offset += 32;
  return result;
}

export function serializeInputsForRIDE(publicSignals: string[]): Uint8Array {
  const result = new Uint8Array(256);
  for (let i = 0; i < 8; i++) {
    result.set(fieldElementToBytes(publicSignals[i]), i * 32);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// BIT CONVERSION HELPERS (for circuit inputs)
// ═══════════════════════════════════════════════════════════════

export function bytesToBitsLE(bytes: Uint8Array): string[] {
  const bits: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1).toString());
    }
  }
  return bits;
}

export function numberToBitsLE(value: number | bigint, numBits: number): string[] {
  const bits: string[] = [];
  let v = BigInt(value);
  for (let i = 0; i < numBits; i++) {
    bits.push((v & 1n).toString());
    v >>= 1n;
  }
  return bits;
}

export function hashToFieldElements(hash: Uint8Array): { lo: bigint; hi: bigint } {
  // Split 256-bit hash into two 128-bit field elements (lo, hi)
  // LITTLE-ENDIAN interpretation so that Num2Bits(128) in the circuit
  // produces bits matching the keccak256 LSBF byte-order output:
  //   lo = hash[0] + hash[1]*2^8 + ... + hash[15]*2^120
  //   hi = hash[16] + hash[17]*2^8 + ... + hash[31]*2^120
  let lo = 0n;
  for (let i = 15; i >= 0; i--) {
    lo = (lo << 8n) | BigInt(hash[i]);
  }
  let hi = 0n;
  for (let i = 31; i >= 16; i--) {
    hi = (hi << 8n) | BigInt(hash[i]);
  }
  return { lo, hi };
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(clean.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

/** Decode a base58-encoded string to raw bytes, padded/truncated to targetLen */
export function base58ToBytes(b58: string, targetLen: number): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const char of b58) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  // Convert bigint to bytes (big-endian)
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const rawBytes = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  // Count leading '1's (which represent leading zero bytes in base58)
  let leadingZeros = 0;
  for (const c of b58) {
    if (c === '1') leadingZeros++;
    else break;
  }
  // Build result with leading zeros + raw bytes, padded to targetLen
  const result = new Uint8Array(targetLen);
  const totalBytes = leadingZeros + rawBytes.length;
  const startOffset = Math.max(0, targetLen - totalBytes);
  // Fill leading zeros
  for (let i = 0; i < leadingZeros && (startOffset + i) < targetLen; i++) {
    result[startOffset + i] = 0;
  }
  // Copy raw bytes
  const rawStart = startOffset + leadingZeros;
  for (let i = 0; i < rawBytes.length && (rawStart + i) < targetLen; i++) {
    result[rawStart + i] = rawBytes[i];
  }
  return result;
}
