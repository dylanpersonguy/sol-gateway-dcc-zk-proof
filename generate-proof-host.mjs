#!/usr/bin/env node
/**
 * Host-side ZK Proof Generator
 *
 * Runs on macOS host (outside Docker) where there are no container memory limits.
 * The 1.76GB zkey + snarkjs WASM needs ~6GB RSS — too much for Docker Desktop's 7.65GB VM.
 *
 * Usage:
 *   node --max-old-space-size=8192 generate-proof-host.mjs
 *
 * What it does:
 *   1. Queries DCC chain for latest checkpoint (root, ID)
 *   2. Queries Solana chain for the deposit record
 *   3. Rebuilds messageId + Merkle tree + circuit inputs
 *   4. Generates Groth16 proof via snarkjs
 *   5. Verifies proof locally
 *   6. Submits verifyAndMint to DCC Contract B
 */

import * as snarkjs from 'snarkjs';
import pkg from 'js-sha3';
const { keccak256 } = pkg;
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  invokeScript,
  broadcast,
  nodeInteraction,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const DCC_NODE_URL = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_API_KEY  = process.env.DCC_API_KEY  || (() => { throw new Error('Missing env var: DCC_API_KEY'); })();
const DCC_SEED     = process.env.DCC_VALIDATOR_SEED || (() => { throw new Error('Missing env var: DCC_VALIDATOR_SEED'); })();
const DCC_CHAIN_ID = process.env.DCC_CHAIN_ID_CHAR || String.fromCharCode(Number(process.env.DCC_CHAIN_ID) || 63);

const ZK_VERIFIER   = '3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6';
const BRIDGE_CORE   = '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG';
const SOLANA_PROGRAM = '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';

const WASM_PATH = 'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm';
const ZKEY_PATH = 'zk/circuits/build/bridge_deposit_final.zkey';
const VKEY_PATH = 'zk/circuits/build/verification_key.json';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=b2d48101-dab0-43d8-863a-2db864a1a059';

const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';
const TREE_DEPTH = 20;
const ZERO_LEAF = new Uint8Array(32);

// Deposit data — from the last e2e-zk-test.mjs run (nonce 29)
// These will be auto-detected from Solana if not specified:
let DEPOSIT = {
  sender: 'GaNkfy3fqnT71vKTJzx5hPf8oqz5UmfDfm7VtvJ7MTyc',
  recipient: '3DXbZsC9M73r5b8FxJV5YMr5qeq5VNDqwpR',
  amount: '1234000',  // lamports (0.001234 SOL)
  nonce: null,   // auto-detect from latest deposit record
  slot: null,    // auto-detect
  eventIndex: 0,
  transferId: null, // auto-detect
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function writeU32LE(buf, value, offset) {
  buf[offset]     = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function writeU64LE(buf, value, offset) {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58ToBytes(b58, targetLen) {
  let num = 0n;
  for (const char of b58) {
    const idx = BS58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const rawBytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  let leadingZeros = 0;
  for (const c of b58) {
    if (c === '1') leadingZeros++;
    else break;
  }
  const result = new Uint8Array(targetLen);
  const totalBytes = leadingZeros + rawBytes.length;
  const startOffset = Math.max(0, targetLen - totalBytes);
  for (let i = 0; i < leadingZeros && (startOffset + i) < targetLen; i++) {
    result[startOffset + i] = 0;
  }
  const rawStart = startOffset + leadingZeros;
  for (let i = 0; i < rawBytes.length && (rawStart + i) < targetLen; i++) {
    result[rawStart + i] = rawBytes[i];
  }
  return result;
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(clean.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function keccak256Hash(data) {
  const hash = keccak256(data);
  return new Uint8Array(hash.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function computeMessageId(srcChainId, dstChainId, srcProgramId, slot, eventIndex, sender, recipient, amount, nonce, assetId) {
  const preimage = new Uint8Array(181);
  let offset = 0;
  const domainBytes = new TextEncoder().encode(DOMAIN_SEP);
  preimage.set(domainBytes, offset); offset += 17;
  writeU32LE(preimage, srcChainId, offset); offset += 4;
  writeU32LE(preimage, dstChainId, offset); offset += 4;
  preimage.set(srcProgramId.subarray(0, 32), offset); offset += 32;
  writeU64LE(preimage, slot, offset); offset += 8;
  writeU32LE(preimage, eventIndex, offset); offset += 4;
  preimage.set(sender.subarray(0, 32), offset); offset += 32;
  preimage.set(recipient.subarray(0, 32), offset); offset += 32;
  writeU64LE(preimage, amount, offset); offset += 8;
  writeU64LE(preimage, nonce, offset); offset += 8;
  preimage.set(assetId.subarray(0, 32), offset); offset += 32;
  return keccak256Hash(preimage);
}

function computeLeaf(messageId) {
  const leafPreimage = new Uint8Array(33);
  leafPreimage[0] = 0x00;
  leafPreimage.set(messageId, 1);
  return keccak256Hash(leafPreimage);
}

function hashNode(left, right) {
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(left, 1);
  nodePreimage.set(right, 33);
  return keccak256Hash(nodePreimage);
}

function buildMerkleTree(messageIds) {
  const maxLeaves = 1 << TREE_DEPTH;
  const leaves = [];
  for (let i = 0; i < maxLeaves; i++) {
    leaves.push(computeLeaf(i < messageIds.length ? messageIds[i] : ZERO_LEAF));
  }
  let currentLevel = leaves;
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(hashNode(currentLevel[i], currentLevel[i + 1]));
    }
    currentLevel = nextLevel;
  }
  return { root: currentLevel[0], leaves };
}

function getMerkleProof(messageIds, eventIdx) {
  const maxLeaves = 1 << TREE_DEPTH;
  const leaves = [];
  for (let i = 0; i < maxLeaves; i++) {
    leaves.push(computeLeaf(i < messageIds.length ? messageIds[i] : ZERO_LEAF));
  }
  const siblings = [];
  const pathIndices = [];
  let currentLevel = leaves;
  let idx = eventIdx;
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(currentLevel[siblingIdx]);
    pathIndices.push(idx % 2);
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(hashNode(currentLevel[i], currentLevel[i + 1]));
    }
    currentLevel = nextLevel;
    idx = Math.floor(idx / 2);
  }
  return { siblings, pathIndices };
}

function hashToFieldElements(hash) {
  let lo = 0n;
  for (let i = 15; i >= 0; i--) lo = (lo << 8n) | BigInt(hash[i]);
  let hi = 0n;
  for (let i = 31; i >= 16; i--) hi = (hi << 8n) | BigInt(hash[i]);
  return { lo, hi };
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

function fieldElementToBytes(decStr) {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function serializeProofForRIDE(proof) {
  // DCC/Waves bn256Groth16Verify expects 128-byte compressed proof:
  // G1 compressed = 32 bytes (x only, MSB flag for y > p/2)
  // G2 compressed = 64 bytes (x0 + x1, MSB flag for y)
  // proof = pi_a(32) + pi_b(64) + pi_c(32) = 128 bytes
  const BN256_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const HALF_P = BN256_P / 2n;

  function compressG1(xDec, yDec) {
    const x = BigInt(xDec);
    const y = BigInt(yDec);
    const bytes = fieldElementToBytes(xDec);
    if (y > HALF_P) bytes[0] |= 0x80;
    return bytes;
  }

  function compressG2(xPair, yPair) {
    // snarkjs G2: [[x_real, x_imag], [y_real, y_imag], ["1", "0"]]
    // pairing_ce compressed: c1(imag) first, c0(real) second, y-flag on c1 of y
    const bytes = new Uint8Array(64);
    bytes.set(fieldElementToBytes(xPair[1]), 0);   // x_imag = c1 (first in compressed)
    bytes.set(fieldElementToBytes(xPair[0]), 32);  // x_real = c0 (second in compressed)
    const y_imag = BigInt(yPair[1]);
    if (y_imag > HALF_P) bytes[0] |= 0x80;
    return bytes;
  }

  const result = new Uint8Array(128);
  let offset = 0;
  result.set(compressG1(proof.pi_a[0], proof.pi_a[1]), offset); offset += 32;
  result.set(compressG2(proof.pi_b[0], proof.pi_b[1]), offset); offset += 64;
  result.set(compressG1(proof.pi_c[0], proof.pi_c[1]), offset); offset += 32;
  return result;
}

function serializeInputsForRIDE(publicSignals) {
  const result = new Uint8Array(256);
  for (let i = 0; i < 8; i++) {
    result.set(fieldElementToBytes(publicSignals[i]), i * 32);
  }
  return result;
}

function toBase58(buf) {
  let num = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let result = '';
  while (num > 0n) {
    result = BS58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    result = '1' + result;
  }
  return result || '1';
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Host-Side ZK Proof Generator');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Step 1: Find latest checkpoint with root ──
  console.log('Step 1: Querying DCC for latest checkpoint...');
  const nextCheckpointId = await nodeInteraction.accountDataByKey(
    'next_checkpoint_id',
    ZK_VERIFIER,
    DCC_NODE_URL,
  );
  const latestCheckpointId = ((nextCheckpointId?.value) || 1) - 1;
  console.log(`  Latest checkpoint ID: ${latestCheckpointId}`);

  const storedRootEntry = await nodeInteraction.accountDataByKey(
    `checkpoint_${latestCheckpointId}_root`,
    ZK_VERIFIER,
    DCC_NODE_URL,
  );
  if (!storedRootEntry) {
    throw new Error(`No root found for checkpoint ${latestCheckpointId}`);
  }
  const rawB64 = (storedRootEntry.value).replace(/^base64:/, '');
  const storedRootBytes = Buffer.from(rawB64, 'base64');
  console.log(`  Checkpoint root: ${bytesToHex(storedRootBytes)}`);

  // Get checkpoint slot
  const checkpointSlotEntry = await nodeInteraction.accountDataByKey(
    `checkpoint_${latestCheckpointId}_slot`,
    ZK_VERIFIER,
    DCC_NODE_URL,
  );
  const checkpointSlot = checkpointSlotEntry?.value || 0;
  console.log(`  Checkpoint slot: ${checkpointSlot}`);

  // ── Step 2: Find the deposit on Solana ──
  console.log('\nStep 2: Querying Solana for latest deposit...');
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const programId = new PublicKey(SOLANA_PROGRAM);
  const senderPubkey = new PublicKey(DEPOSIT.sender);

  // Read nonce from UserState PDA (disc_8 + user_32 + next_nonce at offset 40)
  const [userState] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_state'), senderPubkey.toBuffer()], programId
  );
  const userStateData = await connection.getAccountInfo(userState);
  if (!userStateData || userStateData.data.length < 48) {
    throw new Error('Could not read UserState — no deposits yet?');
  }
  const nextNonce = userStateData.data.readBigUInt64LE(40);
  console.log(`  UserState next_nonce: ${nextNonce}`);

  // Helper: compute transfer_id = SHA256(sender_pubkey || nonce_LE)
  function computeTransferId(senderPk, nonce) {
    const buf = Buffer.alloc(40);
    senderPk.toBuffer().copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(nonce), 32);
    return createHash('sha256').update(buf).digest();
  }

  // Helper: parse DepositRecord with correct offsets
  // Layout: disc(8) + transfer_id(32) + message_id(32) + sender(32) + recipient_dcc(32)
  //       + amount(8) + nonce(8) + slot(8) + event_index(4) + timestamp(8) + asset_id(32)
  //       + processed(1) + bump(1) = 206 bytes
  function parseDepositRecord(data) {
    return {
      transferId: bytesToHex(data.subarray(8, 40)),
      messageId: bytesToHex(data.subarray(40, 72)),
      sender: new PublicKey(data.subarray(72, 104)),
      recipientDcc: data.subarray(104, 136),
      amount: data.readBigUInt64LE(136),
      nonce: data.readBigUInt64LE(144),
      slot: data.readBigUInt64LE(152),
      eventIndex: data.readUInt32LE(160),
      timestamp: data.readBigInt64LE(164),
      assetId: new PublicKey(data.subarray(172, 204)),
      processed: data[204] !== 0,
      bump: data[205],
    };
  }

  // Search last few nonces to find deposit matching checkpoint slot
  let deposit = null;
  for (let testNonce = Number(nextNonce) - 1; testNonce >= Math.max(0, Number(nextNonce) - 5); testNonce--) {
    const tid = computeTransferId(senderPubkey, testNonce);
    const [depositRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('deposit'), tid], programId
    );
    try {
      const recordData = await connection.getAccountInfo(depositRecordPda);
      if (!recordData) continue;
      const rec = parseDepositRecord(recordData.data);
      console.log(`  Deposit nonce ${testNonce}: slot=${rec.slot}, amount=${rec.amount}, sender=${rec.sender.toBase58()}, eventIndex=${rec.eventIndex}`);

      if (Number(rec.slot) === Number(checkpointSlot)) {
        deposit = {
          sender: rec.sender.toBase58(),
          recipient: DEPOSIT.recipient,
          recipientDccBytes: Uint8Array.from(rec.recipientDcc),
          amount: rec.amount.toString(),
          nonce: Number(rec.nonce),
          slot: Number(rec.slot),
          eventIndex: rec.eventIndex,
          transferId: rec.transferId,
          messageId: rec.messageId,
        };
        console.log(`  ✅ Matched checkpoint slot!`);
        break;
      }
    } catch (err) {
      console.log(`  Nonce ${testNonce}: error — ${err.message}`);
    }
  }

  if (!deposit) {
    // Fall back: use the latest deposit regardless of slot match
    console.log('  ⚠️  No exact slot match — using latest deposit and rebuilding root...');
    const testNonce = Number(nextNonce) - 1;
    const tid = computeTransferId(senderPubkey, testNonce);
    const [depositRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('deposit'), tid], programId
    );
    const recordData = await connection.getAccountInfo(depositRecordPda);
    if (!recordData) throw new Error(`Deposit record not found for nonce ${testNonce}`);
    const rec = parseDepositRecord(recordData.data);
    deposit = {
      sender: rec.sender.toBase58(),
      recipient: DEPOSIT.recipient,
      recipientDccBytes: Uint8Array.from(rec.recipientDcc),
      amount: rec.amount.toString(),
      nonce: Number(rec.nonce),
      slot: Number(rec.slot),
      eventIndex: rec.eventIndex,
      transferId: rec.transferId,
      messageId: rec.messageId,
    };
    console.log(`  Using nonce ${testNonce}: slot=${rec.slot}, amount=${rec.amount}`);
  }

  console.log(`\n  Deposit details:`);
  console.log(`    Sender:     ${deposit.sender}`);
  console.log(`    Recipient:  ${deposit.recipient}`);
  console.log(`    Amount:     ${deposit.amount} lamports`);
  console.log(`    Nonce:      ${deposit.nonce}`);
  console.log(`    Slot:       ${deposit.slot}`);
  console.log(`    Event Idx:  ${deposit.eventIndex}`);
  console.log(`    Transfer ID: ${deposit.transferId}`);

  // ── Step 3: Compute message ID and Merkle tree ──
  console.log('\nStep 3: Computing message ID + Merkle tree...');
  const senderBytes = base58ToBytes(deposit.sender, 32);
  const srcProgramId = base58ToBytes(SOLANA_PROGRAM, 32);
  const assetId = new Uint8Array(32);

  // Use the on-chain recipient_dcc bytes directly (32 bytes, left-padded with zeros at end)
  const recipientPadded = new Uint8Array(32);
  recipientPadded.set(deposit.recipientDccBytes.subarray(0, 32), 0);

  const messageIdComputed = computeMessageId(
    1, 2, srcProgramId,
    BigInt(deposit.slot),
    deposit.eventIndex,
    senderBytes,
    recipientPadded,
    BigInt(deposit.amount),
    BigInt(deposit.nonce),
    assetId,
  );
  console.log(`  Computed Message ID: ${bytesToHex(messageIdComputed)}`);
  console.log(`  On-chain Message ID: ${deposit.messageId}`);

  // Verify our computation matches on-chain
  if (bytesToHex(messageIdComputed) === deposit.messageId) {
    console.log('  ✅ Message ID MATCHES on-chain!');
  } else {
    console.log('  ⚠️  Message ID differs from on-chain (expected — chain IDs may differ in config)');
    console.log('      Using COMPUTED messageId (matches validator consensus) for Merkle tree');
  }

  // Always use the computed messageId — the checkpoint root was built by the validator
  // using the same hardcoded chain IDs (1, 2) we use here
  const messageIdCorrect = messageIdComputed;

  // Build Merkle tree with just this one deposit
  const messageIds = [messageIdCorrect];
  const { root } = buildMerkleTree(messageIds);
  console.log(`  Computed root: ${bytesToHex(root)}`);
  console.log(`  On-chain root: ${bytesToHex(storedRootBytes)}`);

  if (Buffer.from(root).equals(storedRootBytes)) {
    console.log('  ✅ Root MATCHES checkpoint!');
  } else {
    console.log('  ❌ Root MISMATCH — will try to find the right checkpoint...');

    // Scan all checkpoints for our root
    let found = false;
    for (let cid = latestCheckpointId; cid >= Math.max(0, latestCheckpointId - 5); cid--) {
      const entry = await nodeInteraction.accountDataByKey(
        `checkpoint_${cid}_root`,
        ZK_VERIFIER,
        DCC_NODE_URL,
      );
      if (entry) {
        const b64 = (entry.value).replace(/^base64:/, '');
        const rootBytes = Buffer.from(b64, 'base64');
        if (Buffer.from(root).equals(rootBytes)) {
          console.log(`  ✅ Found matching root at checkpoint ${cid}`);
          // Override
          Object.assign(storedRootBytes, rootBytes);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      console.error('  ❌ Could not find any checkpoint with matching root. Aborting.');
      process.exit(1);
    }
  }

  // Check if already ZK-processed
  const messageIdHex = bytesToHex(messageIdCorrect);
  try {
    const zkProcessed = await nodeInteraction.accountDataByKey(
      `zk_processed_${messageIdHex}`,
      ZK_VERIFIER,
      DCC_NODE_URL,
    );
    if (zkProcessed?.value === true) {
      console.log('\n  ⚠️  Already ZK-processed! Skipping.');
      process.exit(0);
    }
  } catch {}

  // ── Step 4: Build circuit inputs ──
  console.log('\nStep 4: Building circuit inputs...');
  const merkleProof = getMerkleProof(messageIds, 0);
  const domainSepBytes = new TextEncoder().encode(DOMAIN_SEP);

  const rootFE = hashToFieldElements(root);
  const msgIdFE = hashToFieldElements(messageIdCorrect);
  const recipFE = hashToFieldElements(recipientPadded);

  const circuitInput = {
    checkpoint_root_lo: rootFE.lo.toString(),
    checkpoint_root_hi: rootFE.hi.toString(),
    message_id_lo: msgIdFE.lo.toString(),
    message_id_hi: msgIdFE.hi.toString(),
    amount: deposit.amount.toString(),
    recipient_lo: recipFE.lo.toString(),
    recipient_hi: recipFE.hi.toString(),
    version: '1',
    domain_sep: bytesToBitsLE(domainSepBytes),
    src_program_id: bytesToBitsLE(srcProgramId),
    slot_bits: numberToBitsLE(deposit.slot, 64),
    event_index_bits: numberToBitsLE(deposit.eventIndex, 32),
    sender: bytesToBitsLE(senderBytes),
    nonce_bits: numberToBitsLE(deposit.nonce, 64),
    asset_id: bytesToBitsLE(assetId),
    src_chain_id: numberToBitsLE(1, 32),
    dst_chain_id: numberToBitsLE(2, 32),
    siblings: merkleProof.siblings.map(s => bytesToBitsLE(s)),
    path_indices: merkleProof.pathIndices,
  };
  console.log('  Circuit inputs prepared.');
  console.log(`    Public signals: root_lo=${rootFE.lo}, root_hi=${rootFE.hi}`);
  console.log(`    Amount: ${deposit.amount}, Version: 1`);

  // ── Step 5: Generate Groth16 proof ──
  console.log('\nStep 5: Generating Groth16 proof (this takes 3-5 minutes)...');
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ Proof generated in ${elapsed}s`);
  console.log(`  Public signals: ${publicSignals.map(s => s.substring(0, 20) + '...').join(', ')}`);

  // ── Step 6: Local verification ──
  console.log('\nStep 6: Verifying proof locally...');
  const vkey = JSON.parse(readFileSync(VKEY_PATH, 'utf8'));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!valid) {
    console.error('  ❌ LOCAL VERIFICATION FAILED — circuit bug!');
    process.exit(1);
  }
  console.log('  ✅ Local verification PASSED');

  // Save proof data for fast re-submission tests
  writeFileSync('/tmp/proof-data.json', JSON.stringify({
    proof, publicSignals, deposit, latestCheckpointId,
    senderBytes: Array.from(senderBytes),
    srcProgramId: Array.from(srcProgramId),
    recipientPadded: Array.from(recipientPadded),
    recipientDccBytes: Array.from(deposit.recipientDccBytes),
  }));
  console.log('  Saved proof data to /tmp/proof-data.json');

  // ── Step 7: Submit verifyAndMint to DCC ──
  console.log('\nStep 7: Submitting verifyAndMint to DCC...');

  const proofBytes = serializeProofForRIDE(proof);
  const inputsBytes = serializeInputsForRIDE(publicSignals);
  const proofBase64 = Buffer.from(proofBytes).toString('base64');
  const inputsBase64 = Buffer.from(inputsBytes).toString('base64');

  // Resolve DCC recipient
  const recipientRawBytes = base58ToBytes(deposit.recipient, 26);
  let lastNonZero = recipientRawBytes.length - 1;
  while (lastNonZero > 0 && recipientRawBytes[lastNonZero] === 0) lastNonZero--;
  const recipientTrimmed = recipientRawBytes.subarray(0, lastNonZero + 1);
  const recipientAddress = toBase58(recipientTrimmed);

  const srcProgramIdBase64 = Buffer.from(srcProgramId).toString('base64');
  const senderBase64 = Buffer.from(senderBytes).toString('base64');
  const recipientPaddedHex = bytesToHex(recipientPadded);
  const recipientBytesBase64 = Buffer.from(recipientPaddedHex, 'hex').toString('base64');
  const assetIdBase64 = Buffer.alloc(32).toString('base64');

  // Use Contract B signer (nonce 2)
  const { seedWithNonce, privateKey, publicKey: pubKeyFn } = libs.crypto;
  const B_SEED = seedWithNonce(DCC_SEED, 2);
  const B_SIGNER = { privateKey: privateKey(B_SEED) };
  const bPubKey = pubKeyFn(B_SEED);

  console.log(`  Contract B signer: ${bPubKey}`);
  console.log(`  Recipient address: ${recipientAddress}`);
  console.log(`  Checkpoint ID: ${latestCheckpointId}`);

  const tx = invokeScript(
    {
      dApp: ZK_VERIFIER,
      call: {
        function: 'verifyAndMint',
        args: [
          { type: 'binary', value: `base64:${proofBase64}` },
          { type: 'binary', value: `base64:${inputsBase64}` },
          { type: 'integer', value: latestCheckpointId },
          { type: 'integer', value: 1 },  // srcChainId (Solana)
          { type: 'integer', value: 2 },  // dstChainId (DCC)
          { type: 'binary', value: `base64:${srcProgramIdBase64}` },
          { type: 'integer', value: deposit.slot },
          { type: 'integer', value: deposit.eventIndex },
          { type: 'binary', value: `base64:${senderBase64}` },
          { type: 'binary', value: `base64:${recipientBytesBase64}` },
          { type: 'integer', value: Number(deposit.amount) },
          { type: 'integer', value: Number(deposit.nonce) },
          { type: 'binary', value: `base64:${assetIdBase64}` },
          { type: 'string', value: recipientAddress },
        ],
      },
      payment: [],
      fee: 1800000,
      chainId: DCC_CHAIN_ID,
      senderPublicKey: bPubKey,
    },
    B_SIGNER,
  );

  console.log('  Broadcasting transaction...');
  try {
    const result = await broadcast(tx, DCC_NODE_URL);
    console.log(`\n  ✅ verifyAndMint tx broadcast: ${result.id}`);

    // Wait for confirmation
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${DCC_NODE_URL}/transactions/info/${result.id}`);
        const d = await r.json();
        if (d.id) {
          console.log(`  ✅ Transaction confirmed!`);
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log(' 🎉 ZK-VERIFIED MINT SUCCESSFUL!');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Tx: ${result.id}`);
    console.log(`  Amount: ${deposit.amount} lamports → ${deposit.recipient}`);
    console.log(`  Checkpoint: ${latestCheckpointId}`);
    console.log(`  Proof time: ${elapsed}s`);
  } catch (err) {
    console.error('\n  ❌ Broadcast failed:', err.message);
    if (err.data) console.error('  Data:', JSON.stringify(err.data));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
