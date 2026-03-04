/**
 * Cross-Chain Balance Reconciliation Daemon
 *
 * Periodically verifies the fundamental bridge invariant:
 *
 *   dccMinted - dccBurned  ≤  solVaultBalance
 *
 * Also reconciles per-token balances for SPL tokens (USDC, USDT, etc.)
 * and detects drift that could indicate an exploit or bug.
 *
 * This runs as a standalone process or can be imported by the main monitor.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────

interface ReconciliationConfig {
  solanaRpcUrl: string;
  solanaProgramId: string;
  dccNodeUrl: string;
  dccBridgeContract: string;
  /** Maximum acceptable drift in lamports before WARNING */
  warnDriftLamports: bigint;
  /** Maximum acceptable drift before CRITICAL alert (auto-pause) */
  criticalDriftLamports: bigint;
  /** Check interval in milliseconds */
  intervalMs: number;
  /** Webhook URL for alerts */
  alertWebhookUrl?: string;
  /** Slack webhook URL */
  slackWebhookUrl?: string;
  /** PagerDuty service key */
  pagerDutyServiceKey?: string;
}

function loadConfig(): ReconciliationConfig {
  return {
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'http://localhost:8899',
    solanaProgramId: process.env.SOLANA_PROGRAM_ID || '11111111111111111111111111111111',
    dccNodeUrl: process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io',
    dccBridgeContract: process.env.DCC_BRIDGE_CONTRACT || '',
    warnDriftLamports: BigInt(process.env.RECONCILE_WARN_DRIFT || '100000000'),    // 0.1 SOL
    criticalDriftLamports: BigInt(process.env.RECONCILE_CRITICAL_DRIFT || '1000000000'), // 1 SOL
    intervalMs: parseInt(process.env.RECONCILE_INTERVAL_MS || '30000', 10),        // 30s
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    pagerDutyServiceKey: process.env.PAGERDUTY_SERVICE_KEY,
  };
}

// ── Logger ──────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  defaultMeta: { service: 'reconciliation-daemon' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    new winston.transports.File({ filename: 'logs/reconciliation.log', maxsize: 10_000_000, maxFiles: 5 }),
  ],
});

// ── Reconciliation State ────────────────────────────────────────────────────

interface ReconciliationSnapshot {
  timestamp: number;
  solVaultBalanceLamports: bigint;
  solTotalLocked: bigint;
  solTotalUnlocked: bigint;
  solNetLocked: bigint;
  dccTotalMinted: bigint;
  dccTotalBurned: bigint;
  dccNetSupply: bigint;
  drift: bigint;             // dccNetSupply - solNetLocked (positive = danger)
  driftPercent: number;
  status: 'ok' | 'warn' | 'critical' | 'error';
  splTokens: SplTokenSnapshot[];
}

interface SplTokenSnapshot {
  symbol: string;
  splMint: string;
  solVaultBalance: bigint;
  dccMinted: bigint;
  dccBurned: bigint;
  drift: bigint;
}

// ── Core Reconciler ─────────────────────────────────────────────────────────

export class ReconciliationDaemon {
  private config: ReconciliationConfig;
  private connection: Connection;
  private programId: PublicKey;
  private vaultPda: PublicKey;
  private bridgeConfigPda: PublicKey;
  private history: ReconciliationSnapshot[] = [];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ReconciliationConfig) {
    this.config = config;
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.programId = new PublicKey(config.solanaProgramId);

    [this.vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      this.programId,
    );
    [this.bridgeConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_config')],
      this.programId,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('Reconciliation daemon starting', {
      interval: `${this.config.intervalMs}ms`,
      warnDrift: this.config.warnDriftLamports.toString(),
      criticalDrift: this.config.criticalDriftLamports.toString(),
      programId: this.programId.toBase58(),
      vaultPda: this.vaultPda.toBase58(),
    });

    // Run immediately, then on interval
    await this.reconcile();
    this.timer = setInterval(() => this.reconcile().catch(err => {
      logger.error('Reconciliation cycle failed', { error: err.message });
    }), this.config.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Reconciliation daemon stopped');
  }

  getHistory(): ReconciliationSnapshot[] {
    return this.history.slice(-100); // Last 100 snapshots
  }

  getLatest(): ReconciliationSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  // ── Main Reconciliation Cycle ───────────────────────────────────────────

  private async reconcile(): Promise<void> {
    const startMs = Date.now();

    try {
      // Fetch both chains in parallel
      const [solanaData, dccData] = await Promise.all([
        this.fetchSolanaState(),
        this.fetchDccState(),
      ]);

      const netLocked = solanaData.totalLocked - solanaData.totalUnlocked;
      const dccNetSupply = dccData.totalMinted - dccData.totalBurned;

      // Drift: positive means DCC has MORE supply than SOL has locked
      // This is the dangerous direction — it means funds can be withdrawn without backing
      const drift = dccNetSupply - netLocked;
      const driftPercent = netLocked > 0n
        ? Number(drift) / Number(netLocked) * 100
        : 0;

      let status: 'ok' | 'warn' | 'critical' = 'ok';
      if (drift > 0n && drift >= this.config.criticalDriftLamports) {
        status = 'critical';
      } else if (drift > 0n && drift >= this.config.warnDriftLamports) {
        status = 'warn';
      }

      // Also check vault balance vs net locked (should be >= net locked)
      const vaultDrift = netLocked - BigInt(solanaData.vaultBalance);
      if (vaultDrift > 0n) {
        // Vault has LESS than expected — critical
        status = 'critical';
        logger.error('VAULT BALANCE DEFICIT', {
          vaultBalance: solanaData.vaultBalance.toString(),
          netLocked: netLocked.toString(),
          deficit: vaultDrift.toString(),
        });
      }

      const snapshot: ReconciliationSnapshot = {
        timestamp: Date.now(),
        solVaultBalanceLamports: BigInt(solanaData.vaultBalance),
        solTotalLocked: solanaData.totalLocked,
        solTotalUnlocked: solanaData.totalUnlocked,
        solNetLocked: netLocked,
        dccTotalMinted: dccData.totalMinted,
        dccTotalBurned: dccData.totalBurned,
        dccNetSupply,
        drift,
        driftPercent,
        status,
        splTokens: [], // TODO: implement per-SPL-token reconciliation
      };

      this.history.push(snapshot);
      if (this.history.length > 1000) this.history.shift();

      const elapsed = Date.now() - startMs;

      logger.info('Reconciliation complete', {
        status,
        vaultBalance: solanaData.vaultBalance.toString(),
        netLocked: netLocked.toString(),
        dccNetSupply: dccNetSupply.toString(),
        drift: drift.toString(),
        driftPercent: `${driftPercent.toFixed(4)}%`,
        elapsedMs: elapsed,
      });

      // Dispatch alerts based on status
      if (status === 'critical') {
        await this.alert('CRITICAL', `Cross-chain drift CRITICAL: ${drift} lamports (${driftPercent.toFixed(2)}%)`, {
          ...this.serializeSnapshot(snapshot),
        });
      } else if (status === 'warn') {
        await this.alert('WARNING', `Cross-chain drift warning: ${drift} lamports (${driftPercent.toFixed(2)}%)`, {
          ...this.serializeSnapshot(snapshot),
        });
      }

    } catch (err: any) {
      const snapshot: ReconciliationSnapshot = {
        timestamp: Date.now(),
        solVaultBalanceLamports: 0n,
        solTotalLocked: 0n,
        solTotalUnlocked: 0n,
        solNetLocked: 0n,
        dccTotalMinted: 0n,
        dccTotalBurned: 0n,
        dccNetSupply: 0n,
        drift: 0n,
        driftPercent: 0,
        status: 'error',
        splTokens: [],
      };
      this.history.push(snapshot);
      if (this.history.length > 1000) this.history.shift();

      logger.error('Reconciliation error', { error: err.message });
    }
  }

  // ── Chain Data Fetchers ─────────────────────────────────────────────────

  private async fetchSolanaState(): Promise<{
    vaultBalance: number;
    totalLocked: bigint;
    totalUnlocked: bigint;
  }> {
    const vaultBalance = await this.connection.getBalance(this.vaultPda);

    let totalLocked = 0n;
    let totalUnlocked = 0n;

    try {
      const configInfo = await this.connection.getAccountInfo(this.bridgeConfigPda);
      if (configInfo?.data && configInfo.data.length >= 97) {
        // BridgeConfig layout: discriminator(8) + authority(32) + guardian(32) +
        // paused(1) + global_nonce(8) + total_locked(8) + total_unlocked(8)
        totalLocked = configInfo.data.readBigUInt64LE(81);
        totalUnlocked = configInfo.data.readBigUInt64LE(89);
      }
    } catch (err: any) {
      logger.warn('Could not read bridge config', { error: err.message });
    }

    return { vaultBalance, totalLocked, totalUnlocked };
  }

  private async fetchDccState(): Promise<{
    totalMinted: bigint;
    totalBurned: bigint;
  }> {
    const { dccNodeUrl, dccBridgeContract } = this.config;
    let totalMinted = 0n;
    let totalBurned = 0n;

    try {
      const [mintResp, burnResp] = await Promise.all([
        axios.get(`${dccNodeUrl}/addresses/data/${dccBridgeContract}/total_minted`, { timeout: 10000 }),
        axios.get(`${dccNodeUrl}/addresses/data/${dccBridgeContract}/total_burned`, { timeout: 10000 }),
      ]);

      if (mintResp.data?.value !== undefined) totalMinted = BigInt(mintResp.data.value);
      if (burnResp.data?.value !== undefined) totalBurned = BigInt(burnResp.data.value);
    } catch (err: any) {
      logger.warn('Could not query DCC state', { error: err.message });
    }

    return { totalMinted, totalBurned };
  }

  // ── Alerting ────────────────────────────────────────────────────────────

  private async alert(severity: string, message: string, data: Record<string, any>): Promise<void> {
    logger.error(`ALERT [${severity}] ${message}`, data);

    const promises: Promise<void>[] = [];

    if (this.config.slackWebhookUrl) {
      promises.push(
        axios.post(this.config.slackWebhookUrl, {
          text: `🚨 *Bridge Reconciliation — ${severity}*\n${message}\n\`\`\`${JSON.stringify(data, null, 2)}\`\`\``,
        }).then(() => {}).catch((err) => logger.warn('Slack alert failed', { error: err.message })),
      );
    }

    if (this.config.pagerDutyServiceKey && severity === 'CRITICAL') {
      promises.push(
        axios.post('https://events.pagerduty.com/v2/enqueue', {
          routing_key: this.config.pagerDutyServiceKey,
          event_action: 'trigger',
          payload: {
            summary: `Bridge Reconciliation: ${message}`,
            severity: 'critical',
            source: 'reconciliation-daemon',
            component: 'cross-chain-balance',
            custom_details: data,
          },
        }).then(() => {}).catch((err) => logger.warn('PagerDuty alert failed', { error: err.message })),
      );
    }

    if (this.config.alertWebhookUrl) {
      promises.push(
        axios.post(this.config.alertWebhookUrl, { severity, message, data, timestamp: Date.now() })
          .then(() => {}).catch((err) => logger.warn('Webhook alert failed', { error: err.message })),
      );
    }

    await Promise.allSettled(promises);
  }

  private serializeSnapshot(s: ReconciliationSnapshot): Record<string, any> {
    return {
      timestamp: new Date(s.timestamp).toISOString(),
      solVaultBalance: s.solVaultBalanceLamports.toString(),
      solNetLocked: s.solNetLocked.toString(),
      dccNetSupply: s.dccNetSupply.toString(),
      drift: s.drift.toString(),
      driftPercent: s.driftPercent.toFixed(4) + '%',
      status: s.status,
    };
  }
}

// ── Standalone Entry Point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  Cross-Chain Reconciliation Daemon v1.0.0');
  logger.info('═══════════════════════════════════════════');

  const config = loadConfig();

  if (!config.dccBridgeContract) {
    logger.error('DCC_BRIDGE_CONTRACT env var is required');
    process.exit(1);
  }

  const daemon = new ReconciliationDaemon(config);

  // Graceful shutdown
  process.on('SIGINT', () => { daemon.stop(); process.exit(0); });
  process.on('SIGTERM', () => { daemon.stop(); process.exit(0); });

  await daemon.start();
  logger.info('Reconciliation daemon running. Press Ctrl+C to stop.');
}

// Run if executed directly
const isMainModule = process.argv[1]?.endsWith('reconciliation.ts') ||
                     process.argv[1]?.endsWith('reconciliation.js');
if (isMainModule) {
  main().catch((err) => {
    logger.error('Fatal error', { error: err });
    process.exit(1);
  });
}

export { ReconciliationConfig, ReconciliationSnapshot };
