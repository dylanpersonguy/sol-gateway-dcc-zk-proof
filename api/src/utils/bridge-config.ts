// ═══════════════════════════════════════════════════════════════
// BRIDGE CONFIG READER — decode the on-chain BridgeConfig account
// ═══════════════════════════════════════════════════════════════

import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Field offsets for the BridgeConfig account, from
 * programs/sol-bridge-lock/src/state.rs. Borsh packs fields with no
 * alignment padding, so these are simply sequential.
 *
 * Keep in sync with the Rust struct — a mismatch here silently returns
 * plausible-looking garbage rather than failing.
 */
const OFF = {
  paused: 72,
  globalNonce: 73,
  totalLocked: 81,
  totalUnlocked: 89,
  validatorCount: 97,
  minValidators: 98,
  maxValidators: 99,
  minDeposit: 100,
  maxDeposit: 108,
  maxDailyOutflow: 116,
  currentDailyOutflow: 124,
  lastDailyReset: 132,
  maxUnlockAmount: 140,
  requiredConfirmations: 148,
  largeWithdrawalDelay: 150,
  largeWithdrawalThreshold: 158,
} as const;

/** Total size of the fields above — a shorter account means a layout mismatch. */
const MIN_LEN = OFF.largeWithdrawalThreshold + 8;

export interface BridgeConfigState {
  paused: boolean;
  totalLocked: bigint;
  totalUnlocked: bigint;
  validatorCount: number;
  minValidators: number;
  minDeposit: bigint;
  maxDeposit: bigint;
  maxDailyOutflow: bigint;
  currentDailyOutflow: bigint;
  maxUnlockAmount: bigint;
  requiredConfirmations: number;
  largeWithdrawalDelay: bigint;
  largeWithdrawalThreshold: bigint;
}

/** Lamports (bigint) to a SOL string. */
export function lamportsToSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toString();
}

/**
 * Read and decode the on-chain BridgeConfig.
 * Returns null when the program ID is unset or the account is missing or
 * shorter than the known layout — callers fall back to their defaults.
 */
export async function readBridgeConfig(
  programIdStr = process.env.SOLANA_PROGRAM_ID,
  rpcUrl = process.env.SOLANA_RPC_URL,
): Promise<BridgeConfigState | null> {
  if (!programIdStr || !rpcUrl) return null;

  const programId = new PublicKey(programIdStr);
  const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId,
  );

  const accountInfo = await new Connection(rpcUrl).getAccountInfo(bridgeConfigPda);
  const data = accountInfo?.data;
  if (!data || data.length < MIN_LEN) return null;

  return {
    paused: data[OFF.paused] !== 0,
    totalLocked: data.readBigUInt64LE(OFF.totalLocked),
    totalUnlocked: data.readBigUInt64LE(OFF.totalUnlocked),
    validatorCount: data[OFF.validatorCount],
    minValidators: data[OFF.minValidators],
    minDeposit: data.readBigUInt64LE(OFF.minDeposit),
    maxDeposit: data.readBigUInt64LE(OFF.maxDeposit),
    maxDailyOutflow: data.readBigUInt64LE(OFF.maxDailyOutflow),
    currentDailyOutflow: data.readBigUInt64LE(OFF.currentDailyOutflow),
    maxUnlockAmount: data.readBigUInt64LE(OFF.maxUnlockAmount),
    requiredConfirmations: data.readUInt16LE(OFF.requiredConfirmations),
    largeWithdrawalDelay: data.readBigInt64LE(OFF.largeWithdrawalDelay),
    largeWithdrawalThreshold: data.readBigUInt64LE(OFF.largeWithdrawalThreshold),
  };
}
