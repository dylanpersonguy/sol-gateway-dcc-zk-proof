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
  messageId: string;
  sender: string;
  recipientDcc: string;
  amount: bigint;
  nonce: bigint;
  slot: number;
  eventIndex: number;
  timestamp: number;
  srcChainId: number;
  dstChainId: number;
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
  private lastSeenSignature: string | null = null;
  private usePolling: boolean = false;

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

    // Helius and many RPC providers don't support logsSubscribe with mentions.
    // Use polling by default — it's more reliable and works with all providers.
    // Only attempt WebSocket if explicitly configured with a non-Helius WS URL.
    const wsUrl = this.config.wsUrl || '';
    const forceWs = process.env.SOLANA_USE_WEBSOCKET === 'true';
    const isHelius = wsUrl.includes('helius');

    if (forceWs && !isHelius) {
      try {
        await this.subscribeToLogs();
        this.logger.info('Using WebSocket for deposit detection');
      } catch (err) {
        this.logger.warn('WebSocket logsSubscribe failed, falling back to polling', { error: err });
        this.usePolling = true;
      }
    } else {
      this.usePolling = true;
      if (isHelius) {
        this.logger.info('Helius RPC detected — using polling mode (logsSubscribe not supported)');
      } else {
        this.logger.info('Using polling mode for deposit detection');
      }
    }

    if (this.usePolling) {
      this.runPollingLoop();
    }

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

    // Wrap in a promise so we can detect early WS errors
    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      // Listen for WS errors that fire before the subscription succeeds
      const errorHandler = (err: any) => {
        if (!resolved) {
          resolved = true;
          this.usePolling = true;
          this.logger.warn('WebSocket error during logsSubscribe — will use polling', { error: err?.message || err });
          resolve(); // Don't reject; we handle this gracefully via usePolling flag
        }
      };

      try {
        this.subscriptionId = this.connection.onLogs(
          filter,
          async (logs, ctx) => {
            // First successful callback proves WS works
            if (!resolved) {
              resolved = true;
            }
            try {
              await this.processLogs(logs, ctx);
            } catch (err) {
              this.logger.error('Error processing logs', { error: err });
            }
          },
          'confirmed'
        );

        this.logger.info('Subscribed to program logs (WebSocket)');

        // Give the WS a brief window to fail, then resolve
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 1500);
      } catch (err) {
        if (!resolved) {
          resolved = true;
          this.usePolling = true;
          this.logger.warn('logsSubscribe threw synchronously — will use polling', { error: err });
          resolve();
        }
      }
    });
  }

  /**
   * Poll for new transactions using getSignaturesForAddress.
   * This works with all RPC providers (Helius, QuickNode, etc.)
   * that don't support WebSocket logsSubscribe with mentions.
   */
  private async runPollingLoop(): Promise<void> {
    // Seed lastSeenSignature with the most recent tx so we don't replay history
    try {
      const recent = await this.connection.getSignaturesForAddress(
        this.programId,
        { limit: 1 },
        'confirmed'
      );
      if (recent.length > 0) {
        this.lastSeenSignature = recent[0].signature;
        this.logger.info('Polling seeded from latest signature', {
          signature: this.lastSeenSignature.slice(0, 16) + '...',
          slot: recent[0].slot,
        });
      }
    } catch (err) {
      this.logger.warn('Failed to seed polling cursor', { error: err });
    }

    while (this.isRunning) {
      try {
        await this.pollNewTransactions();
      } catch (err) {
        this.logger.error('Polling loop error', { error: err });
      }
      await sleep(this.config.pollIntervalMs || 5000);
    }
  }

  /**
   * Fetch new confirmed signatures for the bridge program since our last cursor,
   * then fetch each transaction's logs and parse deposit events.
   */
  private async pollNewTransactions(): Promise<void> {
    const opts: any = { limit: 50 };
    if (this.lastSeenSignature) {
      opts.until = this.lastSeenSignature;
    }

    // getSignaturesForAddress returns newest-first
    const signatures = await this.connection.getSignaturesForAddress(
      this.programId,
      opts,
      'confirmed'
    );

    if (signatures.length === 0) return;

    // Process oldest-first so our cursor advances correctly
    const chronological = [...signatures].reverse();

    this.logger.debug('Poll found new transactions', { count: chronological.length });

    for (const sigInfo of chronological) {
      if (sigInfo.err) continue; // Skip failed txs

      try {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta?.logMessages) continue;

        // Build a logs object compatible with processLogs
        const logsObj = {
          signature: sigInfo.signature,
          logs: tx.meta.logMessages,
          err: tx.meta.err,
        };

        const ctx: Context = { slot: tx.slot };
        await this.processLogs(logsObj, ctx);
      } catch (err) {
        this.logger.debug('Failed to fetch/parse tx during polling', {
          signature: sigInfo.signature,
          error: err,
        });
      }
    }

    // Advance cursor to the newest signature we've seen
    this.lastSeenSignature = signatures[0].signature;
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

    // SECURITY FIX (VAL-8): Precompute BridgeDeposit Anchor event discriminator.
    // Anchor event discriminator = sha256("event:BridgeDeposit")[0..8]
    // Without this check, non-bridge log entries could be mis-parsed as deposits.
    const crypto = require('crypto');
    const BRIDGE_DEPOSIT_DISC = crypto
      .createHash('sha256')
      .update('event:BridgeDeposit')
      .digest()
      .subarray(0, 8);
    const BRIDGE_DEPOSIT_SPL_DISC = crypto
      .createHash('sha256')
      .update('event:BridgeDepositSpl')
      .digest()
      .subarray(0, 8);

    for (const log of logs.logs) {
      // Look for the BridgeDeposit event marker
      if (log.includes('Program data:')) {
        try {
          const dataStr = log.split('Program data: ')[1];
          if (!dataStr) continue;

          const data = Buffer.from(dataStr, 'base64');

          // Parse event discriminator (first 8 bytes)
          const discriminator = data.subarray(0, 8);

          // SECURITY FIX (VAL-8): Only process known bridge event discriminators
          if (!discriminator.equals(BRIDGE_DEPOSIT_DISC) && !discriminator.equals(BRIDGE_DEPOSIT_SPL_DISC)) {
            continue; // Skip non-deposit events
          }

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
      // BridgeDeposit event layout (after 8-byte Anchor discriminator):
      //   transfer_id: [u8; 32]     offset 0
      //   message_id:  [u8; 32]     offset 32
      //   sender:      Pubkey(32)   offset 64
      //   recipient:   [u8; 32]     offset 96
      //   amount:      u64          offset 128
      //   nonce:       u64          offset 136
      //   slot:        u64          offset 144
      //   event_index: u32          offset 152
      //   timestamp:   i64          offset 156
      //   src_chain_id: u32         offset 164
      //   dst_chain_id: u32         offset 168
      //   asset_id:    Pubkey(32)   offset 172
      //   Total: 204 bytes
      if (data.length < 204) return null;

      let offset = 0;

      const transferId = data.subarray(offset, offset + 32).toString('hex');
      offset += 32;

      const messageId = data.subarray(offset, offset + 32).toString('hex');
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

      const eventIndex = data.readUInt32LE(offset);
      offset += 4;

      const timestamp = Number(data.readBigInt64LE(offset));
      offset += 8;

      const srcChainId = data.readUInt32LE(offset);
      offset += 4;

      const dstChainId = data.readUInt32LE(offset);
      offset += 4;

      // asset_id is at offset 172, 32 bytes (not used in relay but logged)

      return {
        transferId,
        messageId,
        sender,
        recipientDcc,
        amount,
        nonce,
        slot: eventSlot,
        eventIndex,
        timestamp,
        srcChainId,
        dstChainId,
        chainId: srcChainId,
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
  getHealth(): { running: boolean; pendingEvents: number; lastSlot: number; mode: string } {
    return {
      running: this.isRunning,
      pendingEvents: this.pendingEvents.size,
      lastSlot: this.lastProcessedSlot,
      mode: this.usePolling ? 'polling' : 'websocket',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
