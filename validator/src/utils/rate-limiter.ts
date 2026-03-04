// ═══════════════════════════════════════════════════════════════
// RATE LIMITER — Enforces daily outflow & per-tx limits (M-2)
// ═══════════════════════════════════════════════════════════════
//
// Tracks cumulative daily outflow (resets every 24 h window)
// and rejects individual transactions that exceed the single-tx cap.

export interface RateLimiterConfig {
  maxDailyOutflowLamports: bigint;
  maxSingleTxLamports: bigint;
  minDepositLamports: bigint;
}

export class RateLimiter {
  private config: RateLimiterConfig;
  private dailyOutflow: bigint = 0n;
  private windowStart: number;

  private static readonly WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.windowStart = Date.now();
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
