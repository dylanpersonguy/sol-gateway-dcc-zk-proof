// ═══════════════════════════════════════════════════════════════
// BRIDGE FEE CALCULATION — API Utility
// ═══════════════════════════════════════════════════════════════
//
// Server-side fee calculation. This mirrors the frontend fee config
// but is the authoritative source for fee quotes.

export interface FeeSchedule {
  /** Fee rate as a decimal (0.001 = 0.1%) */
  rate: number;
  /** Human-readable percentage string */
  display: string;
}

export interface FeeQuote {
  inputAmount: number;
  feeAmount: number;
  receiveAmount: number;
  feeRate: number;
  feeDisplay: string;
  path: 'committee' | 'zk';
  direction: 'deposit' | 'withdrawal';
  minFeeApplied: boolean;
}

// ── Fee Rates ──

/** Deposit fees (SOL → DCC): lower to attract TVL */
const DEPOSIT_FEE_COMMITTEE: FeeSchedule = { rate: 0.001,  display: '0.10%' };
const DEPOSIT_FEE_ZK:        FeeSchedule = { rate: 0.0015, display: '0.15%' };

/** Withdrawal fees (DCC → SOL): higher to protect vault */
const WITHDRAWAL_FEE_COMMITTEE: FeeSchedule = { rate: 0.0025, display: '0.25%' };
const WITHDRAWAL_FEE_ZK:        FeeSchedule = { rate: 0.005,  display: '0.50%' };

/** Minimum fee in SOL */
const MIN_FEE_SOL = 0.001;

/** ZK threshold in SOL */
const ZK_THRESHOLD_SOL = 100;

/** All fee schedules for the /fees endpoint */
export const FEE_SCHEDULES = {
  deposit: {
    committee: DEPOSIT_FEE_COMMITTEE,
    zk: DEPOSIT_FEE_ZK,
  },
  withdrawal: {
    committee: WITHDRAWAL_FEE_COMMITTEE,
    zk: WITHDRAWAL_FEE_ZK,
  },
  minFeeSol: MIN_FEE_SOL,
  zkThresholdSol: ZK_THRESHOLD_SOL,
};

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
      minFeeApplied: false,
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

  const calculatedFee = amount * schedule.rate;
  const minFeeApplied = calculatedFee < MIN_FEE_SOL;
  const feeAmount = Math.max(calculatedFee, MIN_FEE_SOL);
  const receiveAmount = Math.max(amount - feeAmount, 0);

  return {
    inputAmount: parseFloat(amount.toFixed(9)),
    feeAmount: parseFloat(feeAmount.toFixed(9)),
    receiveAmount: parseFloat(receiveAmount.toFixed(9)),
    feeRate: schedule.rate,
    feeDisplay: schedule.display,
    path,
    direction,
    minFeeApplied,
  };
}
