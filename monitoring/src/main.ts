// ═══════════════════════════════════════════════════════════════
// MONITORING NODE — Main Entry Point
// ═══════════════════════════════════════════════════════════════
//
// Independent monitoring service that runs SEPARATELY from validators.
// This is a defense-in-depth measure — even if all validators are
// compromised, the monitor can detect anomalies and trigger pause.

import dotenv from 'dotenv';
import express from 'express';
import winston from 'winston';
import cron from 'node-cron';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { AnomalyDetector, AnomalyAlert } from './detectors/anomaly-detector';
import { AlertDispatcher } from './alerts/dispatcher';

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'bridge-monitor' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: 'logs/monitor.log' }),
  ],
});

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════');
  logger.info('  Bridge Monitor v1.0.0 — INDEPENDENT');
  logger.info('═══════════════════════════════════════');

  // Initialize chain connections
  initConnections();

  // Initialize anomaly detector
  const detector = new AnomalyDetector(
    {
      maxSupplyDriftPercent: 0.001, // 0.1% tolerance
      maxHourlyVolume: BigInt(process.env.MAX_HOURLY_VOLUME || '500000000000'), // 500 SOL
      volumeSpikeMultiplier: 10,
      largeTransactionThreshold: BigInt(process.env.LARGE_TX_THRESHOLD || '50000000000'), // 50 SOL
      maxTransactionsPerMinute: parseInt(process.env.MAX_TX_PER_MIN || '30'),
      maxValidatorFaultRate: 0.1,
      minActiveValidators: parseInt(process.env.MIN_ACTIVE_VALIDATORS || '3'),
      maxBlockLatency: 30, // seconds
      maxChainDesyncBlocks: 100,
    },
    logger
  );

  // Initialize alert dispatcher
  const alerter = new AlertDispatcher(
    {
      webhookUrl: process.env.ALERT_WEBHOOK_URL,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      pagerDutyServiceKey: process.env.PAGERDUTY_SERVICE_KEY,
    },
    logger
  );

  // Wire alerts
  detector.on('alert', async (alert: AnomalyAlert) => {
    await alerter.dispatch(alert);
  });

  detector.on('auto_pause', async (alert: AnomalyAlert) => {
    logger.error('AUTO-PAUSE TRIGGERED', { alert });
    // TODO: Call emergency pause on both chains
    // This requires guardian key access
    await triggerEmergencyPause(alert);
  });

  // ── Periodic Health Checks ──

  // Every 30 seconds: Check supply invariant + vault depletion
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await checkSupplyInvariant(detector);
    } catch (err) {
      logger.error('Supply check failed', { error: err });
    }
  });

  // Every minute: Check chain sync
  cron.schedule('* * * * *', async () => {
    try {
      await checkChainHealth(detector);
    } catch (err) {
      logger.error('Chain health check failed', { error: err });
    }
  });

  // Every 5 minutes: Check validator health
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkValidatorHealth(detector);
    } catch (err) {
      logger.error('Validator health check failed', { error: err });
    }
  });

  // Every 30 seconds: Check bridge pause state
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await checkPauseState(detector);
    } catch (err) {
      logger.error('Pause state check failed', { error: err });
    }
  });

  // Subscribe to Solana program logs for real-time unlock monitoring
  try {
    subscribeToUnlockEvents(detector);
    logger.info('Subscribed to Solana program logs for unlock events');
  } catch (err) {
    logger.warn('Could not subscribe to program logs', { error: err });
  }

  // ── Monitoring API ──
  const app = express();
  const port = parseInt(process.env.MONITOR_PORT || '9091');

  app.get('/monitor/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'bridge-monitor',
      timestamp: Date.now(),
    });
  });

  app.get('/monitor/alerts', (_req, res) => {
    res.json({
      alerts: detector.getRecentAlerts(100),
      counts: detector.getAlertCounts(),
    });
  });

  app.listen(port, () => {
    logger.info(`Monitor API on port ${port}`);
  });

  logger.info('Monitor fully operational');
}

// ── Shared connections (initialized once) ──
let solanaConnection: Connection;
let programId: PublicKey;
let vaultPda: PublicKey;
let bridgeConfigPda: PublicKey;

function initConnections(): void {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'http://localhost:8899';
  solanaConnection = new Connection(rpcUrl, 'confirmed');
  programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || '11111111111111111111111111111111');
  
  [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')],
    programId,
  );
  [bridgeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId,
  );
}

// ── Check Functions ──

async function checkSupplyInvariant(detector: AnomalyDetector): Promise<void> {
  try {
    // Query Solana vault balance
    const vaultBalance = await solanaConnection.getBalance(vaultPda);

    // Query DCC wSOL supply from the DCC node
    const dccNodeUrl = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
    const dccBridgeContract = process.env.DCC_BRIDGE_CONTRACT || '';

    let wsolSupply = BigInt(0);
    try {
      // Query the DCC bridge controller's data for total minted
      const response = await axios.get(
        `${dccNodeUrl}/addresses/data/${dccBridgeContract}/total_minted`,
        { timeout: 10000 },
      );
      if (response.data?.value !== undefined) {
        wsolSupply = BigInt(response.data.value);
      }
    } catch (dccErr: any) {
      logger.warn('Could not query DCC supply', { error: dccErr.message });
    }

    // Also read the bridge config account to get total_locked and total_unlocked
    try {
      const configInfo = await solanaConnection.getAccountInfo(bridgeConfigPda);
      if (configInfo?.data) {
        // Parse BridgeConfig: skip 8-byte discriminator
        // authority: 32, guardian: 32, paused: 1, global_nonce: 8,
        // total_locked: 8 (offset 81), total_unlocked: 8 (offset 89)
        const data = configInfo.data;
        if (data.length >= 97) {
          const totalLocked = data.readBigUInt64LE(81);
          const totalUnlocked = data.readBigUInt64LE(89);
          const netLocked = totalLocked - totalUnlocked;

          logger.info('Supply invariant check', {
            vaultBalanceLamports: vaultBalance,
            netLockedLamports: netLocked.toString(),
            wsolSupply: wsolSupply.toString(),
            driftLamports: (BigInt(vaultBalance) - netLocked).toString(),
          });

          // Run the detector's supply invariant check
          detector.checkSupplyInvariant(BigInt(vaultBalance), wsolSupply);

          // Run vault depletion rate check
          detector.checkVaultDepletion(BigInt(vaultBalance));
        }
      }
    } catch (parseErr: any) {
      logger.warn('Could not parse bridge config', { error: parseErr.message });
    }
  } catch (err: any) {
    logger.error('Supply invariant check failed', { error: err.message });
  }
}

async function checkChainHealth(detector: AnomalyDetector): Promise<void> {
  try {
    // Measure Solana latency
    const solStart = Date.now();
    const solSlot = await solanaConnection.getSlot();
    const solLatency = Date.now() - solStart;

    // Measure DCC latency
    const dccNodeUrl = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
    const dccStart = Date.now();
    let dccHeight = 0;
    try {
      const dccResponse = await axios.get(`${dccNodeUrl}/blocks/height`, {
        timeout: 10000,
      });
      dccHeight = dccResponse.data?.height || 0;
    } catch {
      // DCC node might be unreachable
    }
    const dccLatency = Date.now() - dccStart;

    logger.debug('Chain health', {
      solanaSlot: solSlot,
      solanaLatencyMs: solLatency,
      dccHeight,
      dccLatencyMs: dccLatency,
    });

    // Calculate approximate block difference (Solana ~400ms slots, DCC ~3s blocks)
    // This is a rough estimate for desync detection
    const blockDifference = Math.abs(
      Math.floor(solSlot / 7.5) - dccHeight
    );

    detector.checkChainSync(solLatency / 1000, dccLatency / 1000, blockDifference);
  } catch (err: any) {
    logger.error('Chain health check failed', { error: err.message });
  }
}

async function checkValidatorHealth(detector: AnomalyDetector): Promise<void> {
  const validatorEndpoints = (process.env.VALIDATOR_HEALTH_ENDPOINTS || '')
    .split(',')
    .filter(Boolean);

  if (validatorEndpoints.length === 0) {
    logger.debug('No validator health endpoints configured');
    return;
  }

  let activeCount = 0;
  let faultCount = 0;

  for (const endpoint of validatorEndpoints) {
    try {
      const response = await axios.get(`${endpoint}/health`, {
        timeout: 5000,
      });
      if (response.data?.status === 'ok') {
        activeCount++;
      } else {
        faultCount++;
        logger.warn('Validator unhealthy', {
          endpoint,
          status: response.data?.status,
        });
      }
    } catch (err: any) {
      faultCount++;
      logger.warn('Validator unreachable', {
        endpoint,
        error: err.message,
      });
    }
  }

  const totalValidators = validatorEndpoints.length;
  const faultRate = totalValidators > 0 ? faultCount / totalValidators : 0;

  logger.debug('Validator health', {
    active: activeCount,
    faulted: faultCount,
    total: totalValidators,
    faultRate: faultRate.toFixed(3),
  });

  detector.checkValidatorHealth(activeCount, faultRate);
}

async function triggerEmergencyPause(alert: AnomalyAlert): Promise<void> {
  logger.error('EMERGENCY PAUSE — Attempting to halt bridge', {
    reason: alert.message,
  });
  
  // Attempt to pause Solana bridge via guardian key
  try {
    const guardianKeyPath = process.env.GUARDIAN_KEY_PATH;
    if (!guardianKeyPath) {
      logger.error('No GUARDIAN_KEY_PATH configured — cannot auto-pause Solana');
    } else {
      const fs = await import('fs');
      const { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import('@solana/web3.js');
      const crypto = await import('crypto');

      const keypairData = JSON.parse(fs.readFileSync(guardianKeyPath, 'utf-8'));
      const guardian = Keypair.fromSecretKey(Uint8Array.from(keypairData));

      // Anchor discriminator for "emergency_pause" = SHA256("global:emergency_pause")[0..8]
      const discriminator = crypto
        .createHash('sha256')
        .update('global:emergency_pause')
        .digest()
        .subarray(0, 8);

      const pauseIx = {
        programId,
        keys: [
          { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
          { pubkey: guardian.publicKey, isWritable: false, isSigner: true },
        ],
        data: Buffer.from(discriminator),
      };

      const { blockhash } = await solanaConnection.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: guardian.publicKey,
        recentBlockhash: blockhash,
        instructions: [pauseIx],
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([guardian]);

      const sig = await solanaConnection.sendRawTransaction(tx.serialize());
      logger.info('Solana emergency pause submitted', { txSignature: sig });
    }
  } catch (err: any) {
    logger.error('Failed to pause Solana bridge', { error: err.message });
  }

  // Attempt to pause DCC bridge (signed transaction)
  try {
    const dccNodeUrl = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
    const dccBridgeContract = process.env.DCC_BRIDGE_CONTRACT || '';
    const dccGuardianSeed = process.env.DCC_GUARDIAN_SEED;
    const dccChainIdChar = process.env.DCC_CHAIN_ID_CHAR || '?';

    if (!dccGuardianSeed) {
      logger.error('No DCC_GUARDIAN_SEED configured — cannot auto-pause DCC');
    } else {
      const { invokeScript } = await import('@decentralchain/decentralchain-transactions');

      const signedTx = invokeScript(
        {
          dApp: dccBridgeContract,
          call: {
            function: 'pause',
            args: [
              { type: 'string', value: alert.message.slice(0, 200) },
            ],
          },
          payment: [],
          fee: 500000,
          chainId: dccChainIdChar,
        },
        dccGuardianSeed,
      );

      await axios.post(`${dccNodeUrl}/transactions/broadcast`, signedTx, {
        timeout: 15000,
      });
      logger.info('DCC emergency pause submitted (signed)', { txId: (signedTx as any).id });
    }
  } catch (err: any) {
    logger.error('Failed to pause DCC bridge', { error: err.message });
  }
}

// ── Pause State Monitoring ──────────────────────────────────────────────────

let lastPauseState: boolean | null = null;

async function checkPauseState(detector: AnomalyDetector): Promise<void> {
  try {
    const configInfo = await solanaConnection.getAccountInfo(bridgeConfigPda);
    if (configInfo?.data && configInfo.data.length >= 73) {
      // paused is at offset 72 (after discriminator:8 + authority:32 + guardian:32)
      const isPaused = configInfo.data[72] !== 0;

      if (lastPauseState !== null && isPaused !== lastPauseState) {
        detector.checkPauseEvent(isPaused, 'on-chain state change');
      }
      lastPauseState = isPaused;
    }
  } catch (err: any) {
    logger.warn('Pause state check failed', { error: err.message });
  }
}

// ── Solana Log Subscription for Unlock Events ───────────────────────────────

function subscribeToUnlockEvents(detector: AnomalyDetector): void {
  solanaConnection.onLogs(
    programId,
    (logs) => {
      // Look for unlock-related log messages
      for (const log of logs.logs) {
        // Anchor events are base64-encoded in "Program data:" log lines
        if (log.includes('Unlock executed')) {
          // Parse amount from log if available
          const amountMatch = log.match(/amount[:\s]+(\d+)/i);
          const amount = amountMatch ? BigInt(amountMatch[1]) : 0n;
          detector.checkUnlockPattern(amount);
          detector.checkTransactionRate();
          if (amount > 0n) {
            detector.checkLargeTransaction(amount, logs.signature);
            detector.checkVolumeAnomaly(amount);
          }
        }

        if (log.includes('Emergency pause') || log.includes('emergency_pause')) {
          detector.checkPauseEvent(true, `tx:${logs.signature}`);
        }

        if (log.includes('Resume') || log.includes('emergency_resume')) {
          detector.checkPauseEvent(false, `tx:${logs.signature}`);
        }
      }
    },
    'confirmed',
  );
}

main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
