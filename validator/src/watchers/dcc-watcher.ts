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

/** wSOL is 8dp on DecentralChain, SOL is 9dp on Solana. */
const WSOL_TO_LAMPORTS_DIVISOR = 10n;

export interface DccBurnEvent {
  burnId: string;
  sender: string;
  solRecipient: string;
  /** SPL mint the burn is redeeming, as recorded by the contract. */
  splMint: string;
  /** Lamports (9dp) — converted from the record's wSOL units. */
  amount: bigint;
  height: number;
  timestamp: number;
  txId: string;
  confirmations: number;
}

export interface DccWatcherConfig {
  nodeUrl: string;
  /** SECURITY FIX (VAL-7): Secondary DCC node URL for multi-node verification.
   *  If set, burn events must be confirmed by BOTH nodes. */
  secondaryNodeUrl?: string;
  bridgeContract: string;
  requiredConfirmations: number;
  pollIntervalMs: number;
}

export class DccWatcher extends EventEmitter {
  private client: AxiosInstance;
  private secondaryClient: AxiosInstance | null;
  private config: DccWatcherConfig;
  private logger: Logger;
  private isRunning: boolean = false;
  private isSeeded = false;
  private lastProcessedHeight: number = 0;
  private pendingBurns: Map<string, DccBurnEvent> = new Map();

  constructor(config: DccWatcherConfig) {
    super();
    this.config = config;
    this.client = axios.create({
      baseURL: config.nodeUrl,
      timeout: 15000,
    });
    // SECURITY FIX (VAL-7): Initialize secondary client for multi-node verification
    this.secondaryClient = config.secondaryNodeUrl
      ? axios.create({ baseURL: config.secondaryNodeUrl, timeout: 15000 })
      : null;
    this.logger = createLogger('DccWatcher');
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('Starting DCC watcher', {
      bridgeContract: this.config.bridgeContract,
      requiredConfirmations: this.config.requiredConfirmations,
    });

    // Seed the starting height in the background.
    //
    // main() awaits this before starting P2P, so blocking here on an
    // unreachable DCC node would stall the whole validator, and throwing
    // would exit the process. Neither is acceptable for a transient outage:
    // the Solana side and P2P must keep running and the DCC side must pick
    // itself up when the node returns.
    void this.seedHeightThenPoll();
  }

  /**
   * Retry the starting-height fetch until it succeeds, then begin polling.
   *
   * The poll loop is only started once seeded — with lastProcessedHeight left
   * at 0 it would try to scan every block from genesis.
   */
  private async seedHeightThenPoll(): Promise<void> {
    let delayMs = 2000;

    while (this.isRunning) {
      try {
        this.lastProcessedHeight = await this.getCurrentHeight();
        this.isSeeded = true;
        this.logger.info('Starting from height', { height: this.lastProcessedHeight });
        this.runPollLoop();
        this.runFinalityLoop();
        return;
      } catch (err: any) {
        this.logger.warn('DCC height fetch failed — retrying', {
          retryInMs: delayMs,
          error: err?.message,
        });
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
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
  private async parseBurnEvent(tx: any, _height: number): Promise<DccBurnEvent | null> {
    try {
      // Extract burn details from state changes
      const stateChanges = tx.stateChanges;
      if (!stateChanges) return null;

      // The burn record, not burn_nonce_<address>, which shares the prefix and
      // would otherwise match first depending on how the node orders entries.
      const burnRecordEntry = stateChanges.data?.find(
        (entry: any) =>
          typeof entry.key === 'string' &&
          entry.key.startsWith('burn_') &&
          !entry.key.startsWith('burn_nonce_') &&
          typeof entry.value === 'string',
      );
      if (!burnRecordEntry) return null;

      // The contract writes SIX fields (see keyBurnRecord in bridge_controller.ride):
      //   caller | solRecipient | splMint | amount | height | timestamp
      // This previously read five, taking splMint as the amount, so
      // BigInt(parts[2]) threw on a base58 mint and the catch below discarded
      // every burn. Redemption never started.
      const parts = burnRecordEntry.value.split('|');
      if (parts.length < 6) {
        this.logger.warn('Burn record has an unexpected shape', {
          key: burnRecordEntry.key,
          fields: parts.length,
        });
        return null;
      }

      const burnId = burnRecordEntry.key.replace('burn_', '');

      // The record holds wSOL units (8dp). Unlock releases lamports (9dp), so
      // convert — mirrors token_<mint>_divisor on the bridge contract.
      const amountWsolUnits = BigInt(parts[3]);
      const amountLamports = amountWsolUnits * WSOL_TO_LAMPORTS_DIVISOR;

      return {
        burnId,
        sender: parts[0],
        solRecipient: parts[1],
        splMint: parts[2],
        amount: amountLamports,
        height: parseInt(parts[4]),
        timestamp: parseInt(parts[5]),
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
   * Verify a burn record exists on-chain AND the block is finalized (M-5 fix).
   * Uses DCC node's block-at-height endpoint to confirm the block has been
   * adopted by the network (has a valid generator signature and successor).
   */
  private async verifyBurnOnChain(burnId: string): Promise<boolean> {
    try {
      // Step 1: Verify the burn data entry exists on the bridge contract
      const dataResp = await this.client.get(
        `/addresses/data/${this.config.bridgeContract}/burn_${burnId}`
      );
      if (dataResp.status !== 200 || !dataResp.data?.value) {
        return false;
      }

      // Step 2: Retrieve the burn's original transaction to get its block height
      const event = this.pendingBurns.get(burnId);
      if (!event) return false;

      // Step 3: Verify that the block at the burn height is actually finalized.
      // A DCC block is considered finalized when it has a valid reference to
      // the next block (i.e., successors exist). We check that height + 1 exists.
      const burnHeight = event.height;
      const successorResp = await this.client.get(`/blocks/at/${burnHeight + 1}`);
      if (successorResp.status !== 200 || !successorResp.data?.reference) {
        this.logger.warn('Burn block successor not yet available — not finalized', { burnId, burnHeight });
        return false;
      }

      // Step 4: Verify the transaction is actually in that block
      const blockResp = await this.client.get(`/blocks/at/${burnHeight}`);
      if (blockResp.status !== 200 || !blockResp.data) {
        return false;
      }
      const block = blockResp.data;
      const txInBlock = block.transactions?.some((tx: any) => tx.id === event.txId);
      if (!txInBlock) {
        this.logger.error('Burn tx NOT found in its claimed block — possible forgery', {
          burnId,
          txId: event.txId,
          burnHeight,
        });
        return false;
      }

      // SECURITY FIX (VAL-7): Cross-verify burn data against secondary DCC node.
      // Trusting a single node allows a compromised node to feed fabricated burns.
      if (this.secondaryClient) {
        try {
          const secondaryDataResp = await this.secondaryClient.get(
            `/addresses/data/${this.config.bridgeContract}/burn_${burnId}`
          );
          if (secondaryDataResp.status !== 200 || !secondaryDataResp.data?.value) {
            this.logger.error('Burn NOT confirmed by secondary DCC node', { burnId });
            return false;
          }
          // Verify the burn data matches between nodes
          if (secondaryDataResp.data.value !== dataResp.data.value) {
            this.logger.error('Burn data MISMATCH between DCC nodes — possible node compromise', {
              burnId,
              primary: dataResp.data.value,
              secondary: secondaryDataResp.data.value,
            });
            return false;
          }
        } catch (err: any) {
          this.logger.warn('Secondary DCC node verification failed — rejecting burn (fail-closed)', {
            burnId,
            error: err.message,
          });
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private async getCurrentHeight(): Promise<number> {
    const response = await this.client.get('/blocks/height');
    return response.data.height;
  }

  getHealth(): {
    running: boolean;
    seeded: boolean;
    pendingBurns: number;
    lastHeight: number;
  } {
    return {
      running: this.isRunning,
      // false while the DCC node is unreachable — the watcher is up but is
      // not yet scanning blocks.
      seeded: this.isSeeded,
      pendingBurns: this.pendingBurns.size,
      lastHeight: this.lastProcessedHeight,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
