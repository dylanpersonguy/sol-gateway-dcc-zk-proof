/**
 * Test: Does the circuit's keccak256 match js-sha3's keccak256
 * for the exact preimage from our failing deposit?
 *
 * We feed the circuit ONLY the public inputs (message_id_lo/hi)
 * derived from our known-good keccak hash, plus the private preimage bits.
 * If the circuit fails at line 238, the circuit's keccak disagrees.
 */
import * as snarkjs from 'snarkjs';
import jsSha3 from 'js-sha3';
const keccak256Fn = jsSha3.keccak256;

const WASM = './zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm';
const ZKEY = './zk/circuits/build/bridge_deposit_final.zkey';

// From diagnostic output:
const preimageHex = '4443435f534f4c5f4252494447455f5631010000000200000085497cf2bcf0e42b9ef231b905e24dbb494527149cfc6e117464bed68392708c06e218180000000010000000e76c1116661b984f741745f96c0815af5a156d570b3c26d8abfcb0a09bd7065b013f86f3290bf5aa1cb387d5148eefc006c362f41ae66d8d75ea00000000000080969800000000000f000000000000000000000000000000000000000000000000000000000000000000000000000000';
const expectedHash = '92227c2427221fd23ae98ac36c6db01d25472616539ed7695e343b9d4bbb2c77';

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToBitsLE(bytes) {
  const bits = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1).toString());
    }
  }
  return bits;
}

function numberToBitsLE(value, numBits) {
  const bits = [];
  let v = BigInt(value);
  for (let i = 0; i < numBits; i++) {
    bits.push((v & 1n).toString());
    v >>= 1n;
  }
  return bits;
}

function hashToFieldElements(hash) {
  // Little-endian interpretation
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

// Verify preimage
const preimage = hexToBytes(preimageHex);
console.log('Preimage length:', preimage.length, '(expected 181)');

const hash = keccak256Fn(preimage);
console.log('JS keccak256:', hash);
console.log('Expected:    ', expectedHash);
console.log('Match:', hash === expectedHash);

const hashBytes = hexToBytes(hash);
const msgIdFE = hashToFieldElements(hashBytes);
console.log('message_id_lo:', msgIdFE.lo.toString());
console.log('message_id_hi:', msgIdFE.hi.toString());

// Break down the preimage fields
const domainSep = preimage.slice(0, 17); // "DCC_SOL_BRIDGE_V1"
const srcChainId = preimage.slice(17, 21); // 1 LE
const dstChainId = preimage.slice(21, 25); // 2 LE
const srcProgramId = preimage.slice(25, 57); // 32 bytes
const slot = preimage.slice(57, 65); // 8 bytes LE
const eventIndex = preimage.slice(65, 69); // 4 bytes LE
const sender = preimage.slice(69, 101); // 32 bytes
const recipient = preimage.slice(101, 133); // 32 bytes
const amount = preimage.slice(133, 141); // 8 bytes LE
const nonce = preimage.slice(141, 149); // 8 bytes LE
const assetId = preimage.slice(149, 181); // 32 bytes

// Read slot as number
let slotVal = 0n;
for (let i = 7; i >= 0; i--) slotVal = (slotVal << 8n) | BigInt(slot[i]);
let eventIndexVal = 0;
for (let i = 3; i >= 0; i--) eventIndexVal = (eventIndexVal << 8) | eventIndex[i];
let amountVal = 0n;
for (let i = 7; i >= 0; i--) amountVal = (amountVal << 8n) | BigInt(amount[i]);
let nonceVal = 0n;
for (let i = 7; i >= 0; i--) nonceVal = (nonceVal << 8n) | BigInt(nonce[i]);

console.log('\nPreimage fields:');
console.log('  domainSep:', new TextDecoder().decode(domainSep));
console.log('  srcChainId:', srcChainId[0]);
console.log('  dstChainId:', dstChainId[0]);
console.log('  slot:', slotVal.toString());
console.log('  eventIndex:', eventIndexVal);
console.log('  amount:', amountVal.toString());
console.log('  nonce:', nonceVal.toString());

// Build Merkle tree with single leaf
function keccak256Hash(data) {
  const h = keccak256Fn(data);
  return hexToBytes(h);
}

const leaf = keccak256Hash(new Uint8Array([0x00, ...hashBytes]));
console.log('\nLeaf:', Array.from(leaf).map(b => b.toString(16).padStart(2, '0')).join(''));

// Build tree: single deposit at index 0, depth 20
const TREE_DEPTH = 20;
let current = leaf;
const siblings = [];
const pathIndices = [];

for (let i = 0; i < TREE_DEPTH; i++) {
  // Sibling is an empty subtree at each level
  const emptyLeaf = keccak256Hash(new Uint8Array(32));
  let empty = (i === 0) ? emptyLeaf : null;
  if (i > 0) {
    // Build empty subtree of depth i
    empty = emptyLeaf;
    for (let j = 0; j < i; j++) {
      const nodePreimage = new Uint8Array(65);
      nodePreimage[0] = 0x01;
      nodePreimage.set(empty, 1);
      nodePreimage.set(empty, 33);
      empty = keccak256Hash(nodePreimage);
    }
  }
  siblings.push(empty);
  pathIndices.push(0); // go left at every level

  // Compute parent
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(current, 1);
  nodePreimage.set(empty, 33);
  current = keccak256Hash(nodePreimage);
}

const merkleRoot = current;
console.log('Merkle root:', Array.from(merkleRoot).map(b => b.toString(16).padStart(2, '0')).join(''));

const rootFE = hashToFieldElements(merkleRoot);
const recipFE = hashToFieldElements(recipient);

console.log('\nField elements:');
console.log('  root_lo:', rootFE.lo.toString());
console.log('  root_hi:', rootFE.hi.toString());
console.log('  msgId_lo:', msgIdFE.lo.toString());
console.log('  msgId_hi:', msgIdFE.hi.toString());
console.log('  recip_lo:', recipFE.lo.toString());
console.log('  recip_hi:', recipFE.hi.toString());

// Build circuit input
const circuitInput = {
  checkpoint_root_lo: rootFE.lo.toString(),
  checkpoint_root_hi: rootFE.hi.toString(),
  message_id_lo: msgIdFE.lo.toString(),
  message_id_hi: msgIdFE.hi.toString(),
  amount: amountVal.toString(),
  recipient_lo: recipFE.lo.toString(),
  recipient_hi: recipFE.hi.toString(),
  version: '1',

  domain_sep: bytesToBitsLE(domainSep),
  src_program_id: bytesToBitsLE(srcProgramId),
  slot_bits: numberToBitsLE(slotVal, 64),
  event_index_bits: numberToBitsLE(eventIndexVal, 32),
  sender: bytesToBitsLE(sender),
  nonce_bits: numberToBitsLE(nonceVal, 64),
  asset_id: bytesToBitsLE(assetId),
  src_chain_id: numberToBitsLE(1, 32),
  dst_chain_id: numberToBitsLE(2, 32),
  siblings: siblings.map(s => bytesToBitsLE(s)),
  path_indices: pathIndices,
};

console.log('\nInput signal lengths:');
console.log('  domain_sep:', circuitInput.domain_sep.length, '(expected 136)');
console.log('  src_program_id:', circuitInput.src_program_id.length, '(expected 256)');
console.log('  sender:', circuitInput.sender.length, '(expected 256)');
console.log('  asset_id:', circuitInput.asset_id.length, '(expected 256)');
console.log('  slot_bits:', circuitInput.slot_bits.length, '(expected 64)');
console.log('  event_index_bits:', circuitInput.event_index_bits.length, '(expected 32)');
console.log('  nonce_bits:', circuitInput.nonce_bits.length, '(expected 64)');
console.log('  src_chain_id:', circuitInput.src_chain_id.length, '(expected 32)');
console.log('  dst_chain_id:', circuitInput.dst_chain_id.length, '(expected 32)');
console.log('  siblings:', circuitInput.siblings.length, 'x', circuitInput.siblings[0].length);
console.log('  path_indices:', circuitInput.path_indices.length);

console.log('\n════════ Generating witness (this tests the circuit keccak) ════════');
try {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM,
    ZKEY,
  );
  console.log('\n✅ PROOF GENERATED SUCCESSFULLY!');
  console.log('Public signals:', publicSignals);
} catch (err) {
  console.error('\n❌ PROOF FAILED:', err.message);
  
  // Additional debug: check if the message_id bits match
  // The circuit does: Num2Bits(128) on message_id_lo → bits[0..127]
  //                   Num2Bits(128) on message_id_hi → bits[128..255]
  // These should equal keccak output bits
  
  // What Num2Bits(128)(msgIdFE.lo) produces (LSB first):
  const loVal = msgIdFE.lo;
  const loBits = [];
  let tmp = loVal;
  for (let i = 0; i < 128; i++) {
    loBits.push(Number(tmp & 1n));
    tmp >>= 1n;
  }
  
  // What keccak output bits[0..127] should be (LSBF byte order):
  const keccakBits = [];
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 8; j++) {
      keccakBits.push((hashBytes[i] >> j) & 1);
    }
  }
  
  console.log('\nBit comparison (first 128 bits):');
  console.log('  Num2Bits(lo) == keccak bits[0..127]?');
  let match = true;
  for (let i = 0; i < 128; i++) {
    if (loBits[i] !== keccakBits[i]) {
      console.log(`  MISMATCH at bit ${i}: Num2Bits=${loBits[i]} keccak=${keccakBits[i]}`);
      match = false;
      if (i > 10) { console.log('  ... (stopping after 10 mismatches)'); break; }
    }
  }
  if (match) console.log('  ✅ All 128 lo bits match');
  
  console.log('  Num2Bits(hi) == keccak bits[128..255]?');
  const hiVal = msgIdFE.hi;
  const hiBits = [];
  tmp = hiVal;
  for (let i = 0; i < 128; i++) {
    hiBits.push(Number(tmp & 1n));
    tmp >>= 1n;
  }
  match = true;
  for (let i = 0; i < 128; i++) {
    if (hiBits[i] !== keccakBits[128 + i]) {
      console.log(`  MISMATCH at bit ${128+i}: Num2Bits=${hiBits[i]} keccak=${keccakBits[128+i]}`);
      match = false;
      if (i > 10) break;
    }
  }
  if (match) console.log('  ✅ All 128 hi bits match');
}
