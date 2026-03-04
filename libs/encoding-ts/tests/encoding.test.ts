/**
 * Comprehensive test vector validation for the canonical encoding library.
 *
 * Loads /spec/test-vectors.json and asserts:
 *   - preimage bytes match expected hex
 *   - message_id (Keccak-256) matches expected hash
 *   - leaf hash matches expected
 *   - ZK public inputs match expected field elements
 *   - round-trip parse consistency
 *   - mutation tests: single-field changes produce different hashes
 *   - negative tests: wrong sizes rejected
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  encodeDepositMessage,
  encodeUnlockMessage,
  hashMessage,
  computeLeafHash,
  splitTo128,
  derivePublicInputs,
  packPublicInputsForRide,
  parseDepositMessage,
  hexToBytes,
  bytesToHex,
  DEPOSIT_PREIMAGE_LENGTH,
  UNLOCK_PREIMAGE_LENGTH,
  BN128_ORDER,
  DepositEnvelope,
} from '../index';

const vectorsPath = path.resolve(__dirname, '../../..', 'spec/test-vectors.json');
const vectorData = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8'));

// ═══════════════════════════════════════════════════════════════
// Helper to build envelope from vector fields
// ═══════════════════════════════════════════════════════════════

function makeDepositEnvelope(fields: any): DepositEnvelope {
  return {
    domainSep: fields.domain_sep,
    srcChainId: fields.src_chain_id,
    dstChainId: fields.dst_chain_id,
    srcProgramId: hexToBytes(fields.src_program_id),
    slot: BigInt(fields.slot),
    eventIndex: fields.event_index,
    sender: hexToBytes(fields.sender),
    recipient: hexToBytes(fields.recipient),
    amount: BigInt(fields.amount),
    nonce: BigInt(fields.nonce),
    assetId: hexToBytes(fields.asset_id),
  };
}

// ═══════════════════════════════════════════════════════════════
// Test Vectors — Preimage + Hash
// ═══════════════════════════════════════════════════════════════

describe('Test Vectors: Preimage & Hash', () => {
  for (const vec of vectorData.vectors) {
    const isUnlock = vec.type === 'unlock';

    it(`${vec.id}: ${vec.name} — preimage length`, () => {
      if (isUnlock) {
        const preimage = encodeUnlockMessage({
          domainSep: vec.fields.domain_sep,
          transferId: hexToBytes(vec.fields.transfer_id),
          recipient: hexToBytes(vec.fields.recipient),
          amount: BigInt(vec.fields.amount),
          burnTxHash: hexToBytes(vec.fields.burn_tx_hash),
          dccChainId: vec.fields.dcc_chain_id,
          expiration: BigInt(vec.fields.expiration),
        });
        expect(preimage.length).toBe(vec.expected_preimage_length);
      } else {
        const preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
        expect(preimage.length).toBe(vec.expected_preimage_length);
      }
    });

    if (vec.expected_preimage_hex) {
      it(`${vec.id}: ${vec.name} — preimage bytes match`, () => {
        let preimage: Uint8Array;
        if (isUnlock) {
          preimage = encodeUnlockMessage({
            domainSep: vec.fields.domain_sep,
            transferId: hexToBytes(vec.fields.transfer_id),
            recipient: hexToBytes(vec.fields.recipient),
            amount: BigInt(vec.fields.amount),
            burnTxHash: hexToBytes(vec.fields.burn_tx_hash),
            dccChainId: vec.fields.dcc_chain_id,
            expiration: BigInt(vec.fields.expiration),
          });
        } else {
          preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
        }
        expect(bytesToHex(preimage)).toBe(vec.expected_preimage_hex);
      });
    }

    if (vec.expected_message_id) {
      it(`${vec.id}: ${vec.name} — message_id matches`, () => {
        let preimage: Uint8Array;
        if (isUnlock) {
          preimage = encodeUnlockMessage({
            domainSep: vec.fields.domain_sep,
            transferId: hexToBytes(vec.fields.transfer_id),
            recipient: hexToBytes(vec.fields.recipient),
            amount: BigInt(vec.fields.amount),
            burnTxHash: hexToBytes(vec.fields.burn_tx_hash),
            dccChainId: vec.fields.dcc_chain_id,
            expiration: BigInt(vec.fields.expiration),
          });
        } else {
          preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
        }
        const messageId = hashMessage(preimage);
        expect(bytesToHex(messageId)).toBe(vec.expected_message_id);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Test Vectors — Leaf Hash
// ═══════════════════════════════════════════════════════════════

describe('Test Vectors: Leaf Hash', () => {
  for (const vec of vectorData.vectors) {
    if (!vec.expected_leaf_hash || vec.type === 'unlock') continue;

    it(`${vec.id}: leaf hash matches`, () => {
      const preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
      const messageId = hashMessage(preimage);
      const leafHash = computeLeafHash(messageId);
      expect(bytesToHex(leafHash)).toBe(vec.expected_leaf_hash);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Test Vectors — ZK Public Inputs
// ═══════════════════════════════════════════════════════════════

describe('Test Vectors: ZK Public Inputs', () => {
  for (const vec of vectorData.vectors) {
    if (!vec.expected_public_inputs) continue;

    it(`${vec.id}: public input derivation matches`, () => {
      const preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
      const messageId = hashMessage(preimage);
      const recipient = hexToBytes(vec.fields.recipient);

      const inputs = derivePublicInputs(messageId, BigInt(vec.fields.amount), recipient);
      const expected = vec.expected_public_inputs;

      expect(inputs.messageIdLo.toString()).toBe(expected.message_id_lo);
      expect(inputs.messageIdHi.toString()).toBe(expected.message_id_hi);
      expect(inputs.amount.toString()).toBe(expected.amount);
      expect(inputs.recipientLo.toString()).toBe(expected.recipient_lo);
      expect(inputs.recipientHi.toString()).toBe(expected.recipient_hi);
      expect(inputs.version.toString()).toBe(expected.version);
    });

    if (vec.expected_public_inputs.ride_inputs_hex) {
      it(`${vec.id}: RIDE input packing matches`, () => {
        const preimage = encodeDepositMessage(makeDepositEnvelope(vec.fields));
        const messageId = hashMessage(preimage);
        const recipient = hexToBytes(vec.fields.recipient);
        const inputs = derivePublicInputs(messageId, BigInt(vec.fields.amount), recipient);
        const packed = packPublicInputsForRide(inputs);
        expect(bytesToHex(packed)).toBe(vec.expected_public_inputs.ride_inputs_hex);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Round-Trip Parsing
// ═══════════════════════════════════════════════════════════════

describe('Round-Trip Parsing', () => {
  const MAX_U64 = (1n << 64n) - 1n;

  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    if (vec.fields.domain_sep !== 'DCC_SOL_BRIDGE_V1') continue;

    // Skip vectors with values that overflow u64 (intentional edge cases)
    const amount = BigInt(vec.fields.amount);
    const nonce = BigInt(vec.fields.nonce);
    const slot = BigInt(vec.fields.slot);
    if (amount > MAX_U64 || nonce > MAX_U64 || slot > MAX_U64) continue;

    it(`${vec.id}: parse round-trip preserves fields`, () => {
      const envelope = makeDepositEnvelope(vec.fields);
      const preimage = encodeDepositMessage(envelope);
      const parsed = parseDepositMessage(preimage);

      expect(parsed.srcChainId).toBe(vec.fields.src_chain_id);
      expect(parsed.dstChainId).toBe(vec.fields.dst_chain_id);
      expect(parsed.amount).toBe(BigInt(vec.fields.amount));
      expect(parsed.eventIndex).toBe(vec.fields.event_index);
      expect(parsed.slot).toBe(BigInt(vec.fields.slot));
      expect(parsed.nonce).toBe(BigInt(vec.fields.nonce));
      expect(bytesToHex(parsed.srcProgramId)).toBe(vec.fields.src_program_id);
      expect(bytesToHex(parsed.sender)).toBe(vec.fields.sender);
      expect(bytesToHex(parsed.recipient)).toBe(vec.fields.recipient);
      expect(bytesToHex(parsed.assetId)).toBe(vec.fields.asset_id);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Mutation Tests — Single-Field Changes MUST Produce Different Hashes
// ═══════════════════════════════════════════════════════════════

describe('Mutation Tests', () => {
  const baseEnvelope: DepositEnvelope = makeDepositEnvelope(vectorData.vectors[0].fields);
  const baseHash = bytesToHex(hashMessage(encodeDepositMessage(baseEnvelope)));

  const mutations: [string, Partial<DepositEnvelope>][] = [
    ['amount+1', { amount: baseEnvelope.amount + 1n }],
    ['nonce+1', { nonce: baseEnvelope.nonce + 1n }],
    ['slot+1', { slot: baseEnvelope.slot + 1n }],
    ['eventIndex+1', { eventIndex: baseEnvelope.eventIndex + 1 }],
    ['srcChainId swap', { srcChainId: baseEnvelope.dstChainId, dstChainId: baseEnvelope.srcChainId }],
    ['recipient bit flip', { recipient: (() => { const r = new Uint8Array(baseEnvelope.recipient); r[31] ^= 1; return r; })() }],
    ['sender bit flip', { sender: (() => { const s = new Uint8Array(baseEnvelope.sender); s[0] ^= 1; return s; })() }],
    ['asset_id bit flip', { assetId: (() => { const a = new Uint8Array(baseEnvelope.assetId); a[0] ^= 1; return a; })() }],
    ['src_program_id bit flip', { srcProgramId: (() => { const p = new Uint8Array(baseEnvelope.srcProgramId); p[0] ^= 1; return p; })() }],
  ];

  for (const [name, override] of mutations) {
    it(`Mutation: ${name} produces different hash`, () => {
      const mutated = { ...baseEnvelope, ...override };
      const mutatedHash = bytesToHex(hashMessage(encodeDepositMessage(mutated)));
      expect(mutatedHash).not.toBe(baseHash);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Cross-Vector Collision Tests
// ═══════════════════════════════════════════════════════════════

describe('Cross-Vector Collision Tests', () => {
  it('V-001 ≠ V-008 (chain IDs swapped)', () => {
    const h1 = bytesToHex(hashMessage(encodeDepositMessage(makeDepositEnvelope(vectorData.vectors[0].fields))));
    const v8 = vectorData.vectors.find((v: any) => v.id === 'V-008');
    const h8 = bytesToHex(hashMessage(encodeDepositMessage(makeDepositEnvelope(v8.fields))));
    expect(h1).not.toBe(h8);
  });

  it('V-012 ≠ V-013 (successive nonces)', () => {
    const v12 = vectorData.vectors.find((v: any) => v.id === 'V-012');
    const v13 = vectorData.vectors.find((v: any) => v.id === 'V-013');
    const h12 = bytesToHex(hashMessage(encodeDepositMessage(makeDepositEnvelope(v12.fields))));
    const h13 = bytesToHex(hashMessage(encodeDepositMessage(makeDepositEnvelope(v13.fields))));
    expect(h12).not.toBe(h13);
  });

  it('V-001 ≠ V-024 (amount+1)', () => {
    const h1 = vectorData.vectors[0].expected_message_id;
    const v24 = vectorData.vectors.find((v: any) => v.id === 'V-024');
    expect(h1).not.toBe(v24.expected_message_id);
  });

  it('V-001 ≠ V-025 (recipient bit flip)', () => {
    const h1 = vectorData.vectors[0].expected_message_id;
    const v25 = vectorData.vectors.find((v: any) => v.id === 'V-025');
    expect(h1).not.toBe(v25.expected_message_id);
  });

  it('V-001 ≠ V-030 (domain_sep V2 vs V1)', () => {
    const h1 = vectorData.vectors[0].expected_message_id;
    const v30 = vectorData.vectors.find((v: any) => v.id === 'V-030');
    expect(h1).not.toBe(v30.expected_message_id);
  });

  it('All deposit vectors produce unique message_ids', () => {
    const hashes = new Set<string>();
    for (const vec of vectorData.vectors) {
      if (vec.expected_message_id) {
        expect(hashes.has(vec.expected_message_id)).toBe(false);
        hashes.add(vec.expected_message_id);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Negative Tests — Error Handling
// ═══════════════════════════════════════════════════════════════

describe('Negative Tests — Fail Closed', () => {
  it('rejects srcProgramId with wrong length', () => {
    expect(() =>
      encodeDepositMessage({
        ...makeDepositEnvelope(vectorData.vectors[0].fields),
        srcProgramId: new Uint8Array(31),
      }),
    ).toThrow('srcProgramId must be 32 bytes');
  });

  it('rejects sender with wrong length', () => {
    expect(() =>
      encodeDepositMessage({
        ...makeDepositEnvelope(vectorData.vectors[0].fields),
        sender: new Uint8Array(33),
      }),
    ).toThrow('sender must be 32 bytes');
  });

  it('rejects recipient with wrong length', () => {
    expect(() =>
      encodeDepositMessage({
        ...makeDepositEnvelope(vectorData.vectors[0].fields),
        recipient: new Uint8Array(0),
      }),
    ).toThrow('recipient must be 32 bytes');
  });

  it('rejects assetId with wrong length', () => {
    expect(() =>
      encodeDepositMessage({
        ...makeDepositEnvelope(vectorData.vectors[0].fields),
        assetId: new Uint8Array(16),
      }),
    ).toThrow('assetId must be 32 bytes');
  });

  it('parseDepositMessage rejects short input', () => {
    expect(() => parseDepositMessage(new Uint8Array(100))).toThrow();
  });

  it('computeLeafHash rejects non-32-byte input', () => {
    expect(() => computeLeafHash(new Uint8Array(31))).toThrow();
  });

  it('splitTo128 rejects non-32-byte input', () => {
    expect(() => splitTo128(new Uint8Array(16))).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// splitTo128 Unit Tests
// ═══════════════════════════════════════════════════════════════

describe('splitTo128', () => {
  it('all zeros → [0n, 0n]', () => {
    const [lo, hi] = splitTo128(new Uint8Array(32));
    expect(lo).toBe(0n);
    expect(hi).toBe(0n);
  });

  it('byte 0 = 0x01 → lo = 1n, hi = 0n', () => {
    const buf = new Uint8Array(32);
    buf[0] = 1;
    const [lo, hi] = splitTo128(buf);
    expect(lo).toBe(1n);
    expect(hi).toBe(0n);
  });

  it('byte 16 = 0x01 → lo = 0n, hi = 1n', () => {
    const buf = new Uint8Array(32);
    buf[16] = 1;
    const [lo, hi] = splitTo128(buf);
    expect(lo).toBe(0n);
    expect(hi).toBe(1n);
  });

  it('all 0xFF bytes', () => {
    const buf = new Uint8Array(32).fill(0xff);
    const [lo, hi] = splitTo128(buf);
    const maxU128 = (1n << 128n) - 1n;
    expect(lo).toBe(maxU128);
    expect(hi).toBe(maxU128);
  });

  it('all values fit in BN128 field', () => {
    const buf = new Uint8Array(32).fill(0xff);
    const [lo, hi] = splitTo128(buf);
    expect(lo < BN128_ORDER).toBe(true);
    expect(hi < BN128_ORDER).toBe(true);
  });
});
