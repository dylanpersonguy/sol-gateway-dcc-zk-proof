// ═══════════════════════════════════════════════════════════════
// VALIDATOR NODE — Configuration
// ═══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export interface ValidatorConfig {
  // ── Node Identity ──
  nodeId: string;
  privateKeyPath: string;

  // ── Solana Connection ──
  solanaRpcUrl: string;
  solanaWsUrl: string;
  solanaProgramId: string;
  solanaVaultPda: string;

  // ── DecentralChain Connection ──
  dccNodeUrl: string;
  dccBridgeContract: string;
  /** DUSD stablecoin contract — receives mintDusd() calls for USDC/USDT deposits */
  dccDusdContract: string;
  dccChainId: number;
  dccChainIdChar: string;   // '?' for mainnet (produces 3D... addresses)
  dccSeed: string;           // Validator's DCC seed phrase for signing mints
  wsolAssetId: string;       // SOL.DCC asset ID on DecentralChain

  // ── Consensus ──
  minValidators: number;
  consensusTimeoutMs: number;
  maxRetries: number;

  // ── Finality ──
  solanaRequiredConfirmations: number;
  dccRequiredConfirmations: number;
  reorgProtectionSlots: number;

  // ── Rate Limits ──
  maxDailyOutflowLamports: bigint;
  maxSingleTxLamports: bigint;
  minDepositLamports: bigint;

  // ── Monitoring ──
  metricsPort: number;
  healthCheckPort: number;

  // ── Peer Discovery ──
  bootstrapPeers: string[];
  p2pPort: number;

  // ── Storage ──
  dbPath: string;
  redisUrl: string;

  // ── Security ──
  hsmEnabled: boolean;
  hsmSlot: number;
  hsmPin: string;
  keyRotationIntervalHours: number;

  // ── Bridge Fees ──
  depositFeeRateCommittee: number;  // 0.001 = 0.10%
  depositFeeRateZk: number;         // 0.0015 = 0.15%
  withdrawalFeeRateCommittee: number; // 0.0025 = 0.25%
  withdrawalFeeRateZk: number;      // 0.005 = 0.50%
  minFeeLamports: bigint;           // 1_000_000 = 0.001 SOL

  // ── ZK Bridge (Phase 2) ──
  zkVerifierContract: string;
  zkWasmPath: string;
  zkZkeyPath: string;
  zkVkeyPath: string;
  zkCheckpointWindowMs: number;
  zkMaxEventsPerCheckpoint: number;

  // ── Beta Safety Caps ──
  /** Threshold in lamports above which ZK proof is REQUIRED (committee alone rejected) */
  zkOnlyThresholdLamports: bigint;
  /** Kill switch: if true, ZK proof path is completely disabled */
  disableZkPath: boolean;
  /** If true, block startup unless all RELEASE_GUARD prerequisites are met */
  fullProduction: boolean;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function envInt(key: string, fallback: number): number {
  return parseInt(process.env[key] || String(fallback));
}

function envFloat(key: string, fallback: number): number {
  return parseFloat(process.env[key] || String(fallback));
}

function envBigInt(key: string, fallback: string): bigint {
  return BigInt(process.env[key] || fallback);
}

function envBool(key: string): boolean {
  return process.env[key] === 'true';
}

function parseSolanaConfig() {
  return {
    solanaRpcUrl: requireEnv('SOLANA_RPC_URL'),
    solanaWsUrl: envStr('SOLANA_WS_URL', ''),
    solanaProgramId: requireEnv('SOLANA_PROGRAM_ID'),
    solanaVaultPda: requireEnv('SOLANA_VAULT_PDA'),
    solanaRequiredConfirmations: envInt('SOLANA_CONFIRMATIONS', 32),
  };
}

function parseDccConfig() {
  return {
    dccNodeUrl: requireEnv('DCC_NODE_URL'),
    dccBridgeContract: requireEnv('DCC_BRIDGE_CONTRACT'),
    dccDusdContract: envStr('DCC_DUSD_CONTRACT', '3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW'),
    dccChainId: envInt('DCC_CHAIN_ID', 63),
    dccChainIdChar: envStr('DCC_CHAIN_ID_CHAR', '?'),
    dccSeed: requireEnv('DCC_VALIDATOR_SEED'),
    wsolAssetId: process.env.SOL_ASSET_ID || process.env.WSOL_ASSET_ID || requireEnv('SOL_ASSET_ID'),
    dccRequiredConfirmations: envInt('DCC_CONFIRMATIONS', 10),
  };
}

function parseConsensusConfig() {
  return {
    minValidators: envInt('MIN_VALIDATORS', 3),
    consensusTimeoutMs: envInt('CONSENSUS_TIMEOUT_MS', 30000),
    maxRetries: envInt('MAX_RETRIES', 3),
    reorgProtectionSlots: envInt('REORG_PROTECTION_SLOTS', 50),
  };
}

function parseRateLimits() {
  return {
    maxDailyOutflowLamports: envBigInt('MAX_DAILY_OUTFLOW', '1000000000000'),
    maxSingleTxLamports: envBigInt('MAX_SINGLE_TX', '100000000000'),
    minDepositLamports: envBigInt('MIN_DEPOSIT', '1000000'),
  };
}

function parseFeeConfig() {
  return {
    depositFeeRateCommittee: envFloat('DEPOSIT_FEE_RATE_COMMITTEE', 0.001),
    depositFeeRateZk: envFloat('DEPOSIT_FEE_RATE_ZK', 0.0015),
    withdrawalFeeRateCommittee: envFloat('WITHDRAWAL_FEE_RATE_COMMITTEE', 0.0025),
    withdrawalFeeRateZk: envFloat('WITHDRAWAL_FEE_RATE_ZK', 0.005),
    minFeeLamports: envBigInt('MIN_FEE_LAMPORTS', '1000000'),
  };
}

function parseZkConfig() {
  return {
    zkVerifierContract: envStr('DCC_ZK_VERIFIER_CONTRACT', ''),
    zkWasmPath: envStr('ZK_WASM_PATH', 'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm'),
    zkZkeyPath: envStr('ZK_ZKEY_PATH', 'zk/circuits/build/bridge_deposit_final.zkey'),
    zkVkeyPath: envStr('ZK_VKEY_PATH', 'zk/circuits/build/verification_key.json'),
    zkCheckpointWindowMs: envInt('ZK_CHECKPOINT_WINDOW_MS', 60000),
    zkMaxEventsPerCheckpoint: envInt('ZK_MAX_EVENTS_PER_CHECKPOINT', 100),
    zkOnlyThresholdLamports: envBigInt('ZK_ONLY_THRESHOLD_LAMPORTS', '0'),
    disableZkPath: envBool('DISABLE_ZK_PATH'),
    fullProduction: envBool('FULL_PRODUCTION'),
  };
}

function parseInfraConfig() {
  return {
    metricsPort: envInt('METRICS_PORT', 9090),
    healthCheckPort: envInt('HEALTH_CHECK_PORT', 8080),
    bootstrapPeers: (process.env.BOOTSTRAP_PEERS || '').split(',').filter(Boolean),
    p2pPort: envInt('P2P_PORT', 9000),
    dbPath: envStr('DB_PATH', './data/validator.db'),
    redisUrl: envStr('REDIS_URL', 'redis://localhost:6379'),
  };
}

function parseSecurityConfig() {
  return {
    hsmEnabled: envBool('HSM_ENABLED'),
    hsmSlot: envInt('HSM_SLOT', 0),
    hsmPin: envStr('HSM_PIN', ''),
    keyRotationIntervalHours: envInt('KEY_ROTATION_HOURS', 168),
  };
}

export function loadConfig(): ValidatorConfig {
  return {
    nodeId: requireEnv('VALIDATOR_NODE_ID'),
    privateKeyPath: requireEnv('VALIDATOR_PRIVATE_KEY_PATH'),
    ...parseSolanaConfig(),
    ...parseDccConfig(),
    ...parseConsensusConfig(),
    ...parseRateLimits(),
    ...parseFeeConfig(),
    ...parseZkConfig(),
    ...parseInfraConfig(),
    ...parseSecurityConfig(),
  };
}
