// ═══════════════════════════════════════════════════════════════
// RATE LIMITER — Enforces daily outflow & per-tx limits (M-2)
// ═══════════════════════════════════════════════════════════════
//
// Tracks cumulative daily outflow (resets every 24 h window)
// and rejects individual transactions that exceed the single-tx cap.

import * as fs from 'fs';
import * as path from 'path';

export interface RateLimiterConfig {
  maxDailyOutflowLamports: bigint;
  maxSingleTxLamports: bigint;
  minDepositLamports: bigint;
  /** SECURITY FIX (VAL-3): Path to persist rate limiter state. */
  statePath?: string;
}

export class RateLimiter {
  private config: RateLimiterConfig;
  private dailyOutflow: bigint = 0n;
  private windowStart: number;

  private static readonly WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.windowStart = Date.now();
    // SECURITY FIX (VAL-3): Load persisted state from disk to survive restarts.
    this.loadState();
  }

  /**
   * Try to consume `amount` from the daily budget.
   * Returns true if allowed, false if it would exceed the daily limit.
   */
  tryConsume(amount: bigint): boolean {
    this.maybeResetWindow();

    if (this.dailyOutflow + amount > this.config.maxDailyOutflowLamports) {
      return false;
    }

    this.dailyOutflow += amount;
    this.persistState();
    return true;
  }

  /**
   * SECURITY FIX (VAL-5): Check if amount CAN be consumed without actually
   * consuming it. Use this before consensus, then call consume() after
   * consensus succeeds. Prevents DoS via budget drain on failed consensus.
   */
  canConsume(amount: bigint): boolean {
    this.maybeResetWindow();

    return (this.dailyOutflow + amount) <= this.config.maxDailyOutflowLamports;
  }

  /**
   * Actually consume amount from the daily budget (call AFTER consensus success).
   */
  consume(amount: bigint): boolean {
    this.maybeResetWindow();

    if (this.dailyOutflow + amount > this.config.maxDailyOutflowLamports) {
      return false;
    }

    this.dailyOutflow += amount;
    this.persistState();
    return true;
  }

  /**
   * Check a single-tx amount against the per-tx cap.
   */
  checkSingleTx(amount: bigint): boolean {
    return amount <= this.config.maxSingleTxLamports;
  }

  /**
   * Check minimum deposit.
   */
  checkMinDeposit(amount: bigint): boolean {
    return amount >= this.config.minDepositLamports;
  }

  /**
   * Reset the daily window if 24 hours have elapsed.
   */
  private maybeResetWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= RateLimiter.WINDOW_MS) {
      this.dailyOutflow = 0n;
      this.windowStart = now;
      this.persistState();
    }
  }

  /**
   * SECURITY FIX (VAL-3): Load rate limiter state from disk.
   * Prevents restart-based DoS that resets daily limits to zero.
   */
  private loadState(): void {
    const filePath = this.config.statePath || './data/rate-limiter-state.json';
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.dailyOutflow && data.windowStart) {
          const savedWindowStart = Number(data.windowStart);
          // Only restore if the saved window is still active (within 24h)
          if (Date.now() - savedWindowStart < RateLimiter.WINDOW_MS) {
            this.dailyOutflow = BigInt(data.dailyOutflow);
            this.windowStart = savedWindowStart;
          }
        }
      }
    } catch {
      // Fail open on load — start fresh if corrupt/missing
    }
  }

  /**
   * SECURITY FIX (VAL-3): Persist rate limiter state to disk.
   */
  private persistState(): void {
    const filePath = this.config.statePath || './data/rate-limiter-state.json';
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify({
        dailyOutflow: this.dailyOutflow.toString(),
        windowStart: this.windowStart,
      }), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }

  /**
   * Get current daily outflow stats (for health endpoint).
   */
  getStats(): { dailyOutflow: string; maxDaily: string; windowResetMs: number } {
    this.maybeResetWindow();
    return {
      dailyOutflow: this.dailyOutflow.toString(),
      maxDaily: this.config.maxDailyOutflowLamports.toString(),
      windowResetMs: RateLimiter.WINDOW_MS - (Date.now() - this.windowStart),
    };
  }
}
