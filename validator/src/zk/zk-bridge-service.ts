/**
 * ZK Bridge Service — Checkpoint Management + Proof Pipeline
 *
 * ZK-PRIMARY ARCHITECTURE:
 *
 * For deposits above the ZK_ONLY_THRESHOLD:
 *   - ZK proof is the ONLY minting path (committee is not used)
 *   - Full Groth16 proof generation + on-chain verification + mint
 *
 * For deposits below the threshold:
 *   - Committee fast-path mints immediately (~8 seconds)
 *   - ZK proof is generated in background for retroactive verification
 *   - If the ZK proof fails, signals potential compromise
 *
 * Pipeline:
 * 1. Collects deposit events into checkpoint windows
 * 2. Builds Merkle trees from canonical message_ids
 * 3. Submits checkpoint proposals to Contract B (ZK Verifier)
 * 4. Generates Groth16 proofs for each deposit in a finalized checkpoint
 * 5. Submits verifyAndMint transactions to Contract B (or verifies locally for committee-minted)
 */

import { EventEmitter } from 'events';
import {
  invokeScript,
  broadcast,
  nodeInteraction,
  libs,
} from '@decentralchain/decentralchain-transactions';
import {
  signBytes as dccSignBytes,
  publicKey as dccPublicKey,
  base58Decode as dccBase58Decode,
} from '@decentralchain/ts-lib-crypto';
import * as snarkjs from 'snarkjs';
import * as fs from 'fs';
import * as path from 'path';
import { fork, ChildProcess } from 'child_process';
import { createLogger } from '../utils/logger';
import { ValidatorConfig } from '../config';
import { SolanaDepositEvent } from '../watchers/solana-watcher';

// Re-export from ZK prover modules (paths relative to project root)
// These will be resolved at build time by the bundler
const logger = createLogger('ZkBridgeService');

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface CheckpointWindow {
  id: number;
  startTime: number;
  events: SolanaDepositEvent[];
  messageIds: Uint8Array[];
  closed: boolean;
  merkleRoot: Uint8Array | null;
  proposalId: number | null;
  activated: boolean;
  checkpointId: number | null;
}

export interface ZkServiceConfig {
  /** Contract B (ZK Verifier) address */
  zkVerifierContract: string;
  /** Bridge Core contract address (Contract A) */
  bridgeCoreContract: string;
  /** DCC node URL */
  nodeUrl: string;
  /** DCC chain ID char */
  chainId: string;
  /** Validator's DCC seed phrase */
  dccSeed: string;
  /** Validator node ID */
  nodeId: string;
  /** DCC API key */
  apiKey: string;
  /** Path to circom WASM */
  wasmPath: string;
  /** Path to proving zkey */
  zkeyPath: string;
  /** Path to verification key JSON */
  vkeyPath: string;
  /** Checkpoint window duration in ms (default: 60s) */
  checkpointWindowMs?: number;
  /** Max events per checkpoint (default: 100) */
  maxEventsPerCheckpoint?: number;
  /** Solana program ID */
  solanaProgramId: string;
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE ID COMPUTATION (mirrors zk/prover/src/message.ts)
// ═══════════════════════════════════════════════════════════════

const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';

function writeU32LE(buf: Uint8Array, value: number, offset: number): void {
  buf[offset]     = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, value: bigint, offset: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

function computeMessageId(
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

const TREE_DEPTH = 20;
const ZERO_LEAF = new Uint8Array(32); // 32 zero bytes

function keccak256Hash(data: Uint8Array): Uint8Array {
  const keccak256 = require('js-sha3').keccak256;
  const hash = keccak256(data);
  return new Uint8Array(hash.match(/.{2}/g).map((b: string) => parseInt(b, 16)));
}

function computeLeaf(messageId: Uint8Array): Uint8Array {
  // Domain-separated: keccak256(0x00 || messageId)
  const leafPreimage = new Uint8Array(33);
  leafPreimage[0] = 0x00;
  leafPreimage.set(messageId, 1);
  return keccak256Hash(leafPreimage);
}

function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  // Domain-separated: keccak256(0x01 || left || right)
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0] = 0x01;
  nodePreimage.set(left, 1);
  nodePreimage.set(right, 33);
  return keccak256Hash(nodePreimage);
}

function buildMerkleTree(messageIds: Uint8Array[]): {
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

function getMerkleProof(
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

function fieldElementToBytes(decStr: string): Uint8Array {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function serializeProofForRIDE(proof: {
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

function serializeInputsForRIDE(publicSignals: string[]): Uint8Array {
  const result = new Uint8Array(256);
  for (let i = 0; i < 8; i++) {
    result.set(fieldElementToBytes(publicSignals[i]), i * 32);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// BIT CONVERSION HELPERS (for circuit inputs)
// ═══════════════════════════════════════════════════════════════

function bytesToBitsLE(bytes: Uint8Array): string[] {
  const bits: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1).toString());
    }
  }
  return bits;
}

function numberToBitsLE(value: number | bigint, numBits: number): string[] {
  const bits: string[] = [];
  let v = BigInt(value);
  for (let i = 0; i < numBits; i++) {
    bits.push((v & 1n).toString());
    v >>= 1n;
  }
  return bits;
}

function hashToFieldElements(hash: Uint8Array): { lo: bigint; hi: bigint } {
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(clean.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

/** Decode a base58-encoded string to raw bytes, padded/truncated to targetLen */
function base58ToBytes(b58: string, targetLen: number): Uint8Array {
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

// ═══════════════════════════════════════════════════════════════
// ZK BRIDGE SERVICE
// ═══════════════════════════════════════════════════════════════

export class ZkBridgeService extends EventEmitter {
  private config: ZkServiceConfig;
  private currentWindow: CheckpointWindow | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  private checkpointWindows: Map<number, CheckpointWindow> = new Map();
  private nextWindowId = 0;
  private vkey: any = null;
  private running = false;

  // DCC signing
  private dccSigningSeed: string;
  private dccSigningPubKeyB58: string;

  constructor(config: ZkServiceConfig) {
    super();
    this.config = {
      ...config,
      checkpointWindowMs: config.checkpointWindowMs || 60_000,
      maxEventsPerCheckpoint: config.maxEventsPerCheckpoint || 100,
    };

    // Derive DCC signing key for checkpoint committee operations
    this.dccSigningSeed = `${config.dccSeed}:bridge-signer:${config.nodeId}`;
    this.dccSigningPubKeyB58 = dccPublicKey(this.dccSigningSeed);

    logger.info('ZK Bridge Service initialized', {
      zkVerifier: config.zkVerifierContract,
      bridgeCore: config.bridgeCoreContract,
      windowMs: this.config.checkpointWindowMs,
      maxEvents: this.config.maxEventsPerCheckpoint,
    });
  }

  /**
   * Start the ZK bridge service
   */
  async start(): Promise<void> {
    this.running = true;

    // Load verification key for local proof checks
    try {
      this.vkey = JSON.parse(fs.readFileSync(this.config.vkeyPath, 'utf-8'));
      logger.info('Verification key loaded');
    } catch (err) {
      logger.warn('Could not load verification key — local proof verification disabled');
    }

    // ── Startup Recovery Scan ──
    // Check for checkpoints that were activated but never had proofs generated.
    // This handles the case where ZK_PROOF_GENERATION_ENABLED was previously false
    // or where the node crashed between checkpoint activation and proof submission.
    const proofEnabled = (process.env.ZK_PROOF_GENERATION_ENABLED ?? 'true').toLowerCase();
    if (proofEnabled !== 'false' && proofEnabled !== '0') {
      try {
        await this.runStartupRecoveryScan();
      } catch (err: any) {
        logger.warn('Startup recovery scan failed (non-fatal)', { error: err.message });
      }
    }

    // Open first checkpoint window
    this.openNewWindow();

    logger.info('ZK Bridge Service started');
  }

  /**
   * Startup Recovery Scan — find checkpoints that were activated but never had
   * proofs generated. Rebuilds the checkpoint window from Solana data and
   * processes any unproved deposits.
   */
  private async runStartupRecoveryScan(): Promise<void> {
    logger.info('Running startup recovery scan for unproved checkpoints...');

    // Get the latest checkpoint ID from DCC
    const nextCidEntry = await nodeInteraction.accountDataByKey(
      'next_checkpoint_id',
      this.config.zkVerifierContract,
      this.config.nodeUrl,
    );
    const latestCid = ((nextCidEntry?.value as number) || 1) - 1;
    if (latestCid < 0) {
      logger.info('No checkpoints found — nothing to recover');
      return;
    }

    // Scan the last 10 checkpoints (or fewer if there aren't that many)
    const scanFrom = Math.max(0, latestCid - 10);
    let recoveredCount = 0;

    for (let cid = latestCid; cid >= scanFrom; cid--) {
      try {
        // Get checkpoint slot
        const slotEntry = await nodeInteraction.accountDataByKey(
          `checkpoint_${cid}_slot`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );
        if (!slotEntry) continue;
        const checkpointSlot = slotEntry.value as number;

        // Get checkpoint root
        const rootEntry = await nodeInteraction.accountDataByKey(
          `checkpoint_${cid}_root`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );
        if (!rootEntry) continue;
        const rawB64 = String(rootEntry.value).replace(/^base64:/, '');
        const rootBytes = Buffer.from(rawB64, 'base64');

        // Try to find the deposit that matches this checkpoint by scanning
        // recent Solana program transactions around this slot
        const { Connection, PublicKey: SolPubKey } = require('@solana/web3.js');
        const connection = new Connection(
          process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
          'confirmed',
        );
        const programId = new SolPubKey(this.config.solanaProgramId);

        // Get signatures around the checkpoint slot
        const sigs = await connection.getSignaturesForAddress(
          programId,
          { limit: 200 },
          'confirmed',
        );

        // Filter to signatures near the checkpoint slot (±5 slots for safety)
        const nearSigs = sigs.filter((s: any) => !s.err && Math.abs((s.slot || 0) - checkpointSlot) <= 5);

        for (const sigInfo of nearSigs) {
          try {
            const tx = await connection.getTransaction(sigInfo.signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta?.logMessages) continue;

            // Parse deposit events from transaction logs
            for (const log of tx.meta.logMessages) {
              if (!log.includes('Program data:')) continue;
              const dataStr = log.split('Program data: ')[1];
              if (!dataStr) continue;
              const data = Buffer.from(dataStr, 'base64');
              if (data.length < 212) continue; // 8 disc + 204 event data

              const transferId = bytesToHex(data.subarray(8, 40));
              const eventSlot = Number(data.readBigUInt64LE(152 + 8)); // offset past disc

              // Check if this deposit matches the checkpoint slot
              if (eventSlot !== checkpointSlot) continue;

              // Look up the deposit PDA to get full data
              const tidBytes = Buffer.from(transferId, 'hex');
              const [depositPda] = SolPubKey.findProgramAddressSync(
                [Buffer.from('deposit'), tidBytes],
                programId,
              );
              const recordData = await connection.getAccountInfo(depositPda, 'confirmed');
              if (!recordData) continue;

              // Read message ID from the deposit record
              const messageIdHex = bytesToHex(recordData.data.subarray(40, 72));

              // Check if already ZK-processed
              try {
                const zkProcessed = await nodeInteraction.accountDataByKey(
                  `zk_processed_${messageIdHex}`,
                  this.config.zkVerifierContract,
                  this.config.nodeUrl,
                );
                if (zkProcessed?.value === true) continue; // Already done
              } catch {}

              // Check if already committee-processed
              try {
                const processed = await nodeInteraction.accountDataByKey(
                  `processed_${transferId}`,
                  this.config.bridgeCoreContract,
                  this.config.nodeUrl,
                );
                if (processed?.value === true) continue; // Committee already handled it
              } catch {}

              // Found an unprocessed deposit! Reconstruct the event and checkpoint window
              const senderPk = new SolPubKey(recordData.data.subarray(72, 104));
              const recipientDccHex = bytesToHex(recordData.data.subarray(104, 136));
              const amount = recordData.data.readBigUInt64LE(136);
              const nonce = recordData.data.readBigUInt64LE(144);
              const slot = Number(recordData.data.readBigUInt64LE(152));
              const eventIndex = recordData.data.readUInt32LE(160);

              logger.info('Found unprocessed deposit during recovery scan', {
                transferId,
                checkpointId: cid,
                amount: amount.toString(),
                sender: senderPk.toBase58(),
                slot,
              });

              // Rebuild the deposit event
              const event: SolanaDepositEvent = {
                transferId,
                messageId: messageIdHex,
                sender: senderPk.toBase58(),
                recipientDcc: recipientDccHex,
                amount,
                nonce,
                slot,
                eventIndex,
                timestamp: Date.now(),
                srcChainId: 1,
                dstChainId: 2,
                chainId: 1,
                signature: sigInfo.signature,
                confirmations: 999, // Already finalized
              };

              // Rebuild the message ID and Merkle tree
              const senderBytes_r = base58ToBytes(event.sender, 32);
              const srcProgramId_r = base58ToBytes(this.config.solanaProgramId, 32);
              const recipBytes_r = hexToBytes(event.recipientDcc);
              const assetId_r = new Uint8Array(32);

              const messageIdComputed = computeMessageId(
                1, 2, srcProgramId_r,
                BigInt(slot), eventIndex,
                senderBytes_r, recipBytes_r,
                BigInt(amount), BigInt(nonce),
                assetId_r,
              );

              const messageIds = [messageIdComputed];
              const { root: computedRoot } = buildMerkleTree(messageIds);

              // Verify root matches the checkpoint
              if (!Buffer.from(computedRoot).equals(rootBytes)) {
                logger.warn('Computed root does not match checkpoint — skipping', {
                  transferId,
                  checkpointId: cid,
                  computedRoot: bytesToHex(computedRoot),
                  checkpointRoot: bytesToHex(rootBytes),
                });
                continue;
              }

              // Create a synthetic checkpoint window for proof generation
              const recoveryWindow: CheckpointWindow = {
                id: 900000 + cid, // Use high ID to avoid conflicts
                startTime: Date.now(),
                events: [event],
                messageIds: [messageIdComputed],
                closed: true,
                merkleRoot: computedRoot,
                proposalId: null,
                activated: true,
                checkpointId: cid,
              };

              logger.info('Generating recovery proof for checkpoint', {
                transferId,
                checkpointId: cid,
                amount: amount.toString(),
              });

              await this.generateAndSubmitProofs(recoveryWindow);
              recoveredCount++;
            }
          } catch (err: any) {
            logger.debug('Error processing tx during recovery scan', { error: err.message });
          }
        }
      } catch (err: any) {
        logger.debug('Error scanning checkpoint during recovery', { cid, error: err.message });
      }
    }

    if (recoveredCount > 0) {
      logger.info(`Startup recovery complete — recovered ${recoveredCount} deposit(s)`);
    } else {
      logger.info('Startup recovery scan complete — no unprocessed deposits found');
    }
  }

  /**
   * Stop the ZK bridge service
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    logger.info('ZK Bridge Service stopped');
  }

  /**
   * Run Groth16 proof generation in a child process via fork().
   * This keeps the main event loop free for health checks, P2P, etc.
   * The child process gets its own V8 heap with --max-old-space-size=5120.
   * Using fork() instead of worker_threads because snarkjs internally uses
   * worker_threads and conflicts when nested inside another worker.
   */
  private runProofWorker(
    circuitInput: Record<string, any>,
    wasmPath: string,
    zkeyPath: string,
  ): Promise<{ proof: any; publicSignals: string[] }> {
    return new Promise((resolve, reject) => {
      // Resolve worker path: in Docker it's /app/proof-worker.js,
      // in dev it's relative to the project root
      let workerPath = path.resolve('/app/proof-worker.js');
      if (!fs.existsSync(workerPath)) {
        workerPath = path.resolve(__dirname, '../../proof-worker.js');
      }
      if (!fs.existsSync(workerPath)) {
        workerPath = path.resolve(process.cwd(), 'proof-worker.js');
      }

      logger.info('Spawning proof-worker child process', { workerPath });
      const child: ChildProcess = fork(workerPath, [], {
        execArgv: ['--max-old-space-size=6144'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      let settled = false;

      child.on('message', (msg: any) => {
        if (msg.ready) {
          // Worker is ready, send the work
          child.send({ circuitInput, wasmPath, zkeyPath });
          return;
        }
        if (settled) return;
        settled = true;
        if (msg.error) {
          reject(new Error(`Worker proof generation failed: ${msg.error}`));
        } else {
          resolve({ proof: msg.proof, publicSignals: msg.publicSignals });
        }
        child.kill();
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Worker process error: ${err.message}`));
      });

      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Worker process exited with code ${code}`));
      });
    });
  }

  /**
   * Add a deposit event to the current checkpoint window.
   * Called from the main validator loop when a deposit is finalized.
   */
  addDeposit(event: SolanaDepositEvent): void {
    if (!this.running) return;

    // Open new window if needed
    if (!this.currentWindow || this.currentWindow.closed) {
      this.openNewWindow();
    }

    const window = this.currentWindow!;

    // Compute message_id for this deposit
    // sender is base58 (Solana pubkey), programId is base58, recipientDcc is hex
    const senderBytes = base58ToBytes(event.sender, 32);
    const recipientBytes = hexToBytes(event.recipientDcc);
    const srcProgramId = base58ToBytes(this.config.solanaProgramId, 32);
    const assetId = new Uint8Array(32); // native SOL = all zeros for now

    const messageId = computeMessageId(
      1,  // solChainId
      2,  // dccChainId
      srcProgramId,
      BigInt(event.slot),
      event.eventIndex || 0,
      senderBytes,
      recipientBytes,
      BigInt(event.amount),
      BigInt(event.nonce || 0),
      assetId,
    );

    window.events.push(event);
    window.messageIds.push(messageId);

    logger.info('Deposit added to checkpoint window', {
      windowId: window.id,
      eventCount: window.events.length,
      transferId: event.transferId,
      messageId: bytesToHex(messageId),
    });

    // Notify API: Solana confirmed → validators forming checkpoint
    this.notifyApiStatus(event.transferId, 'awaiting_consensus');

    // Close window if max events reached
    if (window.events.length >= (this.config.maxEventsPerCheckpoint || 100)) {
      this.closeWindow(window);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PRIVATE — Checkpoint Window Management
  // ═══════════════════════════════════════════════════════════

  private openNewWindow(): void {
    const window: CheckpointWindow = {
      id: this.nextWindowId++,
      startTime: Date.now(),
      events: [],
      messageIds: [],
      closed: false,
      merkleRoot: null,
      proposalId: null,
      activated: false,
      checkpointId: null,
    };

    this.currentWindow = window;
    this.checkpointWindows.set(window.id, window);

    // Set timer to close window
    this.windowTimer = setTimeout(() => {
      if (window.events.length > 0) {
        this.closeWindow(window);
      } else {
        // Empty window, just open a new one
        this.openNewWindow();
      }
    }, this.config.checkpointWindowMs || 60_000);

    logger.debug('Opened checkpoint window', { windowId: window.id });
  }

  private async closeWindow(window: CheckpointWindow): Promise<void> {
    if (window.closed) return;
    window.closed = true;

    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }

    if (window.events.length === 0) {
      logger.debug('Closing empty window', { windowId: window.id });
      this.openNewWindow();
      return;
    }

    logger.info('Closing checkpoint window', {
      windowId: window.id,
      eventCount: window.events.length,
    });

    try {
      // Build Merkle tree
      const { root } = buildMerkleTree(window.messageIds);
      window.merkleRoot = root;

      logger.info('Merkle tree built', {
        windowId: window.id,
        root: bytesToHex(root),
        leaves: window.messageIds.length,
      });

      // Stagger proposal timing by nodeId to avoid race conditions.
      // Validators with higher IDs wait longer, giving the first proposer
      // time to get mined before others check for existing proposals.
      const nodeIndex = parseInt(this.config.nodeId.replace(/\D/g, '') || '1', 10);
      const staggerMs = (nodeIndex - 1) * 12_000; // 0s, 12s, 24s
      if (staggerMs > 0) {
        logger.info('Staggering checkpoint proposal', { staggerMs, nodeIndex });
        await new Promise(r => setTimeout(r, staggerMs));
      }

      // Try to find an existing proposal with matching root, or create one
      await this.findOrCreateCheckpointProposal(window);

      // After proposal exists, poll for activation (other validators approve)
      this.pollCheckpointActivation(window);

    } catch (err: any) {
      logger.error('Failed to close checkpoint window', {
        windowId: window.id,
        error: err.message,
      });
    }

    // Open next window
    if (this.running) {
      this.openNewWindow();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PRIVATE — Checkpoint Submission
  // ═══════════════════════════════════════════════════════════

  /**
   * Find an existing matching proposal to approve, or create a new one.
   * This coordinated approach ensures all validators converge on one proposal.
   */
  private async findOrCreateCheckpointProposal(window: CheckpointWindow): Promise<void> {
    if (!window.merkleRoot) throw new Error('No Merkle root');

    const rootHex = bytesToHex(window.merkleRoot);
    const rootBase64 = Buffer.from(window.merkleRoot).toString('base64');
    const maxSlot = Math.max(...window.events.map(e => e.slot));

    // Check if there's already a pending proposal with a matching root
    const nextProposalId = await nodeInteraction.accountDataByKey(
      'next_proposal_id',
      this.config.zkVerifierContract,
      this.config.nodeUrl,
    );
    const nextId = (nextProposalId?.value as number) || 0;

    // Scan recent proposals for a match
    for (let pid = Math.max(0, nextId - 5); pid < nextId; pid++) {
      try {
        const proposalRoot = await nodeInteraction.accountDataByKey(
          `proposal_${pid}_root`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );
        const proposalFinalized = await nodeInteraction.accountDataByKey(
          `proposal_${pid}_finalized`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );

        if (!proposalRoot || proposalFinalized?.value === true) continue;

        // Compare roots — DCC API returns binary as "base64:XXXX", strip prefix
        const rawValue = (proposalRoot.value as string).replace(/^base64:/, '');
        const storedRoot = Buffer.from(rawValue, 'base64');
        if (Buffer.from(window.merkleRoot).equals(storedRoot)) {
          logger.info('Found existing proposal with matching root', {
            proposalId: pid,
            root: rootHex,
          });
          window.proposalId = pid;

          // Try to approve it (will fail harmlessly if already approved)
          await this.approveCheckpoint(window);
          return;
        }
      } catch {
        // Proposal doesn't exist or error reading — skip
      }
    }

    // No matching proposal found — create one
    logger.info('No matching proposal found, submitting new checkpoint proposal', {
      windowId: window.id,
      slot: maxSlot,
      root: rootHex,
    });

    const { privateKey, publicKey: pubKeyFn } = libs.crypto;
    const SIGNER = { privateKey: privateKey(this.dccSigningSeed) };
    const signerPubKey = pubKeyFn(this.dccSigningSeed);

    const tx = invokeScript(
      {
        dApp: this.config.zkVerifierContract,
        call: {
          function: 'proposeCheckpoint',
          args: [
            { type: 'integer', value: maxSlot },
            { type: 'binary', value: `base64:${rootBase64}` },
          ],
        },
        payment: [],
        fee: 900000,
        chainId: this.config.chainId,
        senderPublicKey: signerPubKey,
      },
      SIGNER,
    );

    const result = await this.broadcastWithRetry(tx);
    logger.info('Checkpoint proposal submitted', { txId: result.id });

    // Get the assigned proposal ID
    const updatedNextId = await nodeInteraction.accountDataByKey(
      'next_proposal_id',
      this.config.zkVerifierContract,
      this.config.nodeUrl,
    );
    window.proposalId = ((updatedNextId?.value as number) || 1) - 1;
    logger.info('Proposal ID assigned', { proposalId: window.proposalId });
    // Note: proposeCheckpoint automatically counts as the first approval
  }

  private async approveCheckpoint(window: CheckpointWindow): Promise<void> {
    if (window.proposalId === null) return;

    // Use the validator's DCC signing key (committee member key)
    const { privateKey, publicKey: pubKeyFn } = libs.crypto;
    const SIGNER = { privateKey: privateKey(this.dccSigningSeed) };
    const signerPubKey = pubKeyFn(this.dccSigningSeed);

    logger.info('Approving checkpoint proposal', {
      windowId: window.id,
      proposalId: window.proposalId,
    });

    try {
      const tx = invokeScript(
        {
          dApp: this.config.zkVerifierContract,
          call: {
            function: 'approveCheckpoint',
            args: [
              { type: 'integer', value: window.proposalId },
            ],
          },
          payment: [],
          fee: 900000,
          chainId: this.config.chainId,
          senderPublicKey: signerPubKey,
        },
        SIGNER,
      );

      const result = await this.broadcastWithRetry(tx);
      logger.info('Checkpoint approved', { txId: result.id });
    } catch (err: any) {
      // "Already approved" is expected if this validator proposed or already approved
      if (err.message?.includes('Already approved')) {
        logger.debug('Already approved checkpoint proposal', { proposalId: window.proposalId });
      } else {
        logger.error('Failed to approve checkpoint', {
          proposalId: window.proposalId,
          error: err.message,
        });
      }
    }
  }

  private async pollCheckpointActivation(window: CheckpointWindow): Promise<void> {
    if (window.proposalId === null) return;

    const maxAttempts = 30;
    const rootHex = bytesToHex(window.merkleRoot!);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 10_000)); // 10s poll interval

      if (!this.running) return;

      try {
        // 1) Check if OUR proposal is finalized
        const finalized = await nodeInteraction.accountDataByKey(
          `proposal_${window.proposalId}_finalized`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );

        if (finalized?.value === true) {
          const nextCheckpointId = await nodeInteraction.accountDataByKey(
            'next_checkpoint_id',
            this.config.zkVerifierContract,
            this.config.nodeUrl,
          );
          window.checkpointId = ((nextCheckpointId?.value as number) || 1) - 1;
          window.activated = true;

          logger.info('Checkpoint activated!', {
            windowId: window.id,
            proposalId: window.proposalId,
            checkpointId: window.checkpointId,
          });

          await this.generateAndSubmitProofs(window);
          return;
        }

        // 2) Check if ANY checkpoint has our root (another validator's proposal may have been activated)
        const nextCheckpointId = await nodeInteraction.accountDataByKey(
          'next_checkpoint_id',
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );
        const latestCheckpointId = ((nextCheckpointId?.value as number) || 1) - 1;

        // Scan the last few checkpoint IDs for our root
        for (let cid = latestCheckpointId; cid >= Math.max(0, latestCheckpointId - 3); cid--) {
          const storedRootEntry = await nodeInteraction.accountDataByKey(
            `checkpoint_${cid}_root`,
            this.config.zkVerifierContract,
            this.config.nodeUrl,
          );
          if (storedRootEntry) {
            // DCC returns binary as "base64:XXXX" — decode and compare
            const rawB64 = (storedRootEntry.value as string).replace(/^base64:/, '');
            const storedRootBytes = Buffer.from(rawB64, 'base64');
            if (Buffer.from(window.merkleRoot!).equals(storedRootBytes)) {
              window.checkpointId = cid;
              window.activated = true;

              logger.info('Checkpoint activated (via another proposal)!', {
                windowId: window.id,
                proposalId: window.proposalId,
                checkpointId: cid,
              });

              await this.generateAndSubmitProofs(window);
              return;
            }
          }
        }
      } catch (err: any) {
        logger.warn('Error polling checkpoint status', {
          proposalId: window.proposalId,
          error: err.message,
        });
      }
    }

    logger.warn('Checkpoint activation timed out — may need more committee approvals', {
      windowId: window.id,
      proposalId: window.proposalId,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PRIVATE — Proof Generation & Submission
  // ═══════════════════════════════════════════════════════════

  private async generateAndSubmitProofs(window: CheckpointWindow): Promise<void> {
    if (!window.merkleRoot || window.checkpointId === null) return;

    // Check if this validator is designated as a proof generator.
    // In memory-constrained environments, only one validator should generate proofs
    // while others just participate in checkpoint consensus.
    const proofEnabled = (process.env.ZK_PROOF_GENERATION_ENABLED ?? 'true').toLowerCase();
    if (proofEnabled === 'false' || proofEnabled === '0') {
      logger.info('ZK proof generation disabled on this node — checkpoint consensus only', {
        windowId: window.id,
        checkpointId: window.checkpointId,
      });
      return;
    }

    logger.info('Generating ZK proofs for checkpoint', {
      windowId: window.id,
      checkpointId: window.checkpointId,
      eventCount: window.events.length,
    });

    for (let i = 0; i < window.events.length; i++) {
      const event = window.events[i];

      // Check if already minted via committee — we still generate proof but don't submit verifyAndMint
      let alreadyCommitteeMinted = false;
      try {
        const processed = await nodeInteraction.accountDataByKey(
          `processed_${event.transferId}`,
          this.config.bridgeCoreContract,
          this.config.nodeUrl,
        );
        if (processed?.value === true) {
          alreadyCommitteeMinted = true;
          logger.info('Deposit already minted via committee — will generate ZK proof for retroactive verification only', {
            transferId: event.transferId,
          });
        }
      } catch {}

      try {
        // Check if already ZK-processed
        const messageIdHex = bytesToHex(window.messageIds[i]);
        const zkProcessed = await nodeInteraction.accountDataByKey(
          `zk_processed_${messageIdHex}`,
          this.config.zkVerifierContract,
          this.config.nodeUrl,
        );
        if (zkProcessed?.value === true) {
          logger.info('Deposit already ZK-processed — skipping', {
            transferId: event.transferId,
          });
          continue;
        }
      } catch {}

      try {
        await this.generateAndSubmitSingleProof(window, i, alreadyCommitteeMinted);
      } catch (err: any) {
        logger.error('Failed to generate/submit ZK proof', {
          eventIndex: i,
          transferId: event.transferId,
          error: err.message,
        });
      }
    }
  }

  private async generateAndSubmitSingleProof(
    window: CheckpointWindow,
    eventIdx: number,
    alreadyCommitteeMinted: boolean = false,
  ): Promise<void> {
    const event = window.events[eventIdx];
    const messageId = window.messageIds[eventIdx];

    logger.info('Generating Groth16 proof', {
      transferId: event.transferId,
      eventIdx,
      messageId: bytesToHex(messageId),
    });

    // Notify API: checkpoint activated → ZK proof generating
    this.notifyApiStatus(event.transferId, 'proving');

    // Get Merkle proof for this event
    const merkleProof = getMerkleProof(window.messageIds, eventIdx);

    // Build circuit inputs
    // sender is base58 (Solana pubkey) → decode to 32 raw bytes
    const senderBytes = base58ToBytes(event.sender, 32);
    const recipientBytes = hexToBytes(event.recipientDcc);
    // solanaProgramId is base58 → decode to 32 raw bytes
    const srcProgramId = base58ToBytes(this.config.solanaProgramId, 32);
    const assetId = new Uint8Array(32);
    const domainSepBytes = new TextEncoder().encode(DOMAIN_SEP);

    const rootFE = hashToFieldElements(window.merkleRoot!);
    const msgIdFE = hashToFieldElements(messageId);
    const recipFE = hashToFieldElements(recipientBytes);

    const circuitInput = {
      // Public inputs — 8 field elements
      checkpoint_root_lo: rootFE.lo.toString(),
      checkpoint_root_hi: rootFE.hi.toString(),
      message_id_lo: msgIdFE.lo.toString(),
      message_id_hi: msgIdFE.hi.toString(),
      amount: event.amount.toString(),
      recipient_lo: recipFE.lo.toString(),
      recipient_hi: recipFE.hi.toString(),
      version: '1',

      // Private inputs (bit arrays)
      domain_sep: bytesToBitsLE(domainSepBytes),
      src_program_id: bytesToBitsLE(srcProgramId),
      slot_bits: numberToBitsLE(event.slot, 64),
      event_index_bits: numberToBitsLE(event.eventIndex || 0, 32),
      sender: bytesToBitsLE(senderBytes),
      nonce_bits: numberToBitsLE(event.nonce || 0, 64),
      asset_id: bytesToBitsLE(assetId),
      src_chain_id: numberToBitsLE(1, 32),
      dst_chain_id: numberToBitsLE(2, 32),
      siblings: merkleProof.siblings.map(s => bytesToBitsLE(s)),
      path_indices: merkleProof.pathIndices,
    };

    // Generate Groth16 proof in a worker thread so the event loop
    // stays responsive for health checks & P2P heartbeats.
    const startTime = Date.now();
    const { proof, publicSignals } = await this.runProofWorker(
      circuitInput,
      this.config.wasmPath,
      this.config.zkeyPath,
    );
    const proofTime = Date.now() - startTime;

    logger.info('Groth16 proof generated', {
      transferId: event.transferId,
      proofTimeMs: proofTime,
    });

    // Verify locally before submitting
    if (this.vkey) {
      // Notify API: proof done → submitting for on-chain verification
      this.notifyApiStatus(event.transferId, 'verifying');

      const valid = await snarkjs.groth16.verify(this.vkey, publicSignals, proof);
      if (!valid) {
        logger.error('ZK PROOF VERIFICATION FAILED — this indicates a circuit bug or data mismatch', {
          transferId: event.transferId,
        });
        this.emit('zk_verification_failed', { transferId: event.transferId });
        throw new Error('Local proof verification failed — circuit bug');
      }
      logger.info('Local ZK proof verification PASSED', {
        transferId: event.transferId,
        proofTimeMs: proofTime,
      });
    }

    if (alreadyCommitteeMinted) {
      // Deposit was already minted by committee — proof generated & verified locally
      // This retroactive verification proves the committee mint was legitimate
      logger.info('Retroactive ZK verification complete — committee mint validated by Groth16 proof', {
        transferId: event.transferId,
        proofTimeMs: proofTime,
      });
      this.emit('zk_retroactive_verified', {
        transferId: event.transferId,
        proofTimeMs: proofTime,
      });
      return; // Don't submit verifyAndMint — already minted
    }

    // Serialize proof and inputs for RIDE
    const proofBytes = serializeProofForRIDE(proof);
    const inputsBytes = serializeInputsForRIDE(publicSignals);

    // Submit verifyAndMint to Contract B
    await this.submitVerifyAndMint(
      event,
      window,
      eventIdx,
      proofBytes,
      inputsBytes,
      messageId,
    );
  }

  private async submitVerifyAndMint(
    event: SolanaDepositEvent,
    window: CheckpointWindow,
    eventIdx: number,
    proofBytes: Uint8Array,
    inputsBytes: Uint8Array,
    messageId: Uint8Array,
  ): Promise<void> {
    const proofBase64 = Buffer.from(proofBytes).toString('base64');
    const inputsBase64 = Buffer.from(inputsBytes).toString('base64');

    // Resolve DCC recipient address from hex
    const recipientHex = event.recipientDcc;
    const recipientRawBytes = Buffer.from(recipientHex, 'hex');
    let lastNonZero = recipientRawBytes.length - 1;
    while (lastNonZero > 0 && recipientRawBytes[lastNonZero] === 0) lastNonZero--;
    const recipientTrimmed = recipientRawBytes.subarray(0, lastNonZero + 1);
    const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function toBase58(buf: Buffer): string {
      let num = BigInt('0x' + buf.toString('hex'));
      let result = '';
      while (num > 0n) {
        result = bs58Chars[Number(num % 58n)] + result;
        num = num / 58n;
      }
      for (let i = 0; i < buf.length && buf[i] === 0; i++) {
        result = '1' + result;
      }
      return result || '1';
    }
    const recipientAddress = toBase58(Buffer.from(recipientTrimmed));

    // Encode srcProgramId as 32 bytes (base58 → raw bytes → base64)
    const srcProgramIdBytes = base58ToBytes(this.config.solanaProgramId, 32);
    const srcProgramIdBase64 = Buffer.from(srcProgramIdBytes).toString('base64');

    // Encode sender as 32 bytes (base58 Solana pubkey → raw bytes → base64)
    const senderBytes = base58ToBytes(event.sender, 32);
    const senderBase64 = Buffer.from(senderBytes).toString('base64');

    // Encode recipient as 32 bytes (from hex-encoded DCC recipient)
    const recipientPaddedHex = event.recipientDcc.padEnd(64, '0');
    const recipientBytesBase64 = Buffer.from(recipientPaddedHex, 'hex').toString('base64');

    // Encode assetId as 32 zero bytes (native SOL placeholder)
    const assetIdBase64 = Buffer.alloc(32).toString('base64');

    // Use Contract B (nonce 2) signer
    const { seedWithNonce, privateKey, publicKey: pubKeyFn } = libs.crypto;
    const B_SEED = seedWithNonce(this.config.dccSeed, 2);
    const B_SIGNER = { privateKey: privateKey(B_SEED) };
    const bPubKey = pubKeyFn(B_SEED);

    // ── FEE NOTE (ZK Path): Cannot deduct fee here ──
    // Strategy A in RIDE Contract B cross-validates event.amount against the
    // ZK proof's public signals.  Passing (amount - fee) would cause a
    // "amount mismatch" revert.  Fee deduction on the ZK path requires a
    // RIDE contract update to: verify full amount from proof, then mint
    // (amount - fee).  Until then, ZK-path deposits are fee-exempt.
    // TODO: Update RIDE Contract B verifyAndMint to deduct fee post-verify.

    logger.info('Submitting verifyAndMint to Contract B', {
      transferId: event.transferId,
      recipient: recipientAddress,
      amount: event.amount,
      checkpointId: window.checkpointId,
      feeNote: 'ZK path — fee not deducted (requires RIDE contract update)',
    });

    const tx = invokeScript(
      {
        dApp: this.config.zkVerifierContract,
        call: {
          function: 'verifyAndMint',
          args: [
            { type: 'binary', value: `base64:${proofBase64}` },
            { type: 'binary', value: `base64:${inputsBase64}` },
            { type: 'integer', value: window.checkpointId! },
            { type: 'integer', value: 1 },  // srcChainId (Solana)
            { type: 'integer', value: 2 },  // dstChainId (DCC)
            { type: 'binary', value: `base64:${srcProgramIdBase64}` },
            { type: 'integer', value: event.slot },
            { type: 'integer', value: event.eventIndex || 0 },
            { type: 'binary', value: `base64:${senderBase64}` },
            { type: 'binary', value: `base64:${recipientBytesBase64}` },
            { type: 'integer', value: Number(event.amount) },  // Full amount — fee deduction requires RIDE update
            { type: 'integer', value: Number(event.nonce || 0) },
            { type: 'binary', value: `base64:${assetIdBase64}` },
            { type: 'string', value: recipientAddress },
          ],
        },
        payment: [],
        fee: 1800000, // Higher fee for groth16Verify + invoke cross-contract call
        chainId: this.config.chainId,
        senderPublicKey: bPubKey,
      },
      B_SIGNER,
    );

    const result = await this.broadcastWithRetry(tx);

    logger.info('ZK verifyAndMint submitted successfully!', {
      txId: result.id,
      transferId: event.transferId,
      recipient: recipientAddress,
      amount: event.amount,
    });

    this.emit('zk_mint_success', {
      transferId: event.transferId,
      txId: result.id,
      recipient: recipientAddress,
      amount: event.amount,
    });

    // Notify API so frontend status polling picks up completion
    try {
      const apiUrl = process.env.API_URL || 'http://api:3000';
      await fetch(`${apiUrl}/api/v1/transfer/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId: event.transferId,
          sender: event.sender,
          recipient: recipientAddress,
          amount: String(event.amount),
          direction: 'sol_to_dcc',
          sourceTxHash: event.signature || '',
        }),
      }).catch(() => {});
      await fetch(`${apiUrl}/api/v1/transfer/notify-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId: event.transferId,
          status: 'completed',
          destTxHash: result.id,
        }),
      }).catch(() => {});
    } catch {
      // Non-critical — frontend will eventually detect via on-chain check
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PRIVATE — Broadcast Helper
  // ═══════════════════════════════════════════════════════════

  /**
   * Fire-and-forget API status notification.
   * Updates the transfer in the API DB and pushes to SSE clients so the
   * frontend progress tracker advances to the correct step in real time.
   */
  private notifyApiStatus(transferId: string, status: string): void {
    const apiUrl = process.env.API_URL || 'http://api:3000';
    fetch(`${apiUrl}/api/v1/transfer/notify-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, status }),
    }).catch(() => {}); // Non-critical
  }

  private async broadcastWithRetry(tx: any, maxRetries = 3): Promise<{ id: string }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await broadcast(tx as any, this.config.nodeUrl);
        // Wait for confirmation
        await this.waitForTx(result.id);
        return result;
      } catch (err: any) {
        lastError = err;
        logger.warn(`Broadcast attempt ${attempt}/${maxRetries} failed`, {
          error: err.message,
        });
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }
    }

    throw lastError || new Error('Broadcast failed after all retries');
  }

  private async waitForTx(txId: string, attempts = 30): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(`${this.config.nodeUrl}/transactions/info/${txId}`);
        const d = await r.json();
        if (d.id) return;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`Tx ${txId} not confirmed after ${attempts * 5}s`);
  }
}
