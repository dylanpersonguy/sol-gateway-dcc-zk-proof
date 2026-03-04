// ═══════════════════════════════════════════════════════════════
// DCC WATCHER — Monitors DecentralChain for burn events
// ═══════════════════════════════════════════════════════════════
//
// Watches for wSOL.DCC burn events to trigger SOL unlock on Solana.
// Must verify burns independently — never trust unverified events.

import { EventEmitter } from 'events';
import axios, { AxiosInstance } from 'axios';
import { Logger } from 'winston';
import { createLogger } from '../utils/logger';

export interface DccBurnEvent {
  burnId: string;
  sender: string;
  solRecipient: string;
  amount: bigint;
  height: number;
  timestamp: number;
  txId: string;
  confirmations: number;
}

export interface DccWatcherConfig {
  nodeUrl: string;
  bridgeContract: string;
  requiredConfirmations: number;
  pollIntervalMs: number;
}

export class DccWatcher extends EventEmitter {
  private client: AxiosInstance;
  private config: DccWatcherConfig;
  private logger: Logger;
  private isRunning: boolean = false;
  private lastProcessedHeight: number = 0;
  private pendingBurns: Map<string, DccBurnEvent> = new Map();

  constructor(config: DccWatcherConfig) {
    super();
    this.config = config;
    this.client = axios.create({
      baseURL: config.nodeUrl,
      timeout: 15000,
    });
    this.logger = createLogger('DccWatcher');
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('Starting DCC watcher', {
      bridgeContract: this.config.bridgeContract,
      requiredConfirmations: this.config.requiredConfirmations,
    });

    // Get current height to start watching from
    this.lastProcessedHeight = await this.getCurrentHeight();
    this.logger.info('Starting from height', { height: this.lastProcessedHeight });

    // Start polling loop
    this.runPollLoop();
    this.runFinalityLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.info('DCC watcher stopped');
  }

  /**
   * Poll for new burn events on the DCC bridge contract
   */
  private async runPollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentHeight = await this.getCurrentHeight();

        if (currentHeight > this.lastProcessedHeight) {
          // Scan new blocks for burn events
          for (let h = this.lastProcessedHeight + 1; h <= currentHeight; h++) {
            await this.scanBlock(h);
          }
          this.lastProcessedHeight = currentHeight;
        }
      } catch (err) {
        this.logger.error('Poll loop error', { error: err });
      }

      await sleep(this.config.pollIntervalMs || 3000);
    }
  }

  /**
   * Scan a specific block for burn transactions on the bridge contract
   */
  private async scanBlock(height: number): Promise<void> {
    try {
      const response = await this.client.get(`/blocks/at/${height}`);
      const block = response.data;

      if (!block || !block.transactions) return;

      for (const tx of block.transactions) {
        await this.checkForBurnEvent(tx, height);
      }
    } catch (err) {
      this.logger.debug('Failed to scan block', { height, error: err });
    }
  }

  /**
   * Check if a transaction is a burn on the bridge contract
   */
  private async checkForBurnEvent(tx: any, height: number): Promise<void> {
    try {
      // Check if this is an invoke script transaction targeting our bridge
      if (tx.type !== 16) return; // InvokeScript transaction type
      if (tx.dApp !== this.config.bridgeContract) return;
      if (tx.call?.function !== 'burn' && tx.call?.function !== 'burnToken') return;

      // Parse burn event from state changes
      const burnEvent = await this.parseBurnEvent(tx, height);
      if (!burnEvent) return;

      if (this.pendingBurns.has(burnEvent.burnId)) {
        this.logger.warn('Duplicate burn detected', { burnId: burnEvent.burnId });
        return;
      }

      this.logger.info('New burn event detected', {
        burnId: burnEvent.burnId,
        amount: burnEvent.amount.toString(),
        height,
      });

      this.pendingBurns.set(burnEvent.burnId, burnEvent);
    } catch (err) {
      this.logger.debug('Failed to check burn event', { error: err });
    }
  }

  /**
   * Parse a burn event from a DCC transaction
   */
  private async parseBurnEvent(tx: any, height: number): Promise<DccBurnEvent | null> {
    try {
      // Extract burn details from state changes
      const stateChanges = tx.stateChanges;
      if (!stateChanges) return null;

      // Find the burn record in data entries
      const burnRecordEntry = stateChanges.data?.find(
        (entry: any) => entry.key.startsWith('burn_')
      );
      if (!burnRecordEntry) return null;

      // Parse burn record: "sender|solRecipient|amount|height|timestamp"
      const parts = burnRecordEntry.value.split('|');
      if (parts.length < 5) return null;

      const burnId = burnRecordEntry.key.replace('burn_', '');

      return {
        burnId,
        sender: parts[0],
        solRecipient: parts[1],
        amount: BigInt(parts[2]),
        height: parseInt(parts[3]),
        timestamp: parseInt(parts[4]),
        txId: tx.id,
        confirmations: 0,
      };
    } catch (err) {
      this.logger.debug('Failed to parse burn event', { error: err });
      return null;
    }
  }

  /**
   * Check pending burns for finality
   */
  private async runFinalityLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentHeight = await this.getCurrentHeight();

        for (const [burnId, event] of this.pendingBurns) {
          const confirmations = currentHeight - event.height;

          if (confirmations >= this.config.requiredConfirmations) {
            // Verify the burn is still in the chain state
            const isValid = await this.verifyBurnOnChain(burnId);

            if (isValid) {
              event.confirmations = confirmations;
              this.logger.info('Burn event finalized', {
                burnId,
                confirmations,
              });

              this.emit('burn_finalized', event);
              this.pendingBurns.delete(burnId);
            } else {
              this.logger.warn('Burn event no longer valid', { burnId });
              this.pendingBurns.delete(burnId);
              this.emit('burn_invalidated', event);
            }
          }
        }
      } catch (err) {
        this.logger.error('Finality loop error', { error: err });
      }

      await sleep(this.config.pollIntervalMs || 5000);
    }
  }

  /**
   * Verify a burn record exists on-chain
   */
  private async verifyBurnOnChain(burnId: string): Promise<boolean> {
    try {
      const response = await this.client.get(
        `/addresses/data/${this.config.bridgeContract}/burn_${burnId}`
      );
      return response.status === 200 && response.data?.value;
    } catch {
      return false;
    }
  }

  private async getCurrentHeight(): Promise<number> {
    const response = await this.client.get('/blocks/height');
    return response.data.height;
  }

  getHealth(): { running: boolean; pendingBurns: number; lastHeight: number } {
    return {
      running: this.isRunning,
      pendingBurns: this.pendingBurns.size,
      lastHeight: this.lastProcessedHeight,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
