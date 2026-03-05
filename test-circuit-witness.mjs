/**
 * Minimal test: verify that the circom keccak256 output matches js-sha3
 *
 * We feed the circuit the known-good preimage bits and compare:
 * - What js-sha3 says the keccak256 hash is
 * - Whether the circuit accepts those field elements as message_id_lo/hi
 *
 * Uses witness calculator directly (no proving key needed) to be faster.
 */
import { readFileSync } from 'fs';
import jsSha3 from 'js-sha3';
const keccak256Fn = jsSha3.keccak256;

const WASM = './zk/circuits/build_test/bridge_deposit_js/bridge_deposit.wasm';

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToBitsLE(bytes) {
  const bits = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1));
    }
  }
  return bits;
}

function numberToBitsLE(value, numBits) {
  const bits = [];
  let v = BigInt(value);
  for (let i = 0; i < numBits; i++) {
    bits.push(Number(v & 1n));
    v >>= 1n;
  }
  return bits;
}

function hashToFieldElements(hash) {
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

// ═══════════════════════════════════════════════════
// Test 1: Simple keccak256 of known input
// ═══════════════════════════════════════════════════

// Standard test: keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
// But our circuit requires exactly 1448 bits. 

// Instead, test with our actual preimage: 181 bytes = 1448 bits
const preimageHex = '4443435f534f4c5f4252494447455f5631010000000200000085497cf2bcf0e42b9ef231b905e24dbb494527149cfc6e117464bed68392708c06e218180000000010000000e76c1116661b984f741745f96c0815af5a156d570b3c26d8abfcb0a09bd7065b013f86f3290bf5aa1cb387d5148eefc006c362f41ae66d8d75ea00000000000080969800000000000f000000000000000000000000000000000000000000000000000000000000000000000000000000';
const preimage = hexToBytes(preimageHex);
const hashHex = keccak256Fn(preimage);
const hashBytes = hexToBytes(hashHex);

console.log('Preimage (181 bytes):', preimageHex.substring(0, 40) + '...');
console.log('JS keccak256:', hashHex);

// Now let's manually trace what the circuit should see
// The circuit builds the preimage from inputs, then does keccak256 on the preimage bits
// The preimage bits should be: bytesToBitsLE(preimage)
const preimageBits = bytesToBitsLE(preimage);
console.log('Preimage bits length:', preimageBits.length, '(expected 1448)');

// The circuit's keccak should output 256 bits in LSBF byte order
// Which, when converted back to bytes, should give us hashBytes
const expectedOutputBits = bytesToBitsLE(hashBytes);
console.log('Expected keccak output bits (first 32):', expectedOutputBits.slice(0, 32).join(''));
console.log('Expected keccak output bits (last 32):', expectedOutputBits.slice(224, 256).join(''));

// Now: let's manually check the keccak padding for N=1448
// Rate = 1088. num_blocks = ceil((1448 + 2) / 1088) = ceil(1450/1088) = 2
// PADDED_LEN = 2 * 1088 = 2176
// Block 1: bits 0..1087, Block 2: bits 1088..2175
// In block 2: data bits 1088..1447 (360 bits), padding starts at 1448
// padded[1448] = 1, padded[1449..2174] = 0, padded[2175] = 1

// Let's verify: in standard keccak byte-level processing:
// 181 bytes / 136 bytes per block = 
//   Block 1: bytes 0..135 (136 bytes)
//   Block 2: bytes 136..180 (45 bytes) + padding
// Block 2 padding: byte 45 = 0x01, bytes 46..134 = 0x00, byte 135 = 0x80

// In bit terms for block 2 (rate = 1088 bits):
//   Data: 45 bytes = 360 bits  
//   bit 360 = 1 (0x01)
//   bits 361..367 = 0
//   bits 368..1079 = 0 
//   bits 1080..1086 = 0
//   bit 1087 = 1 (0x80 = bit7)

// In circuit terms for block 2 (padded[1088..2175]):
//   padded[1088..1447] = data (360 bits)
//   padded[1448] = 1 
//   padded[1449..2174] = 0
//   padded[2175] = 1

// These match! Offset 1448 = block 2 bit 360 ✓
// Offset 2175 = block 2 bit 1087 ✓

// Now let's check via snarkjs witness calculator
console.log('\n────── Testing with witness calculator ──────');

// Load witness calculator
const wasm = readFileSync(WASM);
const { default: builder } = await import('./zk/circuits/build/bridge_deposit_js/witness_calculator.js');
// witness_calculator.js might not be ESM-compatible, let's try require-style
const witnessCalcModule = await import('./zk/circuits/build/bridge_deposit_js/witness_calculator.js');

let wc;
if (witnessCalcModule.default) {
  wc = await witnessCalcModule.default(wasm);
} else if (typeof witnessCalcModule === 'function') {
  wc = await witnessCalcModule(wasm);
} else {
  // Try reading and evaluating
  const wcPath = './zk/circuits/build/bridge_deposit_js/witness_calculator.js';
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const WitnessCalculator = require(wcPath);
  wc = await WitnessCalculator(wasm);
}

// Build the circuit input with known-good values
const domainSep = preimage.slice(0, 17);
const srcChainId = preimage.slice(17, 21);
const dstChainId = preimage.slice(21, 25);
const srcProgramId = preimage.slice(25, 57);
const slot = preimage.slice(57, 65);
const eventIndex = preimage.slice(65, 69);
const sender = preimage.slice(69, 101);
const recipient = preimage.slice(101, 133);
const amount = preimage.slice(133, 141);
const nonce = preimage.slice(141, 149);
const assetId = preimage.slice(149, 181);

let slotVal = 0n;
for (let i = 7; i >= 0; i--) slotVal = (slotVal << 8n) | BigInt(slot[i]);
let eventIndexVal = 0;
for (let i = 3; i >= 0; i--) eventIndexVal = (eventIndexVal << 8) | eventIndex[i];
let amountVal = 0n;
for (let i = 7; i >= 0; i--) amountVal = (amountVal << 8n) | BigInt(amount[i]);
let nonceVal = 0n;
for (let i = 7; i >= 0; i--) nonceVal = (nonceVal << 8n) | BigInt(nonce[i]);

const msgIdFE = hashToFieldElements(hashBytes);
const recipFE = hashToFieldElements(recipient);

// Build Merkle tree
function keccak256Hash(data) {
  const h = keccak256Fn(data);
  return hexToBytes(h);
}

const leaf = keccak256Hash(new Uint8Array([0x00, ...hashBytes]));
const TREE_DEPTH = 20;
let current = leaf;
const siblings = [];
const pathIndices = [];

// Compute empty subtrees at each level
const emptySubtrees = new Array(TREE_DEPTH);
emptySubtrees[0] = keccak256Hash(new Uint8Array(32)); // empty leaf
for (let i = 1; i < TREE_DEPTH; i++) {
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(emptySubtrees[i - 1], 1);
  nodePreimage.set(emptySubtrees[i - 1], 33);
  emptySubtrees[i] = keccak256Hash(nodePreimage);
}

for (let i = 0; i < TREE_DEPTH; i++) {
  siblings.push(emptySubtrees[i]);
  pathIndices.push(0);

  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(current, 1);
  nodePreimage.set(emptySubtrees[i], 33);
  current = keccak256Hash(nodePreimage);
}

const merkleRoot = current;
const rootFE = hashToFieldElements(merkleRoot);

const circuitInput = {
  checkpoint_root_lo: rootFE.lo.toString(),
  checkpoint_root_hi: rootFE.hi.toString(),
  message_id_lo: msgIdFE.lo.toString(),
  message_id_hi: msgIdFE.hi.toString(),
  amount: amountVal.toString(),
  recipient_lo: recipFE.lo.toString(),
  recipient_hi: recipFE.hi.toString(),
  version: '1',

  domain_sep: bytesToBitsLE(domainSep).map(String),
  src_program_id: bytesToBitsLE(srcProgramId).map(String),
  slot_bits: numberToBitsLE(slotVal, 64).map(String),
  event_index_bits: numberToBitsLE(eventIndexVal, 32).map(String),
  sender: bytesToBitsLE(sender).map(String),
  nonce_bits: numberToBitsLE(nonceVal, 64).map(String),
  asset_id: bytesToBitsLE(assetId).map(String),
  src_chain_id: numberToBitsLE(1, 32).map(String),
  dst_chain_id: numberToBitsLE(2, 32).map(String),
  siblings: siblings.map(s => bytesToBitsLE(s).map(String)),
  path_indices: pathIndices.map(String),
};

try {
  const witness = await wc.calculateWitness(circuitInput, true);
  console.log('✅ Witness calculated successfully!');
  console.log('Witness length:', witness.length);
  // Public signals are at indices 1..8
  console.log('Public signals:');
  for (let i = 1; i <= 8; i++) {
    console.log(`  [${i}]:`, witness[i].toString());
  }
} catch (err) {
  console.error('❌ Witness calculation failed:', err.message);
}
