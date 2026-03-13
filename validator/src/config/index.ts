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

export function loadConfig(): ValidatorConfig {
  return {
    nodeId: requireEnv('VALIDATOR_NODE_ID'),
    privateKeyPath: requireEnv('VALIDATOR_PRIVATE_KEY_PATH'),

    solanaRpcUrl: requireEnv('SOLANA_RPC_URL'),
    solanaWsUrl: process.env.SOLANA_WS_URL || '',
    solanaProgramId: requireEnv('SOLANA_PROGRAM_ID'),
    solanaVaultPda: requireEnv('SOLANA_VAULT_PDA'),

    dccNodeUrl: requireEnv('DCC_NODE_URL'),
    dccBridgeContract: requireEnv('DCC_BRIDGE_CONTRACT'),
    dccDusdContract: process.env.DCC_DUSD_CONTRACT || '3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW',
    dccChainId: parseInt(process.env.DCC_CHAIN_ID || '63'),
    dccChainIdChar: process.env.DCC_CHAIN_ID_CHAR || '?',
    dccSeed: requireEnv('DCC_VALIDATOR_SEED'),
    wsolAssetId: process.env.SOL_ASSET_ID || process.env.WSOL_ASSET_ID || requireEnv('SOL_ASSET_ID'),

    minValidators: parseInt(process.env.MIN_VALIDATORS || '3'),
    consensusTimeoutMs: parseInt(process.env.CONSENSUS_TIMEOUT_MS || '30000'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),

    solanaRequiredConfirmations: parseInt(process.env.SOLANA_CONFIRMATIONS || '32'),
    dccRequiredConfirmations: parseInt(process.env.DCC_CONFIRMATIONS || '10'),
    reorgProtectionSlots: parseInt(process.env.REORG_PROTECTION_SLOTS || '50'),

    maxDailyOutflowLamports: BigInt(process.env.MAX_DAILY_OUTFLOW || '1000000000000'),
    maxSingleTxLamports: BigInt(process.env.MAX_SINGLE_TX || '100000000000'),
    minDepositLamports: BigInt(process.env.MIN_DEPOSIT || '1000000'),

    metricsPort: parseInt(process.env.METRICS_PORT || '9090'),
    healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '8080'),

    bootstrapPeers: (process.env.BOOTSTRAP_PEERS || '').split(',').filter(Boolean),
    p2pPort: parseInt(process.env.P2P_PORT || '9000'),

    dbPath: process.env.DB_PATH || './data/validator.db',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

    hsmEnabled: process.env.HSM_ENABLED === 'true',
    hsmSlot: parseInt(process.env.HSM_SLOT || '0'),
    hsmPin: process.env.HSM_PIN || '',
    keyRotationIntervalHours: parseInt(process.env.KEY_ROTATION_HOURS || '168'),

    // Bridge Fees
    depositFeeRateCommittee: parseFloat(process.env.DEPOSIT_FEE_RATE_COMMITTEE || '0.001'),
    depositFeeRateZk: parseFloat(process.env.DEPOSIT_FEE_RATE_ZK || '0.0015'),
    withdrawalFeeRateCommittee: parseFloat(process.env.WITHDRAWAL_FEE_RATE_COMMITTEE || '0.0025'),
    withdrawalFeeRateZk: parseFloat(process.env.WITHDRAWAL_FEE_RATE_ZK || '0.005'),
    minFeeLamports: BigInt(process.env.MIN_FEE_LAMPORTS || '1000000'), // 0.001 SOL

    // ZK Bridge (Phase 2)
    zkVerifierContract: process.env.DCC_ZK_VERIFIER_CONTRACT || '',
    zkWasmPath: process.env.ZK_WASM_PATH || 'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm',
    zkZkeyPath: process.env.ZK_ZKEY_PATH || 'zk/circuits/build/bridge_deposit_final.zkey',
    zkVkeyPath: process.env.ZK_VKEY_PATH || 'zk/circuits/build/verification_key.json',
    zkCheckpointWindowMs: parseInt(process.env.ZK_CHECKPOINT_WINDOW_MS || '60000'),
    zkMaxEventsPerCheckpoint: parseInt(process.env.ZK_MAX_EVENTS_PER_CHECKPOINT || '100'),

    // Beta Safety Caps
    zkOnlyThresholdLamports: BigInt(process.env.ZK_ONLY_THRESHOLD_LAMPORTS || '0'),
    disableZkPath: process.env.DISABLE_ZK_PATH === 'true',
    fullProduction: process.env.FULL_PRODUCTION === 'true',
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
