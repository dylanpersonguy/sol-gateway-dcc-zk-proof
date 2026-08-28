// ═══════════════════════════════════════════════════════════════
// DCC WATCHER — Monitors DecentralChain for burn events
// ═══════════════════════════════════════════════════════════════
//
// Watches for wSOL.DCC burn events to trigger SOL unlock on Solana.
// Must verify burns independently — never trust unverified events.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import axios, { AxiosInstance } from 'axios';
import { Logger } from 'winston';
import { createLogger } from '../utils/logger';

/** wSOL is 8dp on DecentralChain, SOL is 9dp on Solana. */
const WSOL_TO_LAMPORTS_DIVISOR = 10n;

/** Blocks to stay behind the tip so only settled blocks are scanned. */
const SCAN_LAG_BLOCKS = 1;

/**
 * How far behind the tip a persisted cursor may be and still be resumed.
 * ~1000 blocks is roughly a day at 60s. Beyond that, catching up would take
 * long enough that a deliberate sweep is the better answer, so it says so
 * loudly rather than grinding.
 */
const MAX_RESUME_GAP_BLOCKS = 1000;

/** How often to reconcile against contract state, in ms. */
const RECONCILE_INTERVAL_MS = 60_000;

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
  /** Where the scan cursor is persisted so a restart resumes rather than skips. */
  cursorPath?: string;
  /** Namespaces the persisted cursor so nodes do not share one. */
  nodeId?: string;
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
  private seenBurnIds: Set<string> = new Set();
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
        const tip = await this.getCurrentHeight();
        const resumed = this.loadCursor();

        if (resumed !== null && resumed < tip && tip - resumed <= MAX_RESUME_GAP_BLOCKS) {
          // Pick up where the last run stopped. Seeding from the tip instead
          // silently drops every burn that landed while this validator was
          // down — the funds stay locked and only a manual sweep finds them.
          this.lastProcessedHeight = resumed;
          this.logger.info('Resuming from persisted height', {
            height: resumed, tip, blocksToCatchUp: tip - resumed,
          });
        } else {
          if (resumed !== null && tip - resumed > MAX_RESUME_GAP_BLOCKS) {
            this.logger.error(
              'Persisted cursor is too far behind to catch up — burns in the gap ' +
              'will NOT be picked up and need a manual sweep',
              { resumed, tip, gap: tip - resumed, maxGap: MAX_RESUME_GAP_BLOCKS },
            );
          }
          this.lastProcessedHeight = tip;
          this.logger.info('Starting from height', { height: this.lastProcessedHeight });
        }
        this.isSeeded = true;
        this.saveCursor();
        this.loadSeenBurns();
        this.runPollLoop();
        this.runFinalityLoop();
        this.runReconcileLoop();
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

        // Stop short of the tip. A block at the current height is still being
        // formed and comes back with zero transactions; scanning it and then
        // advancing past it loses whatever lands in it moments later — which is
        // exactly how a burn goes missing with no error anywhere.
        const safeHeight = currentHeight - SCAN_LAG_BLOCKS;

        if (safeHeight > this.lastProcessedHeight) {
          for (let h = this.lastProcessedHeight + 1; h <= safeHeight; h++) {
            // Advance one block at a time, and only past blocks actually read.
            // A failed fetch used to be swallowed while the cursor moved on, so
            // the block was never revisited.
            const scanned = await this.scanBlock(h);
            if (!scanned) break;
            this.lastProcessedHeight = h;
            this.saveCursor();
          }
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
  /** Returns false if the block could not be read, so it is retried. */
  /**
   * Reconcile against contract state.
   *
   * Block scanning cannot be relied on alone here. Under NG a key block keeps
   * accumulating microblock transactions after it appears, so a block read
   * moments after the height advances can come back without a burn that is
   * later part of it — which is how a burn is missed with the cursor sitting
   * past it and nothing logged anywhere.
   *
   * The contract's own burn_ entries are authoritative and cannot race, so this
   * sweeps them periodically and picks up anything the forward scan missed,
   * whatever the cause: a microblock race, a restart, a skipped block.
   */
  private async runReconcileLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.reconcileBurns();
      } catch (err: any) {
        this.logger.warn('Burn reconciliation failed', { error: err?.message ?? err });
      }
      await sleep(RECONCILE_INTERVAL_MS);
    }
  }

  private async reconcileBurns(): Promise<void> {
    const res = await this.client.get(`/addresses/data/${this.config.bridgeContract}`);
    const entries: Array<{ key: string; value: unknown }> = res.data ?? [];

    for (const entry of entries) {
      if (!entry.key.startsWith('burn_') || entry.key.startsWith('burn_nonce_')) continue;
      if (typeof entry.value !== 'string') continue;

      const burnId = entry.key.replace('burn_', '');
      if (this.pendingBurns.has(burnId) || this.seenBurnIds.has(burnId)) continue;

      // caller | solRecipient | splMint | amount | height | timestamp
      const parts = entry.value.split('|');
      if (parts.length < 6) continue;

      const event: DccBurnEvent = {
        burnId,
        sender: parts[0],
        solRecipient: parts[1],
        splMint: parts[2],
        amount: BigInt(parts[3]) * WSOL_TO_LAMPORTS_DIVISOR,
        height: parseInt(parts[4], 10),
        timestamp: parseInt(parts[5], 10),
        txId: '',
        confirmations: 0,
      };

      // The contract record carries no transaction id, and the finality check
      // verifies the burn is in the block it claims. Recover it from the block,
      // which is long settled by the time a sweep sees it.
      const txId = await this.findBurnTxId(entry.key, event.height);
      if (!txId) {
        this.logger.warn('Reconciled burn has no locatable transaction — skipping', {
          burnId, height: event.height,
        });
        continue;
      }
      event.txId = txId;

      this.logger.warn('Burn found by reconciliation that block scanning missed', {
        burnId, height: event.height, amount: event.amount.toString(), txId,
      });
      this.pendingBurns.set(burnId, event);
      this.markSeen(burnId);
    }
  }

  /**
   * Find the transaction that wrote a burn record, by looking for the invocation
   * in the block the record names. Needed because contract state records the
   * burn but not the transaction that produced it, while finality verification
   * checks the transaction really is in that block.
   */
  private async findBurnTxId(recordKey: string, height: number): Promise<string | null> {
    try {
      const { data: block } = await this.client.get(`/blocks/at/${height}`);
      for (const tx of block?.transactions ?? []) {
        if (tx.type !== 16 || tx.dApp !== this.config.bridgeContract) continue;
        if (tx.call?.function !== 'burn' && tx.call?.function !== 'burnToken') continue;

        const { data: detail } = await this.client.get(`/transactions/info/${tx.id}`);
        const wrote = (detail?.stateChanges?.data ?? [])
          .some((e: any) => e.key === recordKey);
        if (wrote) return tx.id;
      }
    } catch (err: any) {
      this.logger.warn('Could not locate the burn transaction', { height, error: err?.message });
    }
    return null;
  }

  /** Burn ids already handled, so a sweep does not replay them. */
  private markSeen(burnId: string): void {
    this.seenBurnIds.add(burnId);
    try {
      const file = this.cursorFile().replace('cursor', 'seen-burns');
      fs.writeFileSync(file, JSON.stringify([...this.seenBurnIds]));
    } catch { /* best effort */ }
  }

  private loadSeenBurns(): void {
    try {
      const file = this.cursorFile().replace('cursor', 'seen-burns');
      for (const id of JSON.parse(fs.readFileSync(file, 'utf-8'))) this.seenBurnIds.add(id);
    } catch { /* none yet */ }
  }

  /** Path the scan cursor is written to. */
  private cursorFile(): string {
    // Namespaced by node: several validators sharing one data directory
    // would otherwise share a cursor, and one node marking work done
    // would stop the others from ever seeing it.
    const node = this.config.nodeId || 'default';
    return this.config.cursorPath || `./data/dcc-watcher-cursor-${node}.json`;
  }

  /** Last height fully scanned by a previous run, or null. */
  private loadCursor(): number | null {
    try {
      const raw = fs.readFileSync(this.cursorFile(), 'utf-8');
      const parsed = JSON.parse(raw);
      const height = Number(parsed?.lastProcessedHeight);
      return Number.isFinite(height) && height > 0 ? height : null;
    } catch {
      return null;
    }
  }

  private saveCursor(): void {
    try {
      const file = this.cursorFile();
      const dir = file.substring(0, file.lastIndexOf('/'));
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        lastProcessedHeight: this.lastProcessedHeight,
        updatedAt: Date.now(),
      }));
    } catch (err: any) {
      this.logger.warn('Could not persist the scan cursor', { error: err?.message });
    }
  }

  private async scanBlock(height: number): Promise<boolean> {
    try {
      const response = await this.client.get(`/blocks/at/${height}`);
      const block = response.data;

      if (!block || !block.transactions) return false;

      for (const tx of block.transactions) {
        await this.checkForBurnEvent(tx, height);
      }
      return true;
    } catch (err: any) {
      // Warn, not debug: a block silently skipped is a burn silently lost.
      this.logger.warn('Failed to scan block — will retry', {
        height,
        error: err?.message ?? err,
      });
      return false;
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

      // Block transactions carry no stateChanges — /blocks/at/{h} returns only
      // the transaction envelope, and the burn record lives in the state the
      // invocation wrote. Fetching it by id is what makes the record visible;
      // without this every burn was dropped here, before parsing even began.
      let full = tx;
      if (!tx.stateChanges) {
        try {
          const detail = await this.client.get(`/transactions/info/${tx.id}`);
          full = detail.data;
        } catch (err) {
          this.logger.warn('Could not fetch burn transaction detail', { txId: tx.id, error: err });
          return;
        }
      }

      const burnEvent = await this.parseBurnEvent(full, height);
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
      this.markSeen(burnEvent.burnId);
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
