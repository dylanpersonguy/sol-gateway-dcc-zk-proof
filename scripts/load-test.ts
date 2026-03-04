/**
 * Bridge Load Test & Rate Limit Tuning
 *
 * Simulates expected mainnet transaction volume to validate rate limits,
 * monitoring thresholds, and system stability under load.
 *
 * Usage:
 *   SOLANA_RPC_URL=http://localhost:8899 \
 *   SOLANA_PROGRAM_ID=<pubkey> \
 *   DEPLOYER_KEY_PATH=~/.config/solana/id.json \
 *   npx ts-node scripts/load-test.ts [--profile <low|medium|high|stress>]
 *
 * Profiles:
 *   low:     5 deposits/min — Normal mainnet volume
 *   medium: 20 deposits/min — Peak expected volume
 *   high:   60 deposits/min — 3x peak (stress)
 *   stress: 200 deposits/min — Adversarial / DDoS simulation
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────

interface LoadProfile {
  name: string;
  depositsPerMinute: number;
  amountRange: [number, number]; // [min, max] in lamports
  durationMinutes: number;
  concurrentUsers: number;
}

const PROFILES: Record<string, LoadProfile> = {
  low: {
    name: 'Low (Normal Mainnet)',
    depositsPerMinute: 5,
    amountRange: [0.01 * LAMPORTS_PER_SOL, 1 * LAMPORTS_PER_SOL],
    durationMinutes: 5,
    concurrentUsers: 3,
  },
  medium: {
    name: 'Medium (Peak Expected)',
    depositsPerMinute: 20,
    amountRange: [0.01 * LAMPORTS_PER_SOL, 10 * LAMPORTS_PER_SOL],
    durationMinutes: 5,
    concurrentUsers: 10,
  },
  high: {
    name: 'High (3x Peak)',
    depositsPerMinute: 60,
    amountRange: [0.001 * LAMPORTS_PER_SOL, 50 * LAMPORTS_PER_SOL],
    durationMinutes: 3,
    concurrentUsers: 20,
  },
  stress: {
    name: 'Stress (DDoS Simulation)',
    depositsPerMinute: 200,
    amountRange: [0.001 * LAMPORTS_PER_SOL, 100 * LAMPORTS_PER_SOL],
    durationMinutes: 2,
    concurrentUsers: 50,
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(keyPath: string): Keypair {
  const resolved = keyPath.startsWith('~')
    ? path.join(process.env.HOME!, keyPath.slice(1))
    : keyPath;
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

// ── Metrics ─────────────────────────────────────────────────────────────────

interface LoadTestMetrics {
  totalAttempted: number;
  totalSuccess: number;
  totalFailed: number;
  totalRateLimited: number;
  latencies: number[];
  errors: Map<string, number>;
  startTime: number;
  endTime: number;
}

function newMetrics(): LoadTestMetrics {
  return {
    totalAttempted: 0,
    totalSuccess: 0,
    totalFailed: 0,
    totalRateLimited: 0,
    latencies: [],
    errors: new Map(),
    startTime: Date.now(),
    endTime: 0,
  };
}

function printMetrics(metrics: LoadTestMetrics, profile: LoadProfile): void {
  metrics.endTime = Date.now();
  const durationSec = (metrics.endTime - metrics.startTime) / 1000;
  const sortedLatencies = [...metrics.latencies].sort((a, b) => a - b);

  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0;
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;
  const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 0;
  const avg = sortedLatencies.length > 0
    ? sortedLatencies.reduce((s, v) => s + v, 0) / sortedLatencies.length
    : 0;

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Load Test Results — ${profile.name}`);
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log(`Duration:           ${durationSec.toFixed(1)}s`);
  console.log(`Target rate:        ${profile.depositsPerMinute} tx/min`);
  console.log(`Actual rate:        ${(metrics.totalAttempted / (durationSec / 60)).toFixed(1)} tx/min`);
  console.log(`Concurrent users:   ${profile.concurrentUsers}`);
  console.log();
  console.log(`Transactions:`);
  console.log(`  Attempted:        ${metrics.totalAttempted}`);
  console.log(`  Succeeded:        ${metrics.totalSuccess}`);
  console.log(`  Failed:           ${metrics.totalFailed}`);
  console.log(`  Rate limited:     ${metrics.totalRateLimited}`);
  console.log(`  Success rate:     ${((metrics.totalSuccess / Math.max(metrics.totalAttempted, 1)) * 100).toFixed(1)}%`);
  console.log();
  console.log(`Latency (confirmed):`);
  console.log(`  p50:              ${p50}ms`);
  console.log(`  p95:              ${p95}ms`);
  console.log(`  p99:              ${p99}ms`);
  console.log(`  avg:              ${avg.toFixed(0)}ms`);
  console.log();

  if (metrics.errors.size > 0) {
    console.log('Error distribution:');
    for (const [errType, count] of metrics.errors.entries()) {
      console.log(`  ${errType}: ${count}`);
    }
    console.log();
  }

  // Rate limit recommendations
  console.log('═══════════════════════════════════════════════════');
  console.log('  Rate Limit Recommendations');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  const actualTxPerMin = metrics.totalAttempted / (durationSec / 60);
  const recommendedGlobalLimit = Math.ceil(actualTxPerMin * 2); // 2x headroom
  const recommendedPerUser = Math.ceil(profile.depositsPerMinute / profile.concurrentUsers * 1.5);

  console.log(`Based on ${profile.name} profile:`);
  console.log();
  console.log(`Bridge Program (on-chain):`);
  console.log(`  MAX_DEPOSITS_PER_HOUR:   ${Math.ceil(profile.depositsPerMinute * 60 * 1.5)}`);
  console.log(`  MAX_DEPOSIT_AMOUNT:      ${(profile.amountRange[1] / LAMPORTS_PER_SOL).toFixed(1)} SOL`);
  console.log();
  console.log(`API Rate Limits:`);
  console.log(`  Global:                  ${recommendedGlobalLimit} req/min`);
  console.log(`  Per-user:                ${recommendedPerUser} req/min`);
  console.log(`  Per-IP:                  ${Math.ceil(recommendedPerUser * 0.8)} req/min`);
  console.log();
  console.log(`Monitoring Thresholds:`);
  console.log(`  MAX_TX_PER_MIN:          ${Math.ceil(actualTxPerMin * 3)} (alert trigger)`);
  console.log(`  MAX_HOURLY_VOLUME:       ${Math.ceil(profile.depositsPerMinute * 60 * (profile.amountRange[0] + profile.amountRange[1]) / 2)} lamports`);
  console.log(`  LARGE_TX_THRESHOLD:      ${Math.ceil(profile.amountRange[1] * 2)} lamports`);
  console.log();
}

// ── Load Test Runner ────────────────────────────────────────────────────────

async function runLoadTest(profile: LoadProfile): Promise<void> {
  const RPC_URL = process.env.SOLANA_RPC_URL || 'http://localhost:8899';
  const PROGRAM_ID = new PublicKey(
    process.env.SOLANA_PROGRAM_ID || '11111111111111111111111111111111',
  );

  console.log('═══════════════════════════════════════════════════');
  console.log(`  Bridge Load Test — ${profile.name}`);
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log(`RPC:                ${RPC_URL}`);
  console.log(`Program:            ${PROGRAM_ID.toBase58()}`);
  console.log(`Rate:               ${profile.depositsPerMinute} tx/min`);
  console.log(`Duration:           ${profile.durationMinutes} min`);
  console.log(`Concurrent users:   ${profile.concurrentUsers}`);
  console.log();

  const connection = new Connection(RPC_URL, 'confirmed');
  const metrics = newMetrics();

  // Generate user keypairs
  const users: Keypair[] = [];
  for (let i = 0; i < profile.concurrentUsers; i++) {
    users.push(Keypair.generate());
  }

  // Airdrop SOL to test users (localnet only)
  if (RPC_URL.includes('localhost') || RPC_URL.includes('127.0.0.1')) {
    console.log('Airdropping SOL to test users...');
    for (const user of users) {
      try {
        const sig = await connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, 'confirmed');
      } catch {
        // May fail on non-localnet
      }
    }
    console.log('  Done');
    console.log();
  }

  // PDAs
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')],
    PROGRAM_ID,
  );
  const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    PROGRAM_ID,
  );

  // Calculate interval between transactions
  const intervalMs = (60 * 1000) / profile.depositsPerMinute;
  const totalTransactions = profile.depositsPerMinute * profile.durationMinutes;

  console.log(`Running ${totalTransactions} transactions over ${profile.durationMinutes} minutes...`);
  console.log();

  // Run the test
  const endTime = Date.now() + profile.durationMinutes * 60 * 1000;
  let txCount = 0;

  while (Date.now() < endTime && txCount < totalTransactions) {
    const user = users[txCount % users.length];
    const amount = randomInRange(profile.amountRange[0], profile.amountRange[1]);

    metrics.totalAttempted++;
    txCount++;

    const start = Date.now();

    try {
      // Build a simulated deposit transaction (SystemProgram transfer to vault)
      // In production this would be the actual deposit instruction
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const message = new TransactionMessage({
        payerKey: user.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey: vaultPda,
            lamports: Math.min(amount, 10000), // Small amount for testing
          }),
        ],
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);
      tx.sign([user]);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });

      // Wait for confirmation with timeout
      const confirmResult = await Promise.race([
        connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed',
        ),
        sleep(30000).then(() => ({ value: { err: 'timeout' } })),
      ]);

      const latency = Date.now() - start;

      if ((confirmResult as any)?.value?.err) {
        metrics.totalFailed++;
        const errStr = JSON.stringify((confirmResult as any).value.err);
        metrics.errors.set(errStr, (metrics.errors.get(errStr) || 0) + 1);
      } else {
        metrics.totalSuccess++;
        metrics.latencies.push(latency);
      }
    } catch (err: any) {
      metrics.totalFailed++;
      const errMsg = err.message?.slice(0, 80) || 'unknown';

      if (errMsg.includes('rate') || errMsg.includes('429') || errMsg.includes('Too many')) {
        metrics.totalRateLimited++;
      }

      metrics.errors.set(errMsg, (metrics.errors.get(errMsg) || 0) + 1);
    }

    // Progress indicator
    if (txCount % 10 === 0) {
      const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(0);
      const successRate = ((metrics.totalSuccess / metrics.totalAttempted) * 100).toFixed(1);
      process.stdout.write(
        `\r  [${elapsed}s] ${txCount}/${totalTransactions} tx | ` +
        `${metrics.totalSuccess} ok / ${metrics.totalFailed} fail | ` +
        `${successRate}% success     `,
      );
    }

    // Throttle to target rate
    const expectedTime = metrics.startTime + txCount * intervalMs;
    const now = Date.now();
    if (now < expectedTime) {
      await sleep(expectedTime - now);
    }
  }

  console.log(); // newline after progress
  printMetrics(metrics, profile);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const profileArg = process.argv.find((_, i) =>
    process.argv[i - 1] === '--profile',
  ) || 'low';

  const profile = PROFILES[profileArg];
  if (!profile) {
    console.error(`Unknown profile: ${profileArg}`);
    console.error(`Available: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  await runLoadTest(profile);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
