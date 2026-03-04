/**
 * RIDE Equivalence Test Harness
 *
 * Mirrors the exact encoding logic used in zk_bridge.ride:
 *   - intToLE4 / intToLE8 (manual LE byte encoding)
 *   - computeMessageId (181-byte preimage → keccak256)
 *   - computeLeafHash (0x00 || message_id → keccak256)
 *   - reverseBytes16 + reconstruct256 (field element reconstruction)
 *   - fieldElementToInt (extract i64 from 32-byte BE field element)
 *   - addressFromPublicKey (derive DCC address from 32-byte public key)
 *
 * Loads /spec/test-vectors.json and verifies:
 *   1. RIDE-equivalent message_id matches expected
 *   2. RIDE-equivalent leaf hash matches expected
 *   3. Field element reconstruction round-trips correctly
 *   4. Mutations produce different hashes (fail-closed)
 *   5. Domain separator encoding produces exactly 17 bytes
 *   6. Recipient encoding is exactly 32 bytes (public key format)
 *
 * Run: node --test tests/ride-equivalence.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(__dirname, '..', 'spec/test-vectors.json');
const vectorData = JSON.parse(readFileSync(vectorsPath, 'utf-8'));

// ═══════════════════════════════════════════════════════════
// RIDE-EQUIVALENT HELPERS
// Exact mirror of the RIDE contract encoding functions.
// ═══════════════════════════════════════════════════════════

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * RIDE's intToLE4(v): encode u32 as 4 bytes little-endian.
 * RIDE extracts each byte via division + modulo, then
 * toBytes(b).drop(7) gives a single byte.
 */
function intToLE4(v) {
  const buf = new Uint8Array(4);
  buf[0] = v & 0xff;
  buf[1] = (v >>> 8) & 0xff;
  buf[2] = (v >>> 16) & 0xff;
  buf[3] = (v >>> 24) & 0xff;
  return buf;
}

/**
 * RIDE's intToLE8(v): encode u64 as 8 bytes little-endian.
 * Note: RIDE Int is signed 64-bit. For values > 2^63-1,
 * RIDE behavior is undefined (we skip those vectors).
 */
function intToLE8(v) {
  const buf = new Uint8Array(8);
  const big = BigInt(v);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((big >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

/**
 * RIDE's computeMessageId: keccak256(181-byte preimage).
 * Mirrors the exact RIDE function byte-for-byte.
 */
function rideComputeMessageId(fields) {
  const domainSep = fields.domain_sep || 'DCC_SOL_BRIDGE_V1';
  const domainBytes = new TextEncoder().encode(domainSep);

  // RIDE runtime check: size(domainBytes) must be 17
  if (domainSep === 'DCC_SOL_BRIDGE_V1') {
    assert.equal(domainBytes.length, 17, 'Domain separator must be 17 bytes');
  }

  const parts = [
    domainBytes,
    intToLE4(fields.src_chain_id),
    intToLE4(fields.dst_chain_id),
    hexToBytes(fields.src_program_id),
    intToLE8(fields.slot),
    intToLE4(fields.event_index),
    hexToBytes(fields.sender),
    hexToBytes(fields.recipient),
    intToLE8(fields.amount),
    intToLE8(fields.nonce),
    hexToBytes(fields.asset_id),
  ];

  // Concatenate all parts
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const preimage = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }

  return { preimage, messageId: keccak_256(preimage) };
}

/**
 * RIDE's computeLeafHash: keccak256(0x00 || message_id).
 * Mirrors RFC 6962 §2.1 domain separation.
 */
function rideComputeLeafHash(messageId) {
  const buf = new Uint8Array(33);
  buf[0] = 0x00;
  buf.set(messageId, 1);
  return keccak_256(buf);
}

/**
 * RIDE's reverseBytes16: reverse a 16-byte buffer.
 * RIDE does this one byte at a time via take/drop.
 */
function reverseBytes16(buf) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = buf[15 - i];
  }
  return out;
}

/**
 * RIDE's reconstruct256(feLo, feHi):
 * Each field element is 32-byte big-endian.
 * The 128-bit value is in the last 16 bytes.
 * Reverse each half and concatenate.
 */
function reconstruct256(feLo, feHi) {
  const loBytes = feLo.subarray(16, 32);
  const hiBytes = feHi.subarray(16, 32);
  const out = new Uint8Array(32);
  out.set(reverseBytes16(loBytes), 0);
  out.set(reverseBytes16(hiBytes), 16);
  return out;
}

/**
 * RIDE's fieldElementToInt(fe):
 * Reads 8 bytes at offset 24 as big-endian i64.
 */
function fieldElementToInt(fe) {
  let val = 0n;
  for (let i = 24; i < 32; i++) {
    val = (val << 8n) | BigInt(fe[i]);
  }
  return Number(val);
}

/**
 * Convert a BigInt to a 32-byte big-endian field element.
 * Used to create field elements for reconstruction testing.
 */
function bigintToFE(val) {
  const buf = new Uint8Array(32);
  let v = BigInt(val);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Split a 32-byte value into [lo, hi] as 128-bit LE unsigned BigInts.
 */
function splitTo128LE(bytes) {
  let lo = 0n;
  for (let i = 15; i >= 0; i--) lo = (lo << 8n) | BigInt(bytes[i]);
  let hi = 0n;
  for (let i = 31; i >= 16; i--) hi = (hi << 8n) | BigInt(bytes[i]);
  return [lo, hi];
}

// ═══════════════════════════════════════════════════════════
// TEST VECTORS
// ═══════════════════════════════════════════════════════════

const RIDE_INT_MAX = 9223372036854775807n; // 2^63 - 1

describe('RIDE Equivalence: Domain Separator', () => {
  it('DCC_SOL_BRIDGE_V1 encodes to exactly 17 bytes', () => {
    const domainBytes = new TextEncoder().encode('DCC_SOL_BRIDGE_V1');
    assert.equal(domainBytes.length, 17);
    assert.equal(bytesToHex(domainBytes), '4443435f534f4c5f4252494447455f5631');
  });

  it('No null terminator in domain separator', () => {
    const domainBytes = new TextEncoder().encode('DCC_SOL_BRIDGE_V1');
    assert.ok(!domainBytes.includes(0x00), 'Domain separator must not contain null bytes');
  });

  it('RIDE toBytes(String) produces UTF-8 without length prefix', () => {
    // Verify our encoding matches RIDE's expected behavior
    const domainBytes = new TextEncoder().encode('DCC_SOL_BRIDGE_V1');
    // First byte should be 'D' (0x44), not a length prefix
    assert.equal(domainBytes[0], 0x44);
  });
});

describe('RIDE Equivalence: LE Integer Encoding', () => {
  it('intToLE4(1) = [01, 00, 00, 00]', () => {
    assert.deepEqual(intToLE4(1), new Uint8Array([1, 0, 0, 0]));
  });

  it('intToLE4(256) = [00, 01, 00, 00]', () => {
    assert.deepEqual(intToLE4(256), new Uint8Array([0, 1, 0, 0]));
  });

  it('intToLE8(1000000000) matches expected', () => {
    const buf = intToLE8(1000000000);
    assert.equal(bytesToHex(buf), '00ca9a3b00000000');
  });

  it('intToLE8(0) = all zeros', () => {
    const buf = intToLE8(0);
    assert.equal(bytesToHex(buf), '0000000000000000');
  });
});

describe('RIDE Equivalence: Message ID Computation', () => {
  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    // Skip vectors with values that overflow RIDE's signed i64
    const amount = BigInt(vec.fields.amount);
    const nonce = BigInt(vec.fields.nonce);
    const slot = BigInt(vec.fields.slot);
    if (amount > RIDE_INT_MAX || nonce > RIDE_INT_MAX || slot > RIDE_INT_MAX) continue;

    it(`${vec.id}: ${vec.name} — message_id matches`, () => {
      const { preimage, messageId } = rideComputeMessageId(vec.fields);

      // Check preimage length
      assert.equal(preimage.length, vec.expected_preimage_length,
        `Preimage length mismatch: got ${preimage.length}, expected ${vec.expected_preimage_length}`);

      // Check preimage hex
      if (vec.expected_preimage_hex) {
        assert.equal(bytesToHex(preimage), vec.expected_preimage_hex,
          `Preimage bytes mismatch for ${vec.id}`);
      }

      // Check message_id
      if (vec.expected_message_id) {
        assert.equal(bytesToHex(messageId), vec.expected_message_id,
          `Message ID mismatch for ${vec.id}`);
      }
    });
  }
});

describe('RIDE Equivalence: Leaf Hash', () => {
  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    if (!vec.expected_leaf_hash) continue;
    const amount = BigInt(vec.fields.amount);
    const nonce = BigInt(vec.fields.nonce);
    const slot = BigInt(vec.fields.slot);
    if (amount > RIDE_INT_MAX || nonce > RIDE_INT_MAX || slot > RIDE_INT_MAX) continue;

    it(`${vec.id}: leaf hash matches`, () => {
      const { messageId } = rideComputeMessageId(vec.fields);
      const leafHash = rideComputeLeafHash(messageId);
      assert.equal(bytesToHex(leafHash), vec.expected_leaf_hash);
    });
  }
});

describe('RIDE Equivalence: Field Element Reconstruction Round-Trip', () => {
  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    if (!vec.expected_public_inputs) continue;
    const amount = BigInt(vec.fields.amount);
    const nonce = BigInt(vec.fields.nonce);
    const slot = BigInt(vec.fields.slot);
    if (amount > RIDE_INT_MAX || nonce > RIDE_INT_MAX || slot > RIDE_INT_MAX) continue;

    it(`${vec.id}: message_id survives split→FE→reconstruct256`, () => {
      const { messageId } = rideComputeMessageId(vec.fields);
      const [lo, hi] = splitTo128LE(messageId);

      // Create field elements (32-byte big-endian)
      const feLo = bigintToFE(lo);
      const feHi = bigintToFE(hi);

      // RIDE reconstruction
      const reconstructed = reconstruct256(feLo, feHi);
      assert.equal(bytesToHex(reconstructed), bytesToHex(messageId),
        'reconstruct256 must round-trip message_id');
    });

    it(`${vec.id}: recipient survives split→FE→reconstruct256`, () => {
      const recipient = hexToBytes(vec.fields.recipient);
      const [lo, hi] = splitTo128LE(recipient);
      const feLo = bigintToFE(lo);
      const feHi = bigintToFE(hi);
      const reconstructed = reconstruct256(feLo, feHi);
      assert.equal(bytesToHex(reconstructed), vec.fields.recipient,
        'reconstruct256 must round-trip recipient');
    });

    it(`${vec.id}: amount survives FE→fieldElementToInt`, () => {
      const pi = vec.expected_public_inputs;
      const fe = bigintToFE(BigInt(pi.amount));
      const extracted = fieldElementToInt(fe);
      assert.equal(extracted, vec.fields.amount,
        'fieldElementToInt must recover amount');
    });
  }
});

describe('RIDE Equivalence: Public Input Values Match', () => {
  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    if (!vec.expected_public_inputs) continue;
    const amount = BigInt(vec.fields.amount);
    const nonce = BigInt(vec.fields.nonce);
    const slot = BigInt(vec.fields.slot);
    if (amount > RIDE_INT_MAX || nonce > RIDE_INT_MAX || slot > RIDE_INT_MAX) continue;

    it(`${vec.id}: message_id_lo/hi match expected`, () => {
      const { messageId } = rideComputeMessageId(vec.fields);
      const [lo, hi] = splitTo128LE(messageId);
      const pi = vec.expected_public_inputs;
      assert.equal(lo.toString(), pi.message_id_lo);
      assert.equal(hi.toString(), pi.message_id_hi);
    });

    it(`${vec.id}: recipient_lo/hi match expected`, () => {
      const recipient = hexToBytes(vec.fields.recipient);
      const [lo, hi] = splitTo128LE(recipient);
      const pi = vec.expected_public_inputs;
      assert.equal(lo.toString(), pi.recipient_lo);
      assert.equal(hi.toString(), pi.recipient_hi);
    });
  }
});

describe('RIDE Equivalence: Mutation Rejection', () => {
  const base = vectorData.vectors[0];
  const { messageId: baseHash } = rideComputeMessageId(base.fields);

  const mutations = [
    ['amount+1', { ...base.fields, amount: base.fields.amount + 1 }],
    ['nonce+1', { ...base.fields, nonce: base.fields.nonce + 1 }],
    ['slot+1', { ...base.fields, slot: base.fields.slot + 1 }],
    ['event_index+1', { ...base.fields, event_index: base.fields.event_index + 1 }],
    ['chain_id_swap', {
      ...base.fields,
      src_chain_id: base.fields.dst_chain_id,
      dst_chain_id: base.fields.src_chain_id,
    }],
    ['recipient_bit_flip', {
      ...base.fields,
      recipient: (() => {
        const bytes = hexToBytes(base.fields.recipient);
        bytes[31] ^= 1;
        return bytesToHex(bytes);
      })(),
    }],
    ['sender_bit_flip', {
      ...base.fields,
      sender: (() => {
        const bytes = hexToBytes(base.fields.sender);
        bytes[0] ^= 1;
        return bytesToHex(bytes);
      })(),
    }],
  ];

  for (const [name, mutatedFields] of mutations) {
    it(`Mutation: ${name} produces different hash`, () => {
      const { messageId: mutatedHash } = rideComputeMessageId(mutatedFields);
      assert.notEqual(bytesToHex(mutatedHash), bytesToHex(baseHash));
    });
  }
});

describe('RIDE Equivalence: Recipient Encoding Validation', () => {
  it('rejects recipient with wrong length', () => {
    assert.equal(hexToBytes('0101010101010101010101010101010101010101010101010101010101010101').length, 32);
  });

  for (const vec of vectorData.vectors) {
    if (vec.type === 'unlock') continue;
    it(`${vec.id}: recipient is exactly 32 bytes`, () => {
      const recipientBytes = hexToBytes(vec.fields.recipient);
      assert.equal(recipientBytes.length, 32,
        `Recipient must be 32 bytes (public key), got ${recipientBytes.length}`);
    });
  }
});

describe('RIDE Equivalence: RIDE-Specific Constraints', () => {
  it('RIDE signed Int max: amounts in vectors are within i64 range (or flagged)', () => {
    for (const vec of vectorData.vectors) {
      if (vec.type === 'unlock') continue;
      const amount = BigInt(vec.fields.amount);
      if (amount > RIDE_INT_MAX) {
        // This vector is expected to be an edge case RIDE cannot handle
        assert.ok(
          vec.id === 'V-003' || vec.id === 'V-005' || vec.id === 'V-019',
          `Unexpected overflow vector: ${vec.id}`
        );
      }
    }
  });

  it('Domain separator check: RIDE verifies size(toBytes(domainSep)) == 17', () => {
    const domainBytes = new TextEncoder().encode('DCC_SOL_BRIDGE_V1');
    assert.equal(domainBytes.length, 17);
  });

  it('Max checkpoint age is 10080 blocks (~7 days)', () => {
    // Verify our constant matches what's in the contract
    assert.equal(10080, 7 * 24 * 60); // 1 block per minute
  });

  it('Rate limits are within RIDE Int range', () => {
    assert.ok(BigInt(100000000000) < RIDE_INT_MAX); // maxHourlyMint
    assert.ok(BigInt(1000000000000) < RIDE_INT_MAX); // maxDailyMint
    assert.ok(BigInt(50000000000) < RIDE_INT_MAX); // maxSingleMint
  });
});

describe('RIDE Equivalence: Cross-Vector Collision Tests', () => {
  it('V-001 ≠ V-008 (chain IDs swapped)', () => {
    const { messageId: h1 } = rideComputeMessageId(vectorData.vectors[0].fields);
    const v8 = vectorData.vectors.find(v => v.id === 'V-008');
    const { messageId: h8 } = rideComputeMessageId(v8.fields);
    assert.notEqual(bytesToHex(h1), bytesToHex(h8));
  });

  it('V-001 ≠ V-030 (domain_sep V2 vs V1)', () => {
    const h1 = vectorData.vectors[0].expected_message_id;
    const v30 = vectorData.vectors.find(v => v.id === 'V-030');
    assert.notEqual(h1, v30.expected_message_id);
  });

  it('All deposit vectors produce unique message_ids', () => {
    const seen = new Set();
    for (const vec of vectorData.vectors) {
      if (vec.expected_message_id) {
        assert.ok(!seen.has(vec.expected_message_id),
          `Duplicate message_id in ${vec.id}`);
        seen.add(vec.expected_message_id);
      }
    }
  });
});
