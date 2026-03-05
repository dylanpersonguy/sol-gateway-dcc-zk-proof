// ═══════════════════════════════════════════════════════════════
// BRIDGE FEE CALCULATOR — Validator Utility
// ═══════════════════════════════════════════════════════════════
//
// Calculates bridge fees and returns the fee-adjusted mint/unlock
// amount. Fees stay in the vault as surplus SOL (protocol revenue).
//
// Fee destination: Vault PDA (A2CMs9oPjSW46NvQDKFDqBqxj9EMvoJbTKkJJP9WK96U)
// The vault accumulates a surplus: vault_balance > total_minted_dcc.
// Authority can withdraw accumulated fees via a future program upgrade.

import { ValidatorConfig } from '../config';
import { createLogger } from './logger';

const logger = createLogger('FeeCalculator');

export interface FeeResult {
  /** Original deposit/burn amount in lamports */
  originalAmountLamports: bigint;
  /** Fee amount in lamports */
  feeLamports: bigint;
  /** Amount after fee deduction in lamports */
  netAmountLamports: bigint;
  /** Fee rate applied (decimal) */
  feeRate: number;
  /** Fee rate display string */
  feeDisplay: string;
  /** Routing path */
  path: 'committee' | 'zk';
  /** Transfer direction */
  direction: 'deposit' | 'withdrawal';
}

const ZK_THRESHOLD_LAMPORTS = BigInt(process.env.ZK_ONLY_THRESHOLD_LAMPORTS || '100000000000'); // 100 SOL

/**
 * Calculate the bridge fee for a deposit (SOL → DCC mint).
 * Returns the net amount to mint on DCC.
 */
export function calculateDepositFee(
  amountLamports: bigint,
  config: ValidatorConfig,
): FeeResult {
  const useZk = amountLamports >= ZK_THRESHOLD_LAMPORTS;
  const feeRate = useZk ? config.depositFeeRateZk : config.depositFeeRateCommittee;
  const feeDisplay = useZk ? '0.15%' : '0.10%';

  const calculatedFee = BigInt(Math.floor(Number(amountLamports) * feeRate));
  const feeLamports = calculatedFee < config.minFeeLamports
    ? config.minFeeLamports
    : calculatedFee;

  // Ensure net amount is never negative
  const netAmountLamports = amountLamports > feeLamports
    ? amountLamports - feeLamports
    : 0n;

  return {
    originalAmountLamports: amountLamports,
    feeLamports,
    netAmountLamports,
    feeRate,
    feeDisplay,
    path: useZk ? 'zk' : 'committee',
    direction: 'deposit',
  };
}

/**
 * Calculate the bridge fee for a withdrawal (DCC burn → SOL unlock).
 * Returns the net amount to unlock on Solana.
 */
export function calculateWithdrawalFee(
  amountLamports: bigint,
  config: ValidatorConfig,
): FeeResult {
  const useZk = amountLamports >= ZK_THRESHOLD_LAMPORTS;
  const feeRate = useZk ? config.withdrawalFeeRateZk : config.withdrawalFeeRateCommittee;
  const feeDisplay = useZk ? '0.50%' : '0.25%';

  const calculatedFee = BigInt(Math.floor(Number(amountLamports) * feeRate));
  const feeLamports = calculatedFee < config.minFeeLamports
    ? config.minFeeLamports
    : calculatedFee;

  const netAmountLamports = amountLamports > feeLamports
    ? amountLamports - feeLamports
    : 0n;

  return {
    originalAmountLamports: amountLamports,
    feeLamports,
    netAmountLamports,
    feeRate,
    feeDisplay,
    path: useZk ? 'zk' : 'committee',
    direction: 'withdrawal',
  };
}

/**
 * Log fee calculation details for auditing.
 */
export function logFee(fee: FeeResult, transferId: string): void {
  logger.info('Bridge fee calculated', {
    transferId,
    direction: fee.direction,
    path: fee.path,
    feeRate: fee.feeDisplay,
    originalLamports: fee.originalAmountLamports.toString(),
    feeLamports: fee.feeLamports.toString(),
    netLamports: fee.netAmountLamports.toString(),
    originalSOL: (Number(fee.originalAmountLamports) / 1e9).toFixed(9),
    feeSOL: (Number(fee.feeLamports) / 1e9).toFixed(9),
    netSOL: (Number(fee.netAmountLamports) / 1e9).toFixed(9),
  });
}
