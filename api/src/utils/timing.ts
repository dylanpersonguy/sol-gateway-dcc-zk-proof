// ═══════════════════════════════════════════════════════════════
// TRANSFER TIMING — derived from confirmation settings, not guessed
// ═══════════════════════════════════════════════════════════════

/**
 * How long a transfer takes, computed from the confirmations each side waits
 * for and the measured block cadence of each chain.
 *
 * These were hardcoded strings that drifted from reality: redemption advertised
 * "3-10 minutes" while requiring 10 DCC confirmations, which at ~60s a block is
 * ~10 minutes at best. A user watching a progress bar pass its own estimate
 * reasonably concludes the funds are stuck.
 */

/** Measured on DCC mainnet: key blocks, median ~60s (NG microblocks do not advance height). */
const DCC_BLOCK_SECONDS = 60;
/** Solana slot time, ~0.4s. */
const SOLANA_SLOT_SECONDS = 0.4;
/** Consensus, submission and inclusion overhead beyond pure finality. */
const OVERHEAD_SECONDS = 30;

function humanize(seconds: number): string {
  if (seconds < 90) return `~${Math.round(seconds / 15) * 15} seconds`;
  const lo = Math.floor(seconds / 60);
  return `~${lo}-${lo + 2} minutes`;
}

/** SOL -> DCC: Solana finality, then a DCC block to include the mint. */
export function estimatedMintTime(): string {
  const confirmations = parseInt(process.env.SOLANA_CONFIRMATIONS || '32', 10);
  return humanize(confirmations * SOLANA_SLOT_SECONDS + DCC_BLOCK_SECONDS);
}

/** DCC -> SOL: DCC finality dominates; the Solana unlock itself is seconds. */
export function estimatedUnlockTime(): string {
  const confirmations = parseInt(process.env.DCC_CONFIRMATIONS || '3', 10);
  return humanize(confirmations * DCC_BLOCK_SECONDS + OVERHEAD_SECONDS);
}

/** Exposed so the UI can show progress against the same numbers. */
export function timingDetail() {
  const solConf = parseInt(process.env.SOLANA_CONFIRMATIONS || '32', 10);
  const dccConf = parseInt(process.env.DCC_CONFIRMATIONS || '3', 10);
  return {
    solanaConfirmations: solConf,
    dccConfirmations: dccConf,
    estimatedMintSeconds: Math.round(solConf * SOLANA_SLOT_SECONDS + DCC_BLOCK_SECONDS),
    estimatedUnlockSeconds: Math.round(dccConf * DCC_BLOCK_SECONDS + OVERHEAD_SECONDS),
  };
}
