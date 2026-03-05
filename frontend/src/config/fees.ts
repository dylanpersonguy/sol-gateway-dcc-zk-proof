// ═══════════════════════════════════════════════════════════════
// BRIDGE FEE CONFIGURATION
// ═══════════════════════════════════════════════════════════════
//
// Fee schedule for SOL ⇄ DCC bridge transfers. Fees are displayed
// to users in the frontend and calculated by the API. On-chain
// enforcement is planned for a future update.
//
// Fee rationale:
//   - Deposits are cheap to attract TVL
//   - Withdrawals are more expensive (vault drainage risk)
//   - ZK path costs more (compute overhead)
//   - Minimum fee floor covers transaction costs on micro-transfers

export interface FeeSchedule {
  /** Fee rate as a decimal (0.001 = 0.1%) */
  rate: number;
  /** Human-readable percentage string */
  display: string;
}

export interface FeeQuote {
  /** Original amount in SOL */
  inputAmount: number;
  /** Fee amount in SOL */
  feeAmount: number;
  /** Amount after fee deduction */
  receiveAmount: number;
  /** Fee rate applied (decimal) */
  feeRate: number;
  /** Fee rate display string */
  feeDisplay: string;
  /** Which path was used for fee calculation */
  path: 'committee' | 'zk';
  /** Direction of the transfer */
  direction: 'deposit' | 'withdrawal';
}

// ── Fee Rates ──

/** Deposit fees (SOL → DCC): lower to attract TVL */
export const DEPOSIT_FEE_COMMITTEE: FeeSchedule = {
  rate: 0.001,     // 0.10%
  display: '0.10%',
};

export const DEPOSIT_FEE_ZK: FeeSchedule = {
  rate: 0.0015,    // 0.15%
  display: '0.15%',
};

/** Withdrawal fees (DCC → SOL): higher to protect vault */
export const WITHDRAWAL_FEE_COMMITTEE: FeeSchedule = {
  rate: 0.0025,    // 0.25%
  display: '0.25%',
};

export const WITHDRAWAL_FEE_ZK: FeeSchedule = {
  rate: 0.005,     // 0.50%
  display: '0.50%',
};

/** Minimum fee in SOL — ensures micro-transfers cover costs */
export const MIN_FEE_SOL = 0.001;

/** ZK threshold in SOL — amounts >= this use ZK path */
export const ZK_THRESHOLD_SOL = 100;

// ── Fee Calculation ──

/**
 * Calculate the bridge fee for a given amount and direction.
 */
export function calculateFee(
  amount: number,
  direction: 'deposit' | 'withdrawal',
): FeeQuote {
  if (amount <= 0 || isNaN(amount)) {
    return {
      inputAmount: 0,
      feeAmount: 0,
      receiveAmount: 0,
      feeRate: 0,
      feeDisplay: '0%',
      path: 'committee',
      direction,
    };
  }

  const useZk = amount >= ZK_THRESHOLD_SOL;
  const path = useZk ? 'zk' : 'committee';

  let schedule: FeeSchedule;
  if (direction === 'deposit') {
    schedule = useZk ? DEPOSIT_FEE_ZK : DEPOSIT_FEE_COMMITTEE;
  } else {
    schedule = useZk ? WITHDRAWAL_FEE_ZK : WITHDRAWAL_FEE_COMMITTEE;
  }

  // Calculate fee with minimum floor
  const calculatedFee = amount * schedule.rate;
  const feeAmount = Math.max(calculatedFee, MIN_FEE_SOL);

  // Ensure receive amount is never negative
  const receiveAmount = Math.max(amount - feeAmount, 0);

  return {
    inputAmount: amount,
    feeAmount: parseFloat(feeAmount.toFixed(9)),
    receiveAmount: parseFloat(receiveAmount.toFixed(9)),
    feeRate: schedule.rate,
    feeDisplay: schedule.display,
    path,
    direction,
  };
}

/**
 * Format a fee amount for display, showing appropriate decimal places.
 */
export function formatFeeAmount(amount: number): string {
  if (amount === 0) return '0';
  if (amount < 0.001) return amount.toFixed(9);
  if (amount < 1) return amount.toFixed(6);
  return amount.toFixed(4);
}
