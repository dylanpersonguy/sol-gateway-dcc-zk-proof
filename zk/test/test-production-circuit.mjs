/**
 * DCC <-> Solana ZK Bridge — Production Circuit Integration Test
 *
 * FIX: ATK-3 — Tests the ACTUAL production circuit (BridgeDepositInclusion(20))
 * instead of a toy circuit. This verifies:
 *
 *   1. Production circuit compiles successfully with circom
 *   2. R1CS is generated and has expected constraint count (~530K+)
 *   3. Trusted setup (Powers of Tau + Phase 2) succeeds
 *   4. Witness generation works with real bridge deposit data
 *   5. Groth16 proof generates from real circuit
 *   6. Proof verifies with correct public signals
 *   7. Tampered proofs are rejected
 *
 * Requirements:
 *   - circom 2.1.0+ (cargo install circom)
 *   - snarkjs 0.7.3+ (npm install snarkjs)
 *   - ~8GB RAM for compilation (TREE_DEPTH=20 Keccak circuit)
 *   - ~10-30 minutes for full pipeline
 *
 * Usage:
 *   node zk/test/test-production-circuit.mjs [--skip-compile] [--depth N]
 *
 * Options:
 *   --skip-compile   Skip circuit compilation (use existing artifacts)
 *   --depth N        Override tree depth (default 20; use 3 for quick smoke test)
 */

import { keccak256 } from 'ethers';
import * as snarkjs from 'snarkjs';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CIRCUITS_DIR = path.resolve(__dirname, '../circuits');

// ═══════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const skipCompile = args.includes('--skip-compile');
const depthIdx = args.indexOf('--depth');
const TREE_DEPTH = depthIdx >= 0 ? parseInt(args[depthIdx + 1], 10) : 20;

console.log(`\n${'═'.repeat(70)}`);
console.log(`  DCC <-> Solana ZK Bridge — Production Circuit Integration Test`);
console.log(`  FIX: ATK-3 — End-to-end production circuit verification`);
console.log(`  Tree depth: ${TREE_DEPTH} (${1 << TREE_DEPTH} leaves)`);
console.log(`${'═'.repeat(70)}\n`);

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS (matching zk/prover/src/message.ts)
// ═══════════════════════════════════════════════════════════

const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';
const SOL_CHAIN_ID = 1;
const DCC_CHAIN_ID = 2;
const BRIDGE_VERSION = 1;

function hexToBytes(hex) {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBitsLE(bytes) {
  const bits = [];
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
  }
  return bits;
}

function numberToBitsLE(value, width) {
  const v = BigInt(value);
  const bits = [];
  for (let i = 0; i < width; i++) {
    bits.push(Number((v >> BigInt(i)) & 1n));
  }
  return bits;
}

function bytesToLEBigInt(bytes) {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function writeU32LE(buf, value, offset) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function writeU64LE(buf, value, offset) {
  const v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
}

function computeMessageId(fields) {
  const preimage = new Uint8Array(181);
  let offset = 0;
  const domainBytes = new TextEncoder().encode(DOMAIN_SEP);
  preimage.set(domainBytes, offset); offset += 17;
  writeU32LE(preimage, fields.srcChainId, offset); offset += 4;
  writeU32LE(preimage, fields.dstChainId, offset); offset += 4;
  preimage.set(fields.srcProgramId, offset); offset += 32;
  writeU64LE(preimage, fields.slot, offset); offset += 8;
  writeU32LE(preimage, fields.eventIndex, offset); offset += 4;
  preimage.set(fields.sender, offset); offset += 32;
  preimage.set(fields.recipient, offset); offset += 32;
  writeU64LE(preimage, fields.amount, offset); offset += 8;
  writeU64LE(preimage, fields.nonce, offset); offset += 8;
  preimage.set(fields.assetId, offset); offset += 32;
  return hexToBytes(keccak256(preimage));
}

// Domain-separated hashing (ZK-M3 fix)
function computeLeaf(messageId) {
  const prefixed = new Uint8Array(1 + messageId.length);
  prefixed[0] = 0x00;
  prefixed.set(messageId, 1);
  return hexToBytes(keccak256(prefixed));
}

function computeEmptyLeaf() {
  const prefixed = new Uint8Array(33);
  prefixed[0] = 0x00;
  return hexToBytes(keccak256(prefixed));
}

function hashPair(left, right) {
  const combined = new Uint8Array(65);
  combined[0] = 0x01;
  combined.set(left, 1);
  combined.set(right, 33);
  return hexToBytes(keccak256(combined));
}

// ═══════════════════════════════════════════════════════════
// MERKLE TREE
// ═══════════════════════════════════════════════════════════

class MerkleTree {
  constructor(depth) {
    this.depth = depth;
    this.emptyLeaf = computeEmptyLeaf();
    this.layers = [];
    this._emptyHashes = null;
  }

  getEmptyHashes() {
    if (this._emptyHashes) return this._emptyHashes;
    this._emptyHashes = new Array(this.depth + 1);
    this._emptyHashes[0] = this.emptyLeaf;
    for (let i = 1; i <= this.depth; i++) {
      this._emptyHashes[i] = hashPair(this._emptyHashes[i - 1], this._emptyHashes[i - 1]);
    }
    return this._emptyHashes;
  }

  buildFromMessageIds(messageIds) {
    const maxLeaves = 1 << this.depth;
    if (messageIds.length > maxLeaves) throw new Error(`Too many leaves`);
    const emptyHashes = this.getEmptyHashes();

    this.layers = new Array(this.depth + 1);
    this.layers[0] = new Array(maxLeaves);

    for (let i = 0; i < messageIds.length; i++) {
      this.layers[0][i] = computeLeaf(messageIds[i]);
    }
    for (let i = messageIds.length; i < maxLeaves; i++) {
      this.layers[0][i] = emptyHashes[0];
    }

    for (let level = 1; level <= this.depth; level++) {
      const prev = this.layers[level - 1];
      const size = prev.length / 2;
      this.layers[level] = new Array(size);
      for (let i = 0; i < size; i++) {
        this.layers[level][i] = hashPair(prev[2 * i], prev[2 * i + 1]);
      }
    }
  }

  getRoot() { return this.layers[this.depth][0]; }

  getProof(leafIndex) {
    const siblings = [];
    const pathIndices = [];
    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      pathIndices.push(isRight ? 1 : 0);
      siblings.push(this.layers[level][siblingIndex]);
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { leaf: this.layers[0][leafIndex], siblings, pathIndices, root: this.getRoot() };
  }
}

// ═══════════════════════════════════════════════════════════
// BUILD CIRCUIT INPUT (matching prover.ts buildCircuitInput)
// ═══════════════════════════════════════════════════════════

function buildCircuitInput(fields, proof, root, messageId) {
  const rootLo = bytesToLEBigInt(root.slice(0, 16));
  const rootHi = bytesToLEBigInt(root.slice(16, 32));
  const msgIdLo = bytesToLEBigInt(messageId.slice(0, 16));
  const msgIdHi = bytesToLEBigInt(messageId.slice(16, 32));
  const recipLo = bytesToLEBigInt(fields.recipient.slice(0, 16));
  const recipHi = bytesToLEBigInt(fields.recipient.slice(16, 32));

  return {
    // 8 public field-element inputs
    checkpoint_root_lo: rootLo.toString(),
    checkpoint_root_hi: rootHi.toString(),
    message_id_lo: msgIdLo.toString(),
    message_id_hi: msgIdHi.toString(),
    amount: fields.amount.toString(),
    recipient_lo: recipLo.toString(),
    recipient_hi: recipHi.toString(),
    version: BRIDGE_VERSION.toString(),

    // Private inputs (bit arrays)
    domain_sep: bytesToBitsLE(new TextEncoder().encode(DOMAIN_SEP)),
    src_program_id: bytesToBitsLE(fields.srcProgramId),
    slot_bits: numberToBitsLE(fields.slot, 64),
    event_index_bits: numberToBitsLE(fields.eventIndex, 32),
    sender: bytesToBitsLE(fields.sender),
    nonce_bits: numberToBitsLE(fields.nonce, 64),
    asset_id: bytesToBitsLE(fields.assetId),
    src_chain_id: numberToBitsLE(fields.srcChainId, 32),
    dst_chain_id: numberToBitsLE(fields.dstChainId, 32),
    siblings: proof.siblings.map(s => bytesToBitsLE(s)),
    path_indices: proof.pathIndices,
  };
}

// ═══════════════════════════════════════════════════════════
// TEST FRAMEWORK
// ═══════════════════════════════════════════════════════════

let passed = 0, failed = 0, total = 0;

function assert(condition, message) {
  total++;
  if (condition) { passed++; console.log(`  ✅ ${message}`); }
  else { failed++; console.log(`  ❌ FAIL: ${message}`); }
}

function section(title) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(70)}`);
}

// ═══════════════════════════════════════════════════════════
// MAIN TEST PIPELINE
// ═══════════════════════════════════════════════════════════

async function main() {
  const BUILD_DIR = path.join(__dirname, 'build', `production_depth${TREE_DEPTH}`);
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // ── Create a parameterized circuit for the specified depth ──
  // We generate a wrapper that imports the real circuit files
  section(`Step 1: Circuit Preparation (depth=${TREE_DEPTH})`);

  const circuitWrapper = `pragma circom 2.1.0;

include "../../circuits/keccak256.circom";
include "../../circuits/merkle_tree.circom";
include "../../circuits/bridge_deposit.circom";

// Production circuit at specified depth
// Uses the REAL BridgeDepositInclusion template
component main {public [
    checkpoint_root_lo,
    checkpoint_root_hi,
    message_id_lo,
    message_id_hi,
    amount,
    recipient_lo,
    recipient_hi,
    version
]} = BridgeDepositInclusion(${TREE_DEPTH});
`;
  const circuitPath = path.join(BUILD_DIR, `bridge_deposit_d${TREE_DEPTH}.circom`);
  fs.writeFileSync(circuitPath, circuitWrapper);
  console.log(`  Circuit wrapper written: bridge_deposit_d${TREE_DEPTH}.circom`);

  // ── Step 2: Compile ──
  if (!skipCompile) {
    section(`Step 2: Compiling Production Circuit (depth=${TREE_DEPTH})`);
    console.log(`  This may take several minutes for larger depths...`);
    console.log(`  Memory note: depth=20 requires ~8GB RAM\n`);

    const startCompile = Date.now();
    try {
      execSync(
        `circom "${circuitPath}" --r1cs --wasm --sym -o "${BUILD_DIR}" -l "${CIRCUITS_DIR}/node_modules" 2>&1`,
        { stdio: 'pipe', timeout: 3600000, maxBuffer: 50 * 1024 * 1024 }
      );
      const compileTime = ((Date.now() - startCompile) / 1000).toFixed(1);
      console.log(`  ✅ Compilation successful (${compileTime}s)`);
    } catch (e) {
      const stderr = e.stderr?.toString() || e.message;
      console.error(`  ❌ Compilation failed after ${((Date.now() - startCompile) / 1000).toFixed(1)}s`);
      console.error(`  ${stderr.substring(0, 2000)}`);
      console.error(`\n  Tip: For quick smoke test, use: --depth 3`);
      process.exit(1);
    }

    // Print circuit info
    const circuitName = `bridge_deposit_d${TREE_DEPTH}`;
    const r1csPath = path.join(BUILD_DIR, `${circuitName}.r1cs`);
    try {
      const info = execSync(`snarkjs r1cs info "${r1csPath}" 2>&1`).toString().trim();
      console.log(`\n  ${info.split('\n').join('\n  ')}`);
      
      // Extract constraint count for validation
      const constraintMatch = info.match(/Constraints:\s*(\d+)/i);
      if (constraintMatch) {
        const constraints = parseInt(constraintMatch[1], 10);
        assert(constraints > 1000, `Circuit has ${constraints.toLocaleString()} constraints (> 1000)`);
        if (TREE_DEPTH >= 20) {
          assert(constraints > 400000, `Production circuit has ${constraints.toLocaleString()} constraints (> 400K)`);
        }
      }
    } catch (e) {
      console.log(`  Could not get circuit info: ${e.message}`);
    }
  } else {
    section('Step 2: Skipping compilation (--skip-compile)');
  }

  // ── Step 3: Trusted Setup ──
  section('Step 3: Trusted Setup (Phase 1 + Phase 2)');
  
  const circuitName = `bridge_deposit_d${TREE_DEPTH}`;
  const r1csPath = path.join(BUILD_DIR, `${circuitName}.r1cs`);
  const wasmDir = path.join(BUILD_DIR, `${circuitName}_js`);
  const wasmPath = path.join(wasmDir, `${circuitName}.wasm`);

  if (!fs.existsSync(r1csPath)) {
    console.error(`  ❌ R1CS not found: ${r1csPath}`);
    console.error(`  Run without --skip-compile first.`);
    process.exit(1);
  }

  // Phase 1: Small Powers of Tau (ptau power based on circuit size)
  const ptauPower = TREE_DEPTH <= 3 ? 12 : (TREE_DEPTH <= 10 ? 18 : 22);
  const ptauPath0 = path.join(BUILD_DIR, `pot${ptauPower}_0.ptau`);
  const ptauPath1 = path.join(BUILD_DIR, `pot${ptauPower}_1.ptau`);
  const ptauFinal = path.join(BUILD_DIR, `pot${ptauPower}_final.ptau`);

  if (!fs.existsSync(ptauFinal)) {
    console.log(`  Generating Powers of Tau (2^${ptauPower})...`);
    execSync(`snarkjs powersoftau new bn128 ${ptauPower} "${ptauPath0}" -v 2>&1`, { stdio: 'pipe', timeout: 600000 });
    execSync(`snarkjs powersoftau contribute "${ptauPath0}" "${ptauPath1}" --name="Test" -v -e="test-entropy-${Date.now()}" 2>&1`, { stdio: 'pipe', timeout: 600000 });
    execSync(`snarkjs powersoftau prepare phase2 "${ptauPath1}" "${ptauFinal}" -v 2>&1`, { stdio: 'pipe', timeout: 600000 });
    console.log(`  ✅ Powers of Tau complete`);
  } else {
    console.log(`  ✅ Reusing existing Powers of Tau`);
  }

  // Phase 2: Circuit-specific setup
  const zkey0 = path.join(BUILD_DIR, `${circuitName}_0.zkey`);
  const zkeyFinal = path.join(BUILD_DIR, `${circuitName}_final.zkey`);
  const vkeyPath = path.join(BUILD_DIR, 'verification_key.json');

  console.log(`  Running Phase 2 setup...`);
  const startSetup = Date.now();
  execSync(`snarkjs groth16 setup "${r1csPath}" "${ptauFinal}" "${zkey0}" 2>&1`, { stdio: 'pipe', timeout: 3600000 });
  execSync(`snarkjs zkey contribute "${zkey0}" "${zkeyFinal}" --name="Test Phase 2" -v -e="phase2-${Date.now()}" 2>&1`, { stdio: 'pipe', timeout: 3600000 });
  execSync(`snarkjs zkey export verificationkey "${zkeyFinal}" "${vkeyPath}" 2>&1`, { stdio: 'pipe', timeout: 300000 });
  const setupTime = ((Date.now() - startSetup) / 1000).toFixed(1);
  console.log(`  ✅ Phase 2 setup complete (${setupTime}s)`);

  assert(fs.existsSync(zkeyFinal), 'Proving key (zkey) generated');
  assert(fs.existsSync(vkeyPath), 'Verification key (vkey) generated');

  // ── Step 4: Build Witness (Real Deposit Data) ──
  section('Step 4: Witness Generation (Real Bridge Deposit)');

  const fields = {
    srcChainId: SOL_CHAIN_ID,
    dstChainId: DCC_CHAIN_ID,
    srcProgramId: hexToBytes('82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302'),
    slot: 50000n,
    eventIndex: 3,
    sender: hexToBytes('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'),
    recipient: hexToBytes('1111111111111111111111111111111111111111111111111111111111111111'),
    amount: 5000000000n,
    nonce: 7n,
    assetId: hexToBytes('069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001'),
  };

  const messageId = computeMessageId(fields);
  console.log(`  Message ID: ${bytesToHex(messageId)}`);

  // Build tree
  const allIds = [];
  for (let i = 0; i < 5; i++) {
    if (i === 2) {
      allIds.push(messageId);
    } else {
      const fake = new Uint8Array(32);
      fake[0] = 0xaa; fake[1] = i;
      allIds.push(fake);
    }
  }

  const tree = new MerkleTree(TREE_DEPTH);
  tree.buildFromMessageIds(allIds);
  const proof = tree.getProof(2);
  const root = tree.getRoot();

  console.log(`  Root:       ${bytesToHex(root)}`);
  console.log(`  Leaf idx:   2`);
  console.log(`  Proof size: ${proof.siblings.length} siblings`);

  // Build circuit input
  const circuitInput = buildCircuitInput(fields, proof, root, messageId);

  // Validate dimensions
  assert(circuitInput.domain_sep.length === 136, 'domain_sep: 136 bits');
  assert(circuitInput.siblings.length === TREE_DEPTH, `siblings: ${TREE_DEPTH} arrays`);
  assert(BigInt(circuitInput.checkpoint_root_lo) < (1n << 128n), 'root_lo < 2^128');
  assert(BigInt(circuitInput.checkpoint_root_hi) < (1n << 128n), 'root_hi < 2^128');
  assert(circuitInput.version === '1', 'version = 1');

  // Write input for witness generator
  const inputPath = path.join(BUILD_DIR, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(circuitInput));

  // ── Step 5: Generate Witness ──
  section('Step 5: Witness Calculation');

  const witnessPath = path.join(BUILD_DIR, 'witness.wtns');
  const startWitness = Date.now();
  try {
    await snarkjs.wtns.calculate(circuitInput, wasmPath, witnessPath);
    const witnessTime = ((Date.now() - startWitness) / 1000).toFixed(1);
    console.log(`  ✅ Witness generated (${witnessTime}s)`);
    assert(true, 'Witness generation succeeded');
  } catch (e) {
    console.error(`  ❌ Witness generation FAILED: ${e.message}`);
    assert(false, 'Witness generation succeeded');
    process.exit(1);
  }

  // ── Step 6: Generate Proof ──
  section('Step 6: Groth16 Proof Generation');

  const startProof = Date.now();
  const { proof: zkProof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput, wasmPath, zkeyFinal
  );
  const proofTime = ((Date.now() - startProof) / 1000).toFixed(1);
  console.log(`  ✅ Proof generated (${proofTime}s)`);
  console.log(`  Protocol: ${zkProof.protocol}`);
  console.log(`  Curve: ${zkProof.curve}`);
  console.log(`  Public signals: ${publicSignals.length}`);

  assert(zkProof.protocol === 'groth16', 'Protocol is groth16');
  assert(zkProof.curve === 'bn128', 'Curve is bn128');
  assert(publicSignals.length === 8, 'Exactly 8 public signals (matches groth16Verify_8inputs)');

  // Verify public signals match our inputs
  assert(publicSignals[0] === circuitInput.checkpoint_root_lo, 'Signal[0] = checkpoint_root_lo');
  assert(publicSignals[1] === circuitInput.checkpoint_root_hi, 'Signal[1] = checkpoint_root_hi');
  assert(publicSignals[2] === circuitInput.message_id_lo, 'Signal[2] = message_id_lo');
  assert(publicSignals[3] === circuitInput.message_id_hi, 'Signal[3] = message_id_hi');
  assert(publicSignals[4] === fields.amount.toString(), 'Signal[4] = amount');
  assert(publicSignals[5] === circuitInput.recipient_lo, 'Signal[5] = recipient_lo');
  assert(publicSignals[6] === circuitInput.recipient_hi, 'Signal[6] = recipient_hi');
  assert(publicSignals[7] === '1', 'Signal[7] = version (1)');

  // ── Step 7: Verify Proof ──
  section('Step 7: Proof Verification');

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
  
  // VK should have IC array of length 9 (8 public inputs + 1 constant)
  assert(vkey.IC.length === 9, `VK IC array has 9 entries (8 inputs + 1 constant)`);

  const isValid = await snarkjs.groth16.verify(vkey, publicSignals, zkProof);
  assert(isValid === true, '🔒 VALID PROOF — Groth16 verification PASSED on production circuit!');

  // ── Step 8: Tamper Tests ──
  section('Step 8: Tamper Resistance Tests');

  // Tamper 1: Wrong checkpoint root (lo)
  const bad1 = [...publicSignals]; bad1[0] = '999';
  assert((await snarkjs.groth16.verify(vkey, bad1, zkProof)) === false, 'Tampered root_lo → REJECTED');

  // Tamper 2: Wrong checkpoint root (hi)
  const bad2 = [...publicSignals]; bad2[1] = '999';
  assert((await snarkjs.groth16.verify(vkey, bad2, zkProof)) === false, 'Tampered root_hi → REJECTED');

  // Tamper 3: Wrong message_id (lo)
  const bad3 = [...publicSignals]; bad3[2] = '999';
  assert((await snarkjs.groth16.verify(vkey, bad3, zkProof)) === false, 'Tampered msgid_lo → REJECTED');

  // Tamper 4: Wrong amount
  const bad4 = [...publicSignals]; bad4[4] = '9999999999';
  assert((await snarkjs.groth16.verify(vkey, bad4, zkProof)) === false, 'Tampered amount → REJECTED');

  // Tamper 5: Wrong recipient (lo)
  const bad5 = [...publicSignals]; bad5[5] = '999';
  assert((await snarkjs.groth16.verify(vkey, bad5, zkProof)) === false, 'Tampered recipient_lo → REJECTED');

  // Tamper 6: Wrong version
  const bad6 = [...publicSignals]; bad6[7] = '2';
  assert((await snarkjs.groth16.verify(vkey, bad6, zkProof)) === false, 'Tampered version → REJECTED');

  // Tamper 7: Mutated proof point
  const badProof = JSON.parse(JSON.stringify(zkProof));
  badProof.pi_a[0] = '12345678901234567890';
  assert((await snarkjs.groth16.verify(vkey, publicSignals, badProof)) === false, 'Mutated pi_a → REJECTED');

  // Save artifacts
  fs.writeFileSync(path.join(BUILD_DIR, 'proof.json'), JSON.stringify(zkProof, null, 2));
  fs.writeFileSync(path.join(BUILD_DIR, 'public.json'), JSON.stringify(publicSignals, null, 2));

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════
  section('TEST SUMMARY');
  console.log(`\n  Total:  ${total}`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${failed} ❌`);

  if (failed === 0) {
    console.log(`\n  🎉 ALL TESTS PASSED — Production circuit verified end-to-end!`);
    console.log(`  ATK-3 (No Production Circuit) is RESOLVED.\n`);
  } else {
    console.log(`\n  ⚠️  ${failed} test(s) failed!\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
