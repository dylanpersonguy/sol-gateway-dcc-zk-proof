// ═══════════════════════════════════════════════════════════════
// VALIDATOR NODE — Configuration
// ═══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

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
  dccChainId: number;
  dccChainIdChar: string;   // '?' for mainnet (produces 3D... addresses)
  dccSeed: string;           // Validator's DCC seed phrase for signing mints
  wsolAssetId: string;       // wSOL.DCC asset ID on DecentralChain

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
    dccChainId: parseInt(process.env.DCC_CHAIN_ID || '63'),
    dccChainIdChar: process.env.DCC_CHAIN_ID_CHAR || '?',
    dccSeed: requireEnv('DCC_VALIDATOR_SEED'),
    wsolAssetId: requireEnv('WSOL_ASSET_ID'),

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
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
