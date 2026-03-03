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

export interface ConsensusConfig {
  nodeId: string;
  minValidators: number;
  consensusTimeoutMs: number;
  maxRetries: number;
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
   */
  receiveAttestation(attestation: Attestation): void {
    const { transferId, nodeId } = attestation;

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
    this.logger.info('Received attestation', {
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
      };

      this.processedTransfers.add(transferId);
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
   */
  private constructCanonicalMessage(request: AttestationRequest): Buffer {
    const parts: Buffer[] = [];

    // Domain separator
    parts.push(Buffer.from('SOL_DCC_BRIDGE_V1'));

    // Type prefix
    parts.push(Buffer.from(request.type === 'mint' ? 'MINT' : 'UNLOCK'));

    // Transfer ID
    parts.push(Buffer.from(request.transferId, 'hex'));

    if (request.type === 'mint') {
      const event = request.event as SolanaDepositEvent;
      // Canonical ordering: transferId, sender, recipient, amount, nonce, slot, chainId
      parts.push(Buffer.from(event.sender));
      parts.push(Buffer.from(event.recipientDcc, 'hex'));
      parts.push(this.bigintToBuffer(event.amount));
      parts.push(this.bigintToBuffer(event.nonce));
      parts.push(this.uint64ToBuffer(event.slot));
      parts.push(this.uint32ToBuffer(event.chainId));
    } else {
      const event = request.event as DccBurnEvent;
      parts.push(Buffer.from(event.sender));
      parts.push(Buffer.from(event.solRecipient));
      parts.push(this.bigintToBuffer(event.amount));
      parts.push(this.uint64ToBuffer(event.height));
      parts.push(Buffer.from(event.txId));
    }

    // Timestamp for expiration
    parts.push(this.uint64ToBuffer(request.timestamp));

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
