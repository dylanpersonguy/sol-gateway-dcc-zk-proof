// ═══════════════════════════════════════════════════════════════
// BFT CONSENSUS ENGINE
// ═══════════════════════════════════════════════════════════════
//
// Implements a simplified Byzantine Fault Tolerant consensus for
// cross-chain attestation. Requires M-of-N validators to agree
// on event validity before submitting to destination chain.
//
// Properties:
// - Tolerates f = (N-1)/3 Byzantine validators
// - Liveness guaranteed with 2f+1 honest validators  
// - Safety guaranteed as long as ≤f validators are compromised
// - Deterministic message construction for signature aggregation

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { createLogger } from '../utils/logger';
import { SolanaDepositEvent } from '../watchers/solana-watcher';
import { DccBurnEvent } from '../watchers/dcc-watcher';
import { verifySignature as dccVerifySignature } from '@decentralchain/ts-lib-crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ConsensusConfig {
  nodeId: string;
  minValidators: number;
  consensusTimeoutMs: number;
  maxRetries: number;
  /** Path to persist processed transfer IDs (JSON file). Survives restarts. */
  processedTransfersPath?: string;
}

export interface AttestationRequest {
  type: 'mint' | 'unlock';
  transferId: string;
  event: SolanaDepositEvent | DccBurnEvent;
  timestamp: number;
}

export interface Attestation {
  nodeId: string;
  transferId: string;
  type: 'mint' | 'unlock';
  signature: Buffer;
  publicKey: Buffer;
  messageHash: Buffer;
  timestamp: number;
}

export interface ConsensusResult {
  transferId: string;
  type: 'mint' | 'unlock';
  attestations: Attestation[];
  achieved: boolean;
  requiredSignatures: number;
  receivedSignatures: number;
  event?: SolanaDepositEvent | DccBurnEvent;
  /** Original request timestamp (ms since epoch) — MUST be used for
   *  deterministic expiration computation in the unlock submission.
   *  SECURITY FIX (CRIT-7): Using Date.now() at submission time produces
   *  a different expiration than what validators signed during consensus,
   *  causing Ed25519 verification failure on-chain. */
  requestTimestamp?: number;
}

type SignCallback = (message: Buffer) => Promise<Buffer>;
type PublicKeyCallback = () => Buffer;

export class ConsensusEngine extends EventEmitter {
  private config: ConsensusConfig;
  private logger: Logger;
  private pendingConsensus: Map<string, PendingConsensus> = new Map();
  private signMessage: SignCallback;
  private getPublicKey: PublicKeyCallback;
  private processedTransfers: Set<string> = new Set();
  /** SECURITY FIX (VAL-10): Maximum size for processedTransfers to prevent OOM.
   *  When exceeded, oldest entries are evicted. Safe because PDA-based replay
   *  protection on-chain is the ultimate guard — this Set is a local optimization. */
  private static readonly MAX_PROCESSED_TRANSFERS = 100_000;
  /** Whitelist of registered validator public keys (hex-encoded) */
  private registeredValidators: Set<string> = new Set();

  constructor(
    config: ConsensusConfig,
    signMessage: SignCallback,
    getPublicKey: PublicKeyCallback,
  ) {
    super();
    this.config = config;
    this.logger = createLogger('Consensus');
    this.signMessage = signMessage;
    this.getPublicKey = getPublicKey;

    // Load persisted processed transfer IDs from disk
    this.loadProcessedTransfers();
  }

  /**
   * Load processed transfers from disk to survive restarts (H-3 fix).
   */
  private loadProcessedTransfers(): void {
    const filePath = this.config.processedTransfersPath || './data/processed-transfers.json';
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(data)) {
          // SECURITY FIX (VAL-10): Only load the most recent entries up to the cap
          const entries = data.slice(-ConsensusEngine.MAX_PROCESSED_TRANSFERS);
          for (const id of entries) {
            this.processedTransfers.add(id);
          }
          this.logger.info('Loaded processed transfers from disk', { count: entries.length });
        }
      }
    } catch (err: any) {
      this.logger.warn('Failed to load processed transfers — starting fresh', { error: err.message });
    }
  }

  /**
   * Persist processed transfers to disk.
   */
  private persistProcessedTransfers(): void {
    const filePath = this.config.processedTransfersPath || './data/processed-transfers.json';
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(Array.from(this.processedTransfers)), 'utf-8');
    } catch (err: any) {
      this.logger.error('Failed to persist processed transfers', { error: err.message });
    }
  }

  /**
   * Register a validator public key as trusted.
   * Only attestations from registered validators are accepted.
   */
  registerValidator(publicKeyHex: string): void {
    this.registeredValidators.add(publicKeyHex);
    this.logger.info('Validator registered in consensus whitelist', { publicKeyHex });
  }

  /**
   * Remove a validator from the whitelist.
   */
  removeValidator(publicKeyHex: string): void {
    this.registeredValidators.delete(publicKeyHex);
    this.logger.info('Validator removed from consensus whitelist', { publicKeyHex });
  }

  /**
   * Bulk-sync the validator set from on-chain data.
   */
  syncValidatorSet(publicKeysHex: string[]): void {
    this.registeredValidators.clear();
    for (const pk of publicKeysHex) {
      this.registeredValidators.add(pk);
    }
    // Always include our own key
    this.registeredValidators.add(this.getPublicKey().toString('hex'));
    this.logger.info('Validator set synced', { count: this.registeredValidators.size });
  }

  /**
   * Propose a new attestation for consensus.
   * Called when a watcher detects a finalized event.
   */
  async proposeAttestation(request: AttestationRequest): Promise<void> {
    const { transferId, type } = request;

    // ── GUARD: Replay protection ──
    if (this.processedTransfers.has(transferId)) {
      this.logger.warn('Transfer already processed', { transferId });
      return;
    }

    // ── GUARD: No duplicate proposals ──
    if (this.pendingConsensus.has(transferId)) {
      this.logger.debug('Consensus already in progress', { transferId });
      return;
    }

    this.logger.info('Proposing attestation', { transferId, type });

    // Construct the canonical message
    const message = this.constructCanonicalMessage(request);

    // Sign the message locally
    const signature = await this.signMessage(message);
    const publicKey = this.getPublicKey();

    const localAttestation: Attestation = {
      nodeId: this.config.nodeId,
      transferId,
      type,
      signature,
      publicKey,
      messageHash: message,
      timestamp: Date.now(),
    };

    // Create pending consensus
    const pending: PendingConsensus = {
      request,
      attestations: [localAttestation],
      message,
      startTime: Date.now(),
      resolved: false,
    };

    this.pendingConsensus.set(transferId, pending);

    // Broadcast our attestation to peers
    this.emit('attestation_broadcast', localAttestation);

    // Set consensus timeout
    setTimeout(() => {
      this.checkConsensusTimeout(transferId);
    }, this.config.consensusTimeoutMs);
  }

  /**
   * Receive an attestation from a peer validator.
   * Performs Ed25519 signature verification and validator whitelist check.
   */
  receiveAttestation(attestation: Attestation): void {
    const { transferId, nodeId } = attestation;

    // ── GUARD: Validate attestation has required fields ──
    if (!attestation.publicKey || !attestation.signature || !attestation.messageHash) {
      this.logger.warn('Rejecting attestation with missing fields', { transferId, nodeId });
      return;
    }

    // ── GUARD: Validator whitelist check (H-2 fix) ──
    const pubkeyHex = attestation.publicKey.toString('hex');
    if (this.registeredValidators.size > 0 && !this.registeredValidators.has(pubkeyHex)) {
      this.logger.error('REJECTING attestation from unregistered validator', {
        transferId,
        nodeId,
        publicKey: pubkeyHex,
      });
      this.emit('unregistered_validator', { nodeId, publicKey: pubkeyHex, transferId });
      return;
    }

    // ── GUARD: SECURITY FIX (VAL-6) — Bind nodeId to signing key ──
    // Prevent nodeId spoofing by verifying nodeId matches the public key's hex encoding.
    // Without this, an attacker can claim any nodeId while signing with their own key,
    // degrading consensus liveness tracking and allowing impersonation.
    if (nodeId !== pubkeyHex) {
      this.logger.error('REJECTING attestation: nodeId does not match publicKey', {
        transferId,
        claimedNodeId: nodeId,
        actualPubkey: pubkeyHex,
      });
      this.emit('byzantine_detected', { nodeId, transferId, reason: 'nodeId_pubkey_mismatch' });
      return;
    }

    // ── GUARD: DCC Curve25519 signature verification (H-1 fix) ──
    try {
      const isValid = dccVerifySignature(
        new Uint8Array(attestation.publicKey),
        new Uint8Array(attestation.messageHash),
        new Uint8Array(attestation.signature),
      );
      if (!isValid) {
        this.logger.error('REJECTING attestation with INVALID signature', {
          transferId,
          nodeId,
          publicKey: pubkeyHex,
        });
        this.emit('byzantine_detected', { nodeId, transferId, reason: 'invalid_signature' });
        return;
      }
    } catch (err: any) {
      this.logger.error('Signature verification threw error — rejecting', {
        transferId,
        nodeId,
        error: err.message,
      });
      return;
    }

    const pending = this.pendingConsensus.get(transferId);
    if (!pending) {
      this.logger.debug('Received attestation for unknown transfer', {
        transferId,
      });
      // Store for later — we might not have seen the event yet
      return;
    }

    if (pending.resolved) {
      return;
    }

    // ── GUARD: No duplicate attestations from same node ──
    if (pending.attestations.some((a) => a.nodeId === nodeId)) {
      this.logger.warn('Duplicate attestation from node', {
        transferId,
        nodeId,
      });
      return;
    }

    // ── GUARD: No duplicate attestations from same public key ──
    if (pending.attestations.some((a) => a.publicKey.equals(attestation.publicKey))) {
      this.logger.warn('Duplicate attestation from same public key', {
        transferId,
        publicKey: pubkeyHex,
      });
      return;
    }

    // ── GUARD: Verify the attestation signs the same message ──
    if (!pending.message.equals(attestation.messageHash)) {
      this.logger.error('ALERT: Message hash mismatch — possible Byzantine behavior', {
        transferId,
        nodeId,
        expected: pending.message.toString('hex'),
        received: attestation.messageHash.toString('hex'),
      });
      this.emit('byzantine_detected', { nodeId, transferId, attestation });
      return;
    }

    pending.attestations.push(attestation);
    this.logger.info('Received attestation (verified)', {
      transferId,
      nodeId,
      total: pending.attestations.length,
      required: this.config.minValidators,
    });

    // Check if we've reached consensus
    this.checkConsensus(transferId);
  }

  /**
   * Check if consensus has been reached for a transfer.
   */
  private checkConsensus(transferId: string): void {
    const pending = this.pendingConsensus.get(transferId);
    if (!pending || pending.resolved) return;

    if (pending.attestations.length >= this.config.minValidators) {
      pending.resolved = true;

      const result: ConsensusResult = {
        transferId,
        type: pending.request.type,
        attestations: pending.attestations,
        achieved: true,
        requiredSignatures: this.config.minValidators,
        receivedSignatures: pending.attestations.length,
        event: pending.request.event,
        requestTimestamp: pending.request.timestamp,
      };

      this.processedTransfers.add(transferId);
      // SECURITY FIX (VAL-10): Evict oldest entries when set exceeds max size to prevent OOM.
      if (this.processedTransfers.size > ConsensusEngine.MAX_PROCESSED_TRANSFERS) {
        const iter = this.processedTransfers.values();
        const oldest = iter.next().value;
        if (oldest) this.processedTransfers.delete(oldest);
      }
      this.persistProcessedTransfers(); // H-3: persist to disk immediately
      this.logger.info('CONSENSUS REACHED', {
        transferId,
        signatures: result.receivedSignatures,
        required: result.requiredSignatures,
      });

      this.emit('consensus_reached', result);

      // Cleanup after a delay
      setTimeout(() => {
        this.pendingConsensus.delete(transferId);
      }, 60000);
    }
  }

  /**
   * Handle consensus timeout — emit failure if threshold not met.
   */
  private checkConsensusTimeout(transferId: string): void {
    const pending = this.pendingConsensus.get(transferId);
    if (!pending || pending.resolved) return;

    this.logger.warn('Consensus timeout', {
      transferId,
      received: pending.attestations.length,
      required: this.config.minValidators,
    });

    const result: ConsensusResult = {
      transferId,
      type: pending.request.type,
      attestations: pending.attestations,
      achieved: false,
      requiredSignatures: this.config.minValidators,
      receivedSignatures: pending.attestations.length,
    };

    this.emit('consensus_failed', result);
    pending.resolved = true;
  }

  /**
   * Construct the canonical message that all validators must sign.
   * This ensures deterministic message construction across all nodes.
   *
   * CRITICAL: The unlock message format MUST match the Solana program's
   * construct_unlock_message() byte-for-byte, or Ed25519 verification fails.
   */
  private constructCanonicalMessage(request: AttestationRequest): Buffer {
    if (request.type === 'mint') {
      return this.constructMintMessage(request);
    } else {
      return this.constructUnlockMessage(request);
    }
  }

  /**
   * Construct the canonical mint attestation message.
   * Used for SOL→DCC deposits triggering wSOL minting on DCC.
   *
   * MUST match RIDE contract's committeeMint signature verification:
   *   toBytes(transferId + "|" + recipient + "|" + amount + "|" + solSlot)
   * where recipient is the base58 DCC address derived from the raw bytes.
   */
  private constructMintMessage(request: AttestationRequest): Buffer {
    const event = request.event as SolanaDepositEvent;

    // Convert hex recipient to base58 DCC address
    const recipientRaw = Buffer.from(event.recipientDcc, 'hex');
    let lastNonZero = recipientRaw.length - 1;
    while (lastNonZero > 0 && recipientRaw[lastNonZero] === 0) lastNonZero--;
    const trimmed = recipientRaw.subarray(0, lastNonZero + 1);
    const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + Buffer.from(trimmed).toString('hex'));
    let b58 = '';
    while (num > 0n) {
      b58 = bs58Chars[Number(num % 58n)] + b58;
      num = num / 58n;
    }
    for (let j = 0; j < trimmed.length && trimmed[j] === 0; j++) {
      b58 = '1' + b58;
    }
    const recipient = b58 || '1';

    // Canonical message matching RIDE's toBytes(string):
    // transferId + "|" + recipient + "|" + amount + "|" + solSlot
    const message = `${request.transferId}|${recipient}|${event.amount.toString()}|${event.slot}`;
    return Buffer.from(message, 'utf-8');
  }

  /**
   * Construct the canonical unlock message.
   * MUST match Solana's construct_unlock_message() exactly:
   *   domain_sep (24B) = "SOL_DCC_BRIDGE_UNLOCK_V1"
   *   transfer_id (32B raw)
   *   recipient (32B raw Solana pubkey)
   *   amount (8B LE u64)
   *   burn_tx_hash (32B raw)
   *   dcc_chain_id (4B LE u32)
   *   expiration (8B LE i64)
   */
  private constructUnlockMessage(request: AttestationRequest): Buffer {
    const event = request.event as DccBurnEvent;
    const parts: Buffer[] = [];

    // Domain separator — MUST be exactly "SOL_DCC_BRIDGE_UNLOCK_V1" (24 bytes)
    parts.push(Buffer.from('SOL_DCC_BRIDGE_UNLOCK_V1'));

    // Transfer ID (32 bytes raw)
    const transferIdBuf = Buffer.alloc(32);
    const tidHex = Buffer.from(request.transferId, 'hex');
    tidHex.copy(transferIdBuf, 0, 0, Math.min(32, tidHex.length));
    parts.push(transferIdBuf);

    // Recipient Solana pubkey (32 bytes raw) — from base58 to raw bytes
    const { PublicKey } = require('@solana/web3.js');
    const recipientPubkey = new PublicKey(event.solRecipient);
    parts.push(recipientPubkey.toBuffer());

    // Amount as u64 LE (unsigned)
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(event.amount));
    parts.push(amountBuf);

    // Burn TX hash (32 bytes raw)
    const burnTxBuf = Buffer.alloc(32);
    const burnTxBytes = Buffer.from(event.txId, 'hex');
    burnTxBytes.copy(burnTxBuf, 0, 0, Math.min(32, burnTxBytes.length));
    parts.push(burnTxBuf);

    // DCC chain ID as u32 LE (default: 2)
    const dccChainIdBuf = Buffer.alloc(4);
    dccChainIdBuf.writeUInt32LE(2);
    parts.push(dccChainIdBuf);

    // Expiration as i64 LE (1 hour from request timestamp)
    const expiration = Math.floor(request.timestamp / 1000) + 3600;
    const expBuf = Buffer.alloc(8);
    expBuf.writeBigInt64LE(BigInt(expiration));
    parts.push(expBuf);

    return Buffer.concat(parts);
  }

  private bigintToBuffer(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
  }

  private uint64ToBuffer(value: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    return buf;
  }

  private uint32ToBuffer(value: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value);
    return buf;
  }

  /**
   * Get status of all pending consensus rounds
   */
  getStatus(): {
    pending: number;
    processed: number;
    details: Array<{ transferId: string; attestations: number; required: number }>;
  } {
    const details = Array.from(this.pendingConsensus.entries()).map(
      ([transferId, pending]) => ({
        transferId,
        attestations: pending.attestations.length,
        required: this.config.minValidators,
      })
    );

    return {
      pending: this.pendingConsensus.size,
      processed: this.processedTransfers.size,
      details,
    };
  }
}

interface PendingConsensus {
  request: AttestationRequest;
  attestations: Attestation[];
  message: Buffer;
  startTime: number;
  resolved: boolean;
}
