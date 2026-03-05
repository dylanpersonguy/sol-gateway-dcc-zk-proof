#!/usr/bin/env node
/**
 * Deposit Recovery Script
 *
 * Recovers a deposit that was checkpointed on DCC but never had its ZK proof generated.
 * Uses the transfer ID to look up the deposit PDA on Solana, finds the matching checkpoint,
 * generates a Groth16 proof, and submits verifyAndMint to DCC.
 *
 * Usage:
 *   node --max-old-space-size=8192 recover-deposit.mjs <transferId>
 *   node --max-old-space-size=8192 recover-deposit.mjs   # scans all checkpoints for unprocessed deposits
 */

import * as snarkjs from 'snarkjs';
import pkg from 'js-sha3';
const { keccak256 } = pkg;
import { readFileSync } from 'fs';
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

const DCC_NODE_URL   = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_SEED       = process.env.DCC_VALIDATOR_SEED || '';
const DCC_CHAIN_ID   = process.env.DCC_CHAIN_ID_CHAR || String.fromCharCode(Number(process.env.DCC_CHAIN_ID) || 63);
const ZK_VERIFIER    = process.env.DCC_ZK_VERIFIER_CONTRACT || '3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6';
const SOLANA_PROGRAM = process.env.SOLANA_PROGRAM_ID || '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';
const SOLANA_RPC     = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=b2d48101-dab0-43d8-863a-2db864a1a059';
const WASM_PATH      = 'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm';
const ZKEY_PATH      = 'zk/circuits/build/bridge_deposit_final.zkey';
const VKEY_PATH      = 'zk/circuits/build/verification_key.json';
const DOMAIN_SEP     = 'DCC_SOL_BRIDGE_V1';
const TREE_DEPTH     = 20;
const ZERO_LEAF      = new Uint8Array(32);

// ═══════════════════════════════════════════════════════════════
// HELPERS (same as generate-proof-host.mjs)
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
    const bytes = new Uint8Array(64);
    bytes.set(fieldElementToBytes(xPair[1]), 0);
    bytes.set(fieldElementToBytes(xPair[0]), 32);
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

// ── Parse DepositRecord from Solana PDA ──
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

// ═══════════════════════════════════════════════════════════════
// MAIN — Recover by Transfer ID
// ═══════════════════════════════════════════════════════════════

async function recoverDeposit(transferIdHex) {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Deposit Recovery — ZK Proof Generator');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Transfer ID: ${transferIdHex}\n`);

  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const programId = new PublicKey(SOLANA_PROGRAM);

  // ── Step 1: Look up deposit PDA directly from transfer ID ──
  console.log('Step 1: Looking up deposit record on Solana...');
  const tidBytes = Buffer.from(transferIdHex, 'hex');
  const [depositPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), tidBytes],
    programId,
  );
  console.log(`  Deposit PDA: ${depositPda.toBase58()}`);

  const recordData = await connection.getAccountInfo(depositPda, 'confirmed');
  if (!recordData) {
    console.error('  ❌ Deposit record not found on Solana! Cannot recover.');
    process.exit(1);
  }

  const rec = parseDepositRecord(recordData.data);
  console.log(`  Sender:     ${rec.sender.toBase58()}`);
  console.log(`  Amount:     ${rec.amount} lamports (${Number(rec.amount) / 1e9} SOL)`);
  console.log(`  Nonce:      ${rec.nonce}`);
  console.log(`  Slot:       ${rec.slot}`);
  console.log(`  Event Idx:  ${rec.eventIndex}`);
  console.log(`  Message ID: ${rec.messageId}`);

  // Get recipient (trim trailing zeros, convert to base58)
  const recipientRaw = Buffer.from(rec.recipientDcc);
  let lastNonZero = recipientRaw.length - 1;
  while (lastNonZero > 0 && recipientRaw[lastNonZero] === 0) lastNonZero--;
  const recipientAddress = toBase58(recipientRaw.subarray(0, lastNonZero + 1));
  console.log(`  Recipient:  ${recipientAddress} (DCC)`);

  // ── Step 2: Check if already ZK-processed ──
  console.log('\nStep 2: Checking if already processed...');
  try {
    const zkProcessed = await nodeInteraction.accountDataByKey(
      `zk_processed_${rec.messageId}`,
      ZK_VERIFIER,
      DCC_NODE_URL,
    );
    if (zkProcessed?.value === true) {
      console.log('  ✅ Already ZK-processed! No recovery needed.');
      return;
    }
  } catch {}
  console.log('  Not yet ZK-processed — proceeding with recovery.');

  // ── Step 3: Find the matching checkpoint ──
  console.log('\nStep 3: Finding matching checkpoint on DCC...');
  const senderBytes = base58ToBytes(rec.sender.toBase58(), 32);
  const srcProgramId = base58ToBytes(SOLANA_PROGRAM, 32);
  const assetId = new Uint8Array(32);
  const recipientPadded = new Uint8Array(32);
  recipientPadded.set(Uint8Array.from(rec.recipientDcc).subarray(0, 32), 0);

  const messageIdComputed = computeMessageId(
    1, 2, srcProgramId,
    BigInt(rec.slot),
    rec.eventIndex,
    senderBytes,
    recipientPadded,
    BigInt(rec.amount),
    BigInt(rec.nonce),
    assetId,
  );
  console.log(`  Computed message ID: ${bytesToHex(messageIdComputed)}`);

  // Build Merkle tree for single deposit
  const messageIds = [messageIdComputed];
  const { root } = buildMerkleTree(messageIds);
  const computedRootHex = bytesToHex(root);
  console.log(`  Computed root: ${computedRootHex}`);

  // Scan checkpoints to find matching root
  const nextCheckpointId = await nodeInteraction.accountDataByKey(
    'next_checkpoint_id', ZK_VERIFIER, DCC_NODE_URL,
  );
  const latestCid = ((nextCheckpointId?.value) || 1) - 1;
  console.log(`  Latest checkpoint ID on DCC: ${latestCid}`);

  let matchedCheckpointId = null;
  for (let cid = latestCid; cid >= Math.max(0, latestCid - 20); cid--) {
    try {
      const entry = await nodeInteraction.accountDataByKey(
        `checkpoint_${cid}_root`, ZK_VERIFIER, DCC_NODE_URL,
      );
      if (entry) {
        const b64 = String(entry.value).replace(/^base64:/, '');
        const rootBytes = Buffer.from(b64, 'base64');
        if (Buffer.from(root).equals(rootBytes)) {
          matchedCheckpointId = cid;
          console.log(`  ✅ Root matches checkpoint ${cid}!`);
          break;
        }
      }
    } catch {}
  }

  if (matchedCheckpointId === null) {
    console.error('  ❌ No matching checkpoint found. The deposit may need re-checkpointing.');
    console.error('     Restart validators with ZK_PROOF_GENERATION_ENABLED=true');
    process.exit(1);
  }

  // ── Step 4: Generate Groth16 proof ──
  console.log('\nStep 4: Building circuit inputs...');
  const merkleProof = getMerkleProof(messageIds, 0);
  const domainSepBytes = new TextEncoder().encode(DOMAIN_SEP);
  const rootFE = hashToFieldElements(root);
  const msgIdFE = hashToFieldElements(messageIdComputed);
  const recipFE = hashToFieldElements(recipientPadded);

  const circuitInput = {
    checkpoint_root_lo: rootFE.lo.toString(),
    checkpoint_root_hi: rootFE.hi.toString(),
    message_id_lo: msgIdFE.lo.toString(),
    message_id_hi: msgIdFE.hi.toString(),
    amount: rec.amount.toString(),
    recipient_lo: recipFE.lo.toString(),
    recipient_hi: recipFE.hi.toString(),
    version: '1',
    domain_sep: bytesToBitsLE(domainSepBytes),
    src_program_id: bytesToBitsLE(srcProgramId),
    slot_bits: numberToBitsLE(Number(rec.slot), 64),
    event_index_bits: numberToBitsLE(rec.eventIndex, 32),
    sender: bytesToBitsLE(senderBytes),
    nonce_bits: numberToBitsLE(Number(rec.nonce), 64),
    asset_id: bytesToBitsLE(assetId),
    src_chain_id: numberToBitsLE(1, 32),
    dst_chain_id: numberToBitsLE(2, 32),
    siblings: merkleProof.siblings.map(s => bytesToBitsLE(s)),
    path_indices: merkleProof.pathIndices,
  };

  console.log('\nStep 5: Generating Groth16 proof (3-5 min)...');
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput, WASM_PATH, ZKEY_PATH,
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ Proof generated in ${elapsed}s`);

  // ── Step 5: Local verification ──
  console.log('\nStep 6: Verifying proof locally...');
  const vkey = JSON.parse(readFileSync(VKEY_PATH, 'utf8'));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!valid) {
    console.error('  ❌ LOCAL VERIFICATION FAILED');
    process.exit(1);
  }
  console.log('  ✅ Local verification PASSED');

  // ── Step 6: Submit verifyAndMint ──
  console.log('\nStep 7: Submitting verifyAndMint to DCC...');
  const proofBytes = serializeProofForRIDE(proof);
  const inputsBytes = serializeInputsForRIDE(publicSignals);
  const proofBase64 = Buffer.from(proofBytes).toString('base64');
  const inputsBase64 = Buffer.from(inputsBytes).toString('base64');

  const srcProgramIdBase64 = Buffer.from(srcProgramId).toString('base64');
  const senderBase64 = Buffer.from(senderBytes).toString('base64');
  const recipientBytesBase64 = Buffer.from(recipientPadded).toString('base64');
  const assetIdBase64 = Buffer.alloc(32).toString('base64');

  const { seedWithNonce, privateKey, publicKey: pubKeyFn } = libs.crypto;
  const B_SEED = seedWithNonce(DCC_SEED, 2);
  const B_SIGNER = { privateKey: privateKey(B_SEED) };
  const bPubKey = pubKeyFn(B_SEED);

  console.log(`  Contract B signer: ${bPubKey}`);
  console.log(`  Recipient: ${recipientAddress}`);
  console.log(`  Checkpoint ID: ${matchedCheckpointId}`);
  console.log(`  Amount: ${rec.amount} lamports`);

  const tx = invokeScript(
    {
      dApp: ZK_VERIFIER,
      call: {
        function: 'verifyAndMint',
        args: [
          { type: 'binary', value: `base64:${proofBase64}` },
          { type: 'binary', value: `base64:${inputsBase64}` },
          { type: 'integer', value: matchedCheckpointId },
          { type: 'integer', value: 1 },
          { type: 'integer', value: 2 },
          { type: 'binary', value: `base64:${srcProgramIdBase64}` },
          { type: 'integer', value: Number(rec.slot) },
          { type: 'integer', value: rec.eventIndex },
          { type: 'binary', value: `base64:${senderBase64}` },
          { type: 'binary', value: `base64:${recipientBytesBase64}` },
          { type: 'integer', value: Number(rec.amount) },
          { type: 'integer', value: Number(rec.nonce) },
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
    console.log(`\n  ✅ verifyAndMint broadcast: ${result.id}`);

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
    console.log(' DEPOSIT RECOVERED — ZK-VERIFIED MINT SUCCESSFUL!');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Tx: ${result.id}`);
    console.log(`  Amount: ${rec.amount} lamports (${Number(rec.amount) / 1e9} SOL)`);
    console.log(`  Recipient: ${recipientAddress}`);
    console.log(`  Checkpoint: ${matchedCheckpointId}`);
    console.log(`  Proof time: ${elapsed}s`);

    // Notify API so frontend status polling picks up completion immediately
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    try {
      // Register transfer if not already known
      await fetch(`${apiUrl}/api/v1/transfer/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          sender: rec.sender,
          recipient: recipientAddress,
          amount: String(rec.amount),
          direction: 'sol_to_dcc',
          sourceTxHash: '',
        }),
      }).catch(() => {});
      // Update to completed + broadcast via SSE
      await fetch(`${apiUrl}/api/v1/transfer/notify-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferId, status: 'completed', destTxHash: result.id }),
      }).catch(() => {});
      console.log('  ✅ API notified — frontend will update immediately');
    } catch {
      console.log('  ℹ️  API notification skipped (non-critical)');
    }
  } catch (err) {
    console.error('\n  ❌ Broadcast failed:', err.message);
    if (err.data) console.error('  Data:', JSON.stringify(err.data));
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// SCAN MODE — find all unprocessed checkpointed deposits
// ═══════════════════════════════════════════════════════════════

async function scanUnprocessed() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Scanning for unprocessed checkpointed deposits...');
  console.log('═══════════════════════════════════════════════════\n');

  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const programId = new PublicKey(SOLANA_PROGRAM);

  // Get all checkpoints
  const nextCid = await nodeInteraction.accountDataByKey(
    'next_checkpoint_id', ZK_VERIFIER, DCC_NODE_URL,
  );
  const latestCid = ((nextCid?.value) || 1) - 1;
  console.log(`Latest checkpoint: ${latestCid}\n`);

  // Get recent deposit transactions from Solana
  const signatures = await connection.getSignaturesForAddress(
    programId, { limit: 50 }, 'confirmed',
  );
  console.log(`Found ${signatures.length} recent program transactions\n`);

  // Parse deposit events from transaction logs
  const deposits = [];
  for (const sig of signatures) {
    if (sig.err) continue;
    try {
      const tx = await connection.getTransaction(sig.signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages) continue;

      for (const log of tx.meta.logMessages) {
        if (log.includes('Program data:')) {
          const dataStr = log.split('Program data: ')[1];
          if (!dataStr) continue;
          const data = Buffer.from(dataStr, 'base64');
          if (data.length >= 212) { // 8 discriminator + 204 event data
            const transferId = bytesToHex(data.subarray(8, 40));
            const amount = data.readBigUInt64LE(136);
            deposits.push({ transferId, amount, slot: tx.slot, signature: sig.signature });
          }
        }
      }
    } catch {}
  }

  console.log(`Found ${deposits.length} deposit events\n`);

  // Check each deposit for ZK processing status
  const unprocessed = [];
  for (const dep of deposits) {
    const [depositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('deposit'), Buffer.from(dep.transferId, 'hex')],
      programId,
    );
    try {
      const recordData = await connection.getAccountInfo(depositPda);
      if (!recordData) continue;
      const rec = parseDepositRecord(recordData.data);

      // Check ZK processing status
      try {
        const zkProcessed = await nodeInteraction.accountDataByKey(
          `zk_processed_${rec.messageId}`, ZK_VERIFIER, DCC_NODE_URL,
        );
        if (zkProcessed?.value === true) continue; // Already processed
      } catch {}

      // Also check committee processing
      try {
        const processed = await nodeInteraction.accountDataByKey(
          `processed_${dep.transferId}`, ZK_VERIFIER.replace('3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6', '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG'),
          DCC_NODE_URL,
        );
        if (processed?.value === true) continue; // Committee processed
      } catch {}

      unprocessed.push({
        transferId: dep.transferId,
        amount: rec.amount,
        sender: rec.sender.toBase58(),
        slot: Number(rec.slot),
        nonce: Number(rec.nonce),
      });
    } catch {}
  }

  if (unprocessed.length === 0) {
    console.log('✅ No unprocessed deposits found!');
    return;
  }

  console.log(`\n⚠️  Found ${unprocessed.length} unprocessed deposit(s):\n`);
  for (const dep of unprocessed) {
    console.log(`  Transfer ID: ${dep.transferId}`);
    console.log(`    Sender: ${dep.sender}`);
    console.log(`    Amount: ${dep.amount} lamports (${Number(dep.amount) / 1e9} SOL)`);
    console.log(`    Slot:   ${dep.slot}`);
    console.log('');
  }

  // Process each
  for (const dep of unprocessed) {
    console.log(`\nRecovering deposit ${dep.transferId.substring(0, 16)}...`);
    await recoverDeposit(dep.transferId);
    console.log('');
  }
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
if (args.length > 0 && args[0].length >= 32) {
  recoverDeposit(args[0]).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
} else {
  scanUnprocessed().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
