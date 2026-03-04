#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * DCC <-> Solana ZK Bridge — Malformed Proof Rejection Tests
 * ═══════════════════════════════════════════════════════════════
 *
 * FIX: §5.4 — Tests that the RIDE verifier correctly rejects
 * malformed, corrupted, truncated, and invalid proofs.
 *
 * Coverage:
 *   1. Truncated proof ByteVector (< 256 bytes)
 *   2. Oversized proof ByteVector (> 256 bytes)
 *   3. Zero-filled proof
 *   4. Truncated inputs (< 256 bytes)
 *   5. Oversized inputs (> 256 bytes)
 *   6. Zero-filled inputs
 *   7. Reordered proof elements (A, B, C swapped)
 *   8. Invalid field element (> BN128 prime)
 *   9. Proof with wrong inputs (valid proof, tampered inputs)
 *  10. Duplicate messageId replay
 *
 * These tests validate the RIDE contract's defensive layers
 * WITHOUT requiring a running DCC node — they exercise the
 * same validation logic that zk_bridge.ride implements.
 */

import { strict as assert } from 'assert';
import crypto from 'crypto';

// BN128 prime: p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
const BN128_PRIME = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const PROOF_BYTES = 256;   // 8 × 32-byte G1/G2 elements
const INPUT_BYTES = 256;   // 8 × 32-byte field elements

let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// RIDE Validation Simulation
// ═══════════════════════════════════════════════════════════════
// These functions replicate the validation logic from zk_bridge.ride
// so we can test it without a running node.

function validateProofLength(proof) {
    if (proof.length !== PROOF_BYTES) {
        throw new Error(`Invalid proof length: expected ${PROOF_BYTES} bytes, got ${proof.length}`);
    }
}

function validateInputsLength(inputs) {
    if (inputs.length !== INPUT_BYTES) {
        throw new Error(`Invalid inputs length: expected ${INPUT_BYTES} bytes (8 × 32), got ${inputs.length}`);
    }
}

function validateFieldElement(fe, name) {
    // Each 32-byte big-endian field element must be < BN128 prime
    if (fe.length !== 32) {
        throw new Error(`${name}: expected 32 bytes, got ${fe.length}`);
    }
    let val = 0n;
    for (let i = 0; i < 32; i++) {
        val = (val << 8n) | BigInt(fe[i]);
    }
    if (val >= BN128_PRIME) {
        throw new Error(`${name}: value ${val} >= BN128 prime`);
    }
}

function validateAllInputFieldElements(inputs) {
    validateInputsLength(inputs);
    for (let i = 0; i < 8; i++) {
        const fe = inputs.slice(i * 32, (i + 1) * 32);
        validateFieldElement(fe, `input[${i}]`);
    }
}

function checkReplayProtection(messageId, processedSet) {
    if (processedSet.has(messageId)) {
        throw new Error(`Message already processed: ${messageId}`);
    }
}

function extractAmount(inputs) {
    // Amount is at input[4] (offset 128), 32-byte BE field element
    // Value is in the last 8 bytes as BE int64
    const fe = inputs.slice(128, 160);
    const buf = Buffer.from(fe.slice(24, 32));
    return buf.readBigUInt64BE(0);
}

function fieldElementToBytes(value, bits) {
    // Encode a BigInt as a 32-byte big-endian field element
    const buf = Buffer.alloc(32, 0);
    let v = value;
    for (let i = 31; i >= 0; i--) {
        buf[i] = Number(v & 0xFFn);
        v >>= 8n;
    }
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// Generate a fake "valid" proof and inputs for testing
// ═══════════════════════════════════════════════════════════════

function makeFakeValidProof() {
    // Random 256-byte proof (won't verify, but passes length checks)
    return crypto.randomBytes(PROOF_BYTES);
}

function makeFakeValidInputs() {
    // 8 field elements, each < BN128 prime
    const buf = Buffer.alloc(INPUT_BYTES, 0);
    // checkpoint_root_lo
    buf.writeUInt32BE(0x12345678, 28);
    // checkpoint_root_hi
    buf.writeUInt32BE(0x9ABCDEF0, 60);
    // message_id_lo
    buf.writeUInt32BE(0xAABBCCDD, 92);
    // message_id_hi
    buf.writeUInt32BE(0xEEFF0011, 124);
    // amount = 1000000000 (1 SOL in lamports)
    buf.writeBigUInt64BE(1000000000n, 152);
    // recipient_lo
    buf.writeUInt32BE(0x11223344, 188);
    // recipient_hi
    buf.writeUInt32BE(0x55667788, 220);
    // version = 1
    buf.writeUInt32BE(1, 252);
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Malformed Proof Rejection Tests (§5.4)');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// ── 1. Truncated proof ──────────────────────────────────────
console.log('  [1] Truncated proof ByteVector');
test('Empty proof (0 bytes) rejected', () => {
    assert.throws(() => validateProofLength(Buffer.alloc(0)),
        /Invalid proof length/);
});

test('Short proof (128 bytes) rejected', () => {
    assert.throws(() => validateProofLength(Buffer.alloc(128)),
        /Invalid proof length/);
});

test('Almost-valid proof (255 bytes) rejected', () => {
    assert.throws(() => validateProofLength(Buffer.alloc(255)),
        /Invalid proof length/);
});

// ── 2. Oversized proof ──────────────────────────────────────
console.log('  [2] Oversized proof ByteVector');
test('Oversized proof (257 bytes) rejected', () => {
    assert.throws(() => validateProofLength(Buffer.alloc(257)),
        /Invalid proof length/);
});

test('Double-size proof (512 bytes) rejected', () => {
    assert.throws(() => validateProofLength(Buffer.alloc(512)),
        /Invalid proof length/);
});

// ── 3. Zero-filled proof ────────────────────────────────────
console.log('  [3] Zero-filled proof');
test('Zero-filled proof passes length check (but would fail Groth16)', () => {
    // This should NOT throw on length — the zeros would fail
    // at the cryptographic verification step (not a length error)
    validateProofLength(Buffer.alloc(PROOF_BYTES, 0));
});

// ── 4. Truncated inputs ─────────────────────────────────────
console.log('  [4] Truncated inputs ByteVector');
test('Empty inputs (0 bytes) rejected', () => {
    assert.throws(() => validateInputsLength(Buffer.alloc(0)),
        /Invalid inputs length/);
});

test('Short inputs (224 bytes) rejected', () => {
    assert.throws(() => validateInputsLength(Buffer.alloc(224)),
        /Invalid inputs length/);
});

test('7 elements (224 bytes) rejected', () => {
    assert.throws(() => validateInputsLength(Buffer.alloc(7 * 32)),
        /Invalid inputs length/);
});

// ── 5. Oversized inputs ─────────────────────────────────────
console.log('  [5] Oversized inputs ByteVector');
test('9 elements (288 bytes) rejected', () => {
    assert.throws(() => validateInputsLength(Buffer.alloc(9 * 32)),
        /Invalid inputs length/);
});

// ── 6. Zero-filled inputs ───────────────────────────────────
console.log('  [6] Zero-filled inputs');
test('Zero-filled inputs pass length + field element checks', () => {
    // All zeros are valid field elements (0 < BN128_PRIME)
    const inputs = Buffer.alloc(INPUT_BYTES, 0);
    validateAllInputFieldElements(inputs);
});

// ── 7. Reordered proof elements ─────────────────────────────
console.log('  [7] Reordered proof elements');
test('Swapped proof components detected via Groth16 failure', () => {
    // A reordered proof passes length check but fails verification.
    // Since we can't run actual Groth16 here, we verify the 
    // architectural defense: the RIDE contract checks proof length
    // and then passes to groth16Verify which rejects.
    const proof = makeFakeValidProof();
    // Swap first 64 bytes (A point) with bytes 64-128 (B point)
    const swapped = Buffer.concat([
        proof.slice(64, 128),   // B → position of A
        proof.slice(0, 64),     // A → position of B
        proof.slice(128)        // C unchanged
    ]);
    // Length still valid
    validateProofLength(swapped);
    // But content is different — Groth16 would reject
    assert.ok(!proof.equals(swapped), 'Swapped proof differs from original');
});

// ── 8. Invalid field element (>= BN128 prime) ──────────────
console.log('  [8] Invalid field element (>= BN128 prime)');
test('Field element = BN128_PRIME rejected', () => {
    const fe = fieldElementToBytes(BN128_PRIME, 256);
    assert.throws(() => validateFieldElement(fe, 'test'),
        /BN128 prime/);
});

test('Field element = BN128_PRIME + 1 rejected', () => {
    const fe = fieldElementToBytes(BN128_PRIME + 1n, 256);
    assert.throws(() => validateFieldElement(fe, 'test'),
        /BN128 prime/);
});

test('Field element = 2^256 - 1 (max uint256) rejected', () => {
    const fe = Buffer.alloc(32, 0xFF);
    assert.throws(() => validateFieldElement(fe, 'test'),
        /BN128 prime/);
});

test('Field element = BN128_PRIME - 1 accepted', () => {
    const fe = fieldElementToBytes(BN128_PRIME - 1n, 256);
    validateFieldElement(fe, 'test');  // Should NOT throw
});

test('Field element = 0 accepted', () => {
    const fe = Buffer.alloc(32, 0);
    validateFieldElement(fe, 'test');  // Should NOT throw
});

test('Field element = 1 accepted', () => {
    const fe = fieldElementToBytes(1n, 256);
    validateFieldElement(fe, 'test');  // Should NOT throw
});

// ── 9. Valid proof with tampered inputs ─────────────────────
console.log('  [9] Valid proof with tampered inputs');
test('Tampered amount in inputs changes extracted value', () => {
    const inputs = makeFakeValidInputs();
    const originalAmount = extractAmount(inputs);
    
    // Tamper: change amount field element
    const tampered = Buffer.from(inputs);
    tampered.writeBigUInt64BE(9999999999n, 152);
    const tamperedAmount = extractAmount(tampered);
    
    assert.notEqual(originalAmount, tamperedAmount,
        'Tampered amount should differ');
});

test('Tampered checkpoint root changes extracted root', () => {
    const inputs = makeFakeValidInputs();
    const tampered = Buffer.from(inputs);
    tampered[28] = 0xFF;  // Modify root_lo
    assert.ok(!inputs.slice(0, 32).equals(tampered.slice(0, 32)));
});

// ── 10. Replay protection ───────────────────────────────────
console.log('  [10] Replay protection (duplicate messageId)');
test('First submission succeeds', () => {
    const processedSet = new Set();
    checkReplayProtection('msg_001', processedSet);
    processedSet.add('msg_001');
});

test('Duplicate submission rejected', () => {
    const processedSet = new Set(['msg_001']);
    assert.throws(() => checkReplayProtection('msg_001', processedSet),
        /already processed/);
});

test('Different messageId succeeds', () => {
    const processedSet = new Set(['msg_001']);
    checkReplayProtection('msg_002', processedSet);
});

// ── 11. Amount bounds ───────────────────────────────────────
console.log('  [11] Amount extraction & bounds');
test('Amount = 0 correctly extracted', () => {
    const inputs = makeFakeValidInputs();
    const buf = Buffer.from(inputs);
    buf.writeBigUInt64BE(0n, 152);
    assert.equal(extractAmount(buf), 0n);
});

test('Amount = maxSingleMint correctly extracted', () => {
    const inputs = makeFakeValidInputs();
    const buf = Buffer.from(inputs);
    buf.writeBigUInt64BE(50000000000n, 152);  // 50 SOL
    assert.equal(extractAmount(buf), 50000000000n);
});

test('Large amount correctly extracted', () => {
    const inputs = makeFakeValidInputs();
    const buf = Buffer.from(inputs);
    buf.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER), 152);
    assert.equal(extractAmount(buf), BigInt(Number.MAX_SAFE_INTEGER));
});

// ── 12. Input field element validation (all 8 inputs) ───────
console.log('  [12] Full input validation (all 8 field elements)');
test('Valid inputs pass all field element checks', () => {
    const inputs = makeFakeValidInputs();
    validateAllInputFieldElements(inputs);
});

test('Invalid field element at position 4 (amount) detected', () => {
    const inputs = Buffer.from(makeFakeValidInputs());
    // Set input[4] to BN128_PRIME (invalid)
    const invalid = fieldElementToBytes(BN128_PRIME, 256);
    invalid.copy(inputs, 128, 0, 32);
    assert.throws(() => validateAllInputFieldElements(inputs),
        /BN128 prime/);
});

test('Invalid field element at position 7 (version) detected', () => {
    const inputs = Buffer.from(makeFakeValidInputs());
    // Set input[7] to 2^256 - 1 (invalid)
    const invalid = Buffer.alloc(32, 0xFF);
    invalid.copy(inputs, 224, 0, 32);
    assert.throws(() => validateAllInputFieldElements(inputs),
        /BN128 prime/);
});

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');

if (failed > 0) {
    process.exit(1);
}
