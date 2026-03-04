// ═══════════════════════════════════════════════════════════════
// SOLANA WATCHER — Monitors Solana chain for bridge events
// ═══════════════════════════════════════════════════════════════
//
// Security responsibilities:
// - Watch for BridgeDeposit events on the lock program
// - Wait for finality (≥32 confirmations)
// - Verify event data matches on-chain state
// - Submit verified events to consensus layer
// - Detect reorgs and invalidate affected events

import { Connection, PublicKey, Commitment, Context, LogsFilter } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { createLogger } from '../utils/logger';

export interface SolanaDepositEvent {
  transferId: string;
  sender: string;
  recipientDcc: string;
  amount: bigint;
  nonce: bigint;
  slot: number;
  timestamp: number;
  chainId: number;
  signature: string;
  confirmations: number;
}

export interface SolanaWatcherConfig {
  rpcUrl: string;
  wsUrl: string;
  programId: string;
  requiredConfirmations: number;
  reorgProtectionSlots: number;
  pollIntervalMs: number;
}

export class SolanaWatcher extends EventEmitter {
  private connection: Connection;
  private programId: PublicKey;
  private config: SolanaWatcherConfig;
  private logger: Logger;
  private isRunning: boolean = false;
  private lastProcessedSlot: number = 0;
  private pendingEvents: Map<string, SolanaDepositEvent> = new Map();
  private subscriptionId: number | null = null;

  constructor(config: SolanaWatcherConfig) {
    super();
    this.config = config;
    this.connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed' as Commitment,
      wsEndpoint: config.wsUrl || undefined,
    });
    this.programId = new PublicKey(config.programId);
    this.logger = createLogger('SolanaWatcher');
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('Starting Solana watcher', {
      programId: this.programId.toBase58(),
      requiredConfirmations: this.config.requiredConfirmations,
    });

    // Subscribe to program logs for real-time event detection
    await this.subscribeToLogs();

    // Start finality confirmation loop
    this.runFinalityLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
    this.logger.info('Solana watcher stopped');
  }

  private async subscribeToLogs(): Promise<void> {
    const filter: LogsFilter = { mentions: [this.programId.toBase58()] };

    this.subscriptionId = this.connection.onLogs(
      filter,
      async (logs, ctx) => {
        try {
          await this.processLogs(logs, ctx);
        } catch (err) {
          this.logger.error('Error processing logs', { error: err });
        }
      },
      'confirmed'
    );

    this.logger.info('Subscribed to program logs');
  }

  private async processLogs(logs: any, ctx: Context): Promise<void> {
    // Parse BridgeDeposit events from program logs
    const depositEvents = this.parseDepositEvents(logs, ctx.slot);

    for (const event of depositEvents) {
      // Check for duplicates
      if (this.pendingEvents.has(event.transferId)) {
        this.logger.warn('Duplicate event detected', {
          transferId: event.transferId,
        });
        continue;
      }

      this.logger.info('New deposit event detected', {
        transferId: event.transferId,
        amount: event.amount.toString(),
        slot: event.slot,
      });

      // Add to pending events for finality confirmation
      this.pendingEvents.set(event.transferId, event);
    }
  }

  private parseDepositEvents(logs: any, slot: number): SolanaDepositEvent[] {
    const events: SolanaDepositEvent[] = [];

    if (!logs.logs) return events;

    for (const log of logs.logs) {
      // Look for the BridgeDeposit event marker
      if (log.includes('Program data:')) {
        try {
          const dataStr = log.split('Program data: ')[1];
          if (!dataStr) continue;

          const data = Buffer.from(dataStr, 'base64');

          // Parse event discriminator (first 8 bytes)
          const discriminator = data.subarray(0, 8);

          // BridgeDeposit event discriminator
          // In production, compute this from the event name hash
          const event = this.decodeBridgeDeposit(data.subarray(8), slot, logs.signature);
          if (event) {
            events.push(event);
          }
        } catch (err) {
          this.logger.debug('Failed to parse log entry', { log, error: err });
        }
      }
    }

    return events;
  }

  private decodeBridgeDeposit(
    data: Buffer,
    slot: number,
    signature: string
  ): SolanaDepositEvent | null {
    try {
      if (data.length < 120) return null;

      let offset = 0;

      const transferId = data.subarray(offset, offset + 32).toString('hex');
      offset += 32;

      const sender = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;

      const recipientDcc = data.subarray(offset, offset + 32).toString('hex');
      offset += 32;

      const amount = BigInt(data.readBigUInt64LE(offset));
      offset += 8;

      const nonce = BigInt(data.readBigUInt64LE(offset));
      offset += 8;

      const eventSlot = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const timestamp = Number(data.readBigInt64LE(offset));
      offset += 8;

      const chainId = data.readUInt32LE(offset);

      return {
        transferId,
        sender,
        recipientDcc,
        amount,
        nonce,
        slot: eventSlot,
        timestamp,
        chainId,
        signature,
        confirmations: 0,
      };
    } catch (err) {
      this.logger.debug('Failed to decode BridgeDeposit', { error: err });
      return null;
    }
  }

  /**
   * Continuously check pending events for finality.
   * An event is considered final when it has enough confirmations
   * AND is past the reorg protection window.
   */
  private async runFinalityLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentSlot = await this.connection.getSlot('finalized');

        for (const [transferId, event] of this.pendingEvents) {
          const confirmations = currentSlot - event.slot;

          if (confirmations >= this.config.requiredConfirmations) {
            // Additional check: verify the transaction is still valid
            const isValid = await this.verifyTransactionFinality(
              event.signature,
              event.slot
            );

            if (isValid) {
              // M-4 fix: Cross-reference log data against on-chain DepositRecord PDA
              const pdaVerified = await this.verifyDepositPDA(event);
              if (!pdaVerified) {
                this.logger.error('DEPOSIT PDA MISMATCH — log data does not match on-chain state. Possible RPC manipulation.', {
                  transferId,
                  slot: event.slot,
                });
                this.pendingEvents.delete(transferId);
                this.emit('deposit_invalidated', event);
                continue;
              }

              event.confirmations = confirmations;
              this.logger.info('Event finalized (PDA verified)', {
                transferId,
                confirmations,
                slot: event.slot,
              });

              // Emit finalized event for consensus
              this.emit('deposit_finalized', event);
              this.pendingEvents.delete(transferId);
            } else {
              this.logger.warn('Transaction no longer valid — possible reorg', {
                transferId,
                slot: event.slot,
              });
              this.pendingEvents.delete(transferId);
              this.emit('deposit_invalidated', event);
            }
          }
        }
      } catch (err) {
        this.logger.error('Finality loop error', { error: err });
      }

      // Poll interval
      await sleep(this.config.pollIntervalMs || 5000);
    }
  }

  /**
   * Verify that a transaction is still present and valid at the finalized slot.
   * This protects against reorgs where a transaction might disappear.
   */
  private async verifyTransactionFinality(
    signature: string,
    eventSlot: number
  ): Promise<boolean> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) return false;
      if (tx.slot !== eventSlot) return false;
      if (tx.meta?.err) return false;

      return true;
    } catch {
      return false;
    }
  }

  /**
   * M-4 fix: Verify that the deposit event data from RPC logs matches
   * the on-chain DepositRecord PDA. Protects against malicious RPC injection.
   */
  private async verifyDepositPDA(event: SolanaDepositEvent): Promise<boolean> {
    try {
      const transferIdBytes = Buffer.from(event.transferId, 'hex');
      const [depositPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('deposit'), transferIdBytes],
        this.programId,
      );

      const accountInfo = await this.connection.getAccountInfo(depositPda, 'finalized');
      if (!accountInfo || !accountInfo.data) {
        this.logger.warn('DepositRecord PDA not found', { transferId: event.transferId });
        return false;
      }

      // Basic sanity: account exists and is owned by the bridge program
      if (!accountInfo.owner.equals(this.programId)) {
        this.logger.error('DepositRecord PDA owned by wrong program', {
          transferId: event.transferId,
          owner: accountInfo.owner.toBase58(),
        });
        return false;
      }

      // Skip discriminator (8 bytes), read transfer_id (32 bytes)
      const data = accountInfo.data;
      if (data.length < 40) return false;
      const onChainTransferId = data.subarray(8, 40).toString('hex');
      if (onChainTransferId !== event.transferId) {
        this.logger.error('DepositRecord transfer_id mismatch', {
          expected: event.transferId,
          onChain: onChainTransferId,
        });
        return false;
      }

      // Read amount from PDA: skip 8(disc) + 32(tid) + 32(mid) + 32(sender) + 32(recipient) = 136, then 8 bytes u64 LE
      if (data.length >= 144) {
        const onChainAmount = data.readBigUInt64LE(136);
        if (onChainAmount !== BigInt(event.amount)) {
          this.logger.error('DepositRecord amount mismatch', {
            expected: event.amount.toString(),
            onChain: onChainAmount.toString(),
          });
          return false;
        }
      }

      return true;
    } catch (err: any) {
      this.logger.warn('Failed to verify deposit PDA', { error: err.message });
      // Fail closed: if we can't verify, reject
      return false;
    }
  }

  /**
   * Get the current health status of the watcher
   */
  getHealth(): { running: boolean; pendingEvents: number; lastSlot: number } {
    return {
      running: this.isRunning,
      pendingEvents: this.pendingEvents.size,
      lastSlot: this.lastProcessedSlot,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
