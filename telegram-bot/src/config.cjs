'use strict';
/**
 * Configuration loader — reads from .env (or process.env for production)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

const config = {
  // Telegram
  botToken: required('BOT_TOKEN'),

  // Wallet derivation
  masterSecret: required('MASTER_SECRET'),

  // DCC bridge
  dccBridgeContract: process.env.DCC_BRIDGE_CONTRACT || '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG',
  dccNodeUrl:        process.env.DCC_NODE_URL        || 'https://mainnet-node.decentralchain.io',
  dccChainIdChar:    process.env.DCC_CHAIN_ID_CHAR   || '?',
  dccValidatorSeed:  process.env.DCC_VALIDATOR_SEED  || '',
  dccValidatorNonce: parseInt(process.env.DCC_VALIDATOR_NONCE || '1', 10),
  dccApiKey:         process.env.DCC_API_KEY          || '',

  // Solana
  solRpcUrl:   process.env.SOL_RPC_URL   || 'https://api.devnet.solana.com',
  solProgramId: process.env.SOL_PROGRAM_ID || '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF',
  solAssetId:  process.env.SOL_ASSET_ID  || '',

  // Storage
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bridge-bot.db'),

  // Monitor
  solPollIntervalMs: parseInt(process.env.SOL_POLL_INTERVAL_MS || '12000', 10),
  dccPollIntervalMs: parseInt(process.env.DCC_POLL_INTERVAL_MS || '15000', 10),

  // Validator consensus
  validatorEndpoints: (process.env.VALIDATOR_ENDPOINTS || '').split(',').filter(Boolean),
  useConsensus: process.env.USE_CONSENSUS === 'true',

  // Limits
  minAmountUsdc: parseFloat(process.env.MIN_AMOUNT_USDC || '0.5'),
  maxAmountUsdc: parseFloat(process.env.MAX_AMOUNT_USDC || '10000'),
};

module.exports = config;
