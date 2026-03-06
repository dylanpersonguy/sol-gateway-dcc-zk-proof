// ═══════════════════════════════════════════════════════════════
// VALIDATOR NODE — Main Entry Point
// ═══════════════════════════════════════════════════════════════
//
// Orchestrates all validator components:
// 1. Solana Watcher — monitors deposits
// 2. DCC Watcher — monitors burns
// 3. Consensus Engine — BFT agreement on events
// 4. Threshold Signer — cryptographic signing
// 5. Chain Submitter — submits consensus results to chains
// 6. ZK Bridge Service — checkpoint + Groth16 proof pipeline (Phase 2)
//
// This node is one of M-of-N validators required for bridge operation.

import { loadConfig, ValidatorConfig } from './config';
import { SolanaWatcher, SolanaDepositEvent } from './watchers/solana-watcher';
import { DccWatcher, DccBurnEvent } from './watchers/dcc-watcher';
import { ConsensusEngine, ConsensusResult, Attestation } from './consensus/engine';
import { ThresholdSigner } from './signer/threshold-signer';
import { P2PTransport } from './p2p/transport';
import { createLogger } from './utils/logger';
import { RateLimiter } from './utils/rate-limiter';
import { calculateDepositFee, calculateWithdrawalFee, logFee } from './utils/fee-calculator';
import { ZkBridgeService } from './zk/zk-bridge-service';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Ed25519Program,
  SystemProgram,
} from '@solana/web3.js';
import * as fs from 'fs';
import express from 'express';
import {
  signAndBroadcastMint,
  getAddressFromSeed,
} from './utils/dcc-helpers';
import {
  signBytes as dccSignBytes,
  publicKey as dccPublicKey,
  base58Decode as dccBase58Decode,
} from '@decentralchain/ts-lib-crypto';

const logger = createLogger('Main');

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  SOL ⇄ DCC Bridge Validator Node v2.0.0');
  logger.info('  Phase 1: Committee Minting | Phase 2: ZK Proofs');;
  logger.info('═══════════════════════════════════════════');

  // Load configuration
  const config = loadConfig();
  logger.info('Configuration loaded', { nodeId: config.nodeId });

  // ── Beta Safety: Config Summary ──
  logger.info('═══════════════════════════════════════════');
  logger.info('  CONFIGURATION SUMMARY');
  logger.info('═══════════════════════════════════════════');
  logger.info(`  Mode:               ${config.fullProduction ? 'FULL_PRODUCTION' : 'LIMITED_BETA'}`);
  logger.info(`  ZK Path:            ${config.disableZkPath ? 'DISABLED' : 'ENABLED'}`);
  logger.info(`  ZK-Only Threshold:  ${config.zkOnlyThresholdLamports} lamports`);
  logger.info(`  Max Single TX:      ${config.maxSingleTxLamports} lamports`);
  logger.info(`  Max Daily Outflow:  ${config.maxDailyOutflowLamports} lamports`);
  logger.info(`  Min Deposit:        ${config.minDepositLamports} lamports`);
  logger.info(`  Min Validators:     ${config.minValidators}`);
  logger.info(`  Solana Confirms:    ${config.solanaRequiredConfirmations}`);
  logger.info(`  DCC Confirms:       ${config.dccRequiredConfirmations}`);
  logger.info('═══════════════════════════════════════════');

  // ── Beta Safety: ZK_ONLY_THRESHOLD validation ──
  if (config.zkOnlyThresholdLamports > 0n) {
    if (config.zkOnlyThresholdLamports > config.maxSingleTxLamports) {
      logger.error('ZK_ONLY_THRESHOLD_LAMPORTS exceeds MAX_SINGLE_TX — ZK enforcement would never trigger');
      process.exit(1);
    }
    logger.info('ZK-only enforcement active: deposits >= ' +
      config.zkOnlyThresholdLamports.toString() + ' lamports require ZK proof');
  }

  // ── Beta Safety: DISABLE_ZK_PATH kill switch ──
  if (config.disableZkPath) {
    logger.warn('⚠️  ZK proof path is DISABLED via DISABLE_ZK_PATH=true');
    logger.warn('    Committee-only minting will be used for all deposits');
  }

  // ── RELEASE_GUARD: Runtime enforcement for FULL_PRODUCTION mode ──
  if (config.fullProduction) {
    const missing: string[] = [];
    if (!process.env.MPC_CEREMONY_ATTESTATION_HASH) missing.push('MPC_CEREMONY_ATTESTATION_HASH');
    if (process.env.MULTISIG_AUTHORITY_ENABLED !== 'true') missing.push('MULTISIG_AUTHORITY_ENABLED=true');
    if (process.env.EXTERNAL_AUDIT_COMPLETED !== 'true') missing.push('EXTERNAL_AUDIT_COMPLETED=true');
    if (!process.env.HSM_ENABLED || process.env.HSM_ENABLED !== 'true') missing.push('HSM_ENABLED=true');

    if (missing.length > 0) {
      logger.error('═══════════════════════════════════════════');
      logger.error('  RELEASE_GUARD FAILURE — Cannot start in FULL_PRODUCTION mode');
      logger.error('  Missing prerequisites:');
      for (const m of missing) {
        logger.error('    ✗ ' + m);
      }
      logger.error('  See docs/RELEASE_GUARD.md for details');
      logger.error('═══════════════════════════════════════════');
      process.exit(1);
    }
    logger.info('RELEASE_GUARD: All prerequisites met for FULL_PRODUCTION mode');
  }

  // ── Initialize Threshold Signer ──
  const signer = new ThresholdSigner({
    privateKeyPath: config.privateKeyPath,
    hsmEnabled: config.hsmEnabled,
    hsmSlot: config.hsmSlot,
    hsmPin: config.hsmPin,
    keyRotationIntervalHours: config.keyRotationIntervalHours,
  });
  await signer.initialize();
  logger.info('Signer initialized', {
    publicKey: signer.getPublicKey().toString('hex'),
  });

  // ── Derive DCC signing seed for this validator ──
  // Each validator gets a unique signing key derived from the base DCC seed
  // and its node ID. These keys match the Curve25519 signature scheme used
  // by RIDE's sigVerify(), as opposed to Ed25519 (tweetnacl).
  const dccSigningSeed = `${config.dccSeed}:bridge-signer:${config.nodeId}`;
  const dccSigningPubKeyB58 = dccPublicKey(dccSigningSeed);
  const dccSigningPubKeyRaw = Buffer.from(dccBase58Decode(dccSigningPubKeyB58));

  logger.info('DCC signing key derived', {
    nodeId: config.nodeId,
    publicKeyHex: dccSigningPubKeyRaw.toString('hex'),
    publicKeyB58: dccSigningPubKeyB58,
  });

  // ── Initialize Consensus Engine ──
  const consensus = new ConsensusEngine(
    {
      nodeId: config.nodeId,
      minValidators: config.minValidators,
      consensusTimeoutMs: config.consensusTimeoutMs,
      maxRetries: config.maxRetries,
    },
    // DCC-compatible signing: use Curve25519 scheme that matches RIDE sigVerify
    async (message: Buffer): Promise<Buffer> => {
      const sigB58: string = dccSignBytes(dccSigningSeed, message) as unknown as string;
      return Buffer.from(dccBase58Decode(sigB58));
    },
    () => dccSigningPubKeyRaw,
  );

  // ── Initialize ZK Bridge Service (Phase 2) ──
  const zkVerifierContract = process.env.DCC_ZK_VERIFIER_CONTRACT || '';
  let zkService: ZkBridgeService | null = null;

  if (zkVerifierContract) {
    const zkWasmPath = process.env.ZK_WASM_PATH || 'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm';
    const zkZkeyPath = process.env.ZK_ZKEY_PATH || 'zk/circuits/build/bridge_deposit_final.zkey';
    const zkVkeyPath = process.env.ZK_VKEY_PATH || 'zk/circuits/build/verification_key.json';

    zkService = new ZkBridgeService({
      zkVerifierContract,
      bridgeCoreContract: config.dccBridgeContract,
      nodeUrl: config.dccNodeUrl,
      chainId: config.dccChainIdChar,
      dccSeed: config.dccSeed,
      nodeId: config.nodeId,
      apiKey: process.env.DCC_API_KEY || '',
      wasmPath: zkWasmPath,
      zkeyPath: zkZkeyPath,
      vkeyPath: zkVkeyPath,
      solanaProgramId: config.solanaProgramId,
      checkpointWindowMs: parseInt(process.env.ZK_CHECKPOINT_WINDOW_MS || '60000'),
      maxEventsPerCheckpoint: parseInt(process.env.ZK_MAX_EVENTS_PER_CHECKPOINT || '100'),
    });

    zkService.on('zk_mint_success', (info) => {
      logger.info('ZK mint successful!', info);
    });

    logger.info('ZK Bridge Service configured', {
      zkVerifier: zkVerifierContract,
      wasmPath: zkWasmPath,
    });
  } else {
    logger.info('ZK Bridge Service DISABLED — set DCC_ZK_VERIFIER_CONTRACT to enable');
  }

  // ── Initialize Solana Watcher ──
  const solanaWatcher = new SolanaWatcher({
    rpcUrl: config.solanaRpcUrl,
    wsUrl: config.solanaWsUrl,
    programId: config.solanaProgramId,
    requiredConfirmations: config.solanaRequiredConfirmations,
    reorgProtectionSlots: config.reorgProtectionSlots,
    pollIntervalMs: 5000,
  });

  // ── Initialize DCC Watcher ──
  const dccWatcher = new DccWatcher({
    nodeUrl: config.dccNodeUrl,
    bridgeContract: config.dccBridgeContract,
    requiredConfirmations: config.dccRequiredConfirmations,
    pollIntervalMs: 3000,
  });

  // ── Initialize P2P Transport ──
  const p2p = new P2PTransport({
    nodeId: config.nodeId,
    port: config.p2pPort,
    bootstrapPeers: config.bootstrapPeers,
    heartbeatIntervalMs: 10_000,
    reconnectBaseMs: 2_000,
    maxReconnectMs: 60_000,
  });

  // Wire P2P crypto with signer
  p2p.setCrypto(
    (msg: Buffer) => signer.sign(msg),
    (msg: Buffer, sig: Buffer, pk: Buffer) => signer.verify(msg, sig, pk),
    signer.getPublicKey(),
  );

  // ═══════════════════════════════════════════════════════════
  // P2P ↔ CONSENSUS WIRING
  // ═══════════════════════════════════════════════════════════

  // When consensus broadcasts an attestation, relay it over P2P
  consensus.on('attestation_broadcast', async (attestation: Attestation) => {
    await p2p.broadcast('attestation', attestation);
  });

  // When we receive an attestation from a peer, feed it to consensus
  p2p.on('attestation_received', (payload: any, fromNodeId: string) => {
    const attestation: Attestation = {
      nodeId: payload.nodeId || fromNodeId,
      transferId: payload.transferId,
      type: payload.type,
      signature: Buffer.from(payload.signature, 'base64'),
      publicKey: Buffer.from(payload.publicKey, 'base64'),
      messageHash: Buffer.from(payload.messageHash, 'base64'),
      timestamp: payload.timestamp,
    };
    consensus.receiveAttestation(attestation);
  });

  // ═══════════════════════════════════════════════════════════
  // EVENT WIRING
  // ═══════════════════════════════════════════════════════════

  // ── Initialize Rate Limiter (M-2 fix) ──
  const rateLimiter = new RateLimiter({
    maxDailyOutflowLamports: config.maxDailyOutflowLamports,
    maxSingleTxLamports: config.maxSingleTxLamports,
    minDepositLamports: config.minDepositLamports,
  });
  logger.info('Rate limiter initialized', {
    maxDaily: config.maxDailyOutflowLamports.toString(),
    maxSingle: config.maxSingleTxLamports.toString(),
  });

  // Solana deposit finalized → propose mint attestation
  solanaWatcher.on('deposit_finalized', (event: SolanaDepositEvent) => {
    logger.info('Solana deposit finalized → proposing mint', {
      transferId: event.transferId,
      amount: event.amount.toString(),
    });

    // M-2: Enforce rate limits before processing deposit
    const amountBigint = BigInt(event.amount);
    if (amountBigint < config.minDepositLamports) {
      logger.warn('Deposit below minimum — rejecting', {
        transferId: event.transferId,
        amount: amountBigint.toString(),
        min: config.minDepositLamports.toString(),
      });
      return;
    }
    if (amountBigint > config.maxSingleTxLamports) {
      logger.warn('Deposit exceeds single-tx limit — rejecting', {
        transferId: event.transferId,
        amount: amountBigint.toString(),
        max: config.maxSingleTxLamports.toString(),
      });
      return;
    }
    // SECURITY FIX (VAL-5): Use canConsume (check-only) before consensus.
    // Actual consumption happens in consensus_reached handler to prevent DoS
    // via budget drain on failed/timeout consensus rounds.
    if (!rateLimiter.canConsume(amountBigint)) {
      logger.error('RATE LIMIT: Daily outflow limit would be exceeded — rejecting deposit', {
        transferId: event.transferId,
        amount: amountBigint.toString(),
      });
      return;
    }

    // Amount-based routing: ≥100 SOL → ZK proof required, <100 SOL → committee fast-path only
    const ZK_ONLY_THRESHOLD = BigInt(process.env.ZK_ONLY_THRESHOLD_LAMPORTS || '100000000000'); // 100 SOL
    const useZk = amountBigint >= ZK_ONLY_THRESHOLD;

    // ── Fee Calculation ──
    // Apply fee BEFORE consensus so all validators sign over the net (fee-adjusted) amount.
    // This ensures the canonical message hash matches the amount passed to DCC committeeMint.
    const depositFee = calculateDepositFee(amountBigint, config);
    logFee(depositFee, event.transferId);

    // Create a fee-adjusted copy of the event — consensus signs over net amount
    const feeAdjustedEvent = { ...event, amount: depositFee.netAmountLamports };

    if (!useZk) {
      // Under 100 SOL: committee fast-path (no ZK proof needed)
      logger.info('Small deposit → committee-only path (ZK skipped)', {
        transferId: event.transferId,
        originalAmount: amountBigint.toString(),
        netAmount: depositFee.netAmountLamports.toString(),
        feeDeducted: depositFee.feeLamports.toString(),
        threshold: ZK_ONLY_THRESHOLD.toString(),
      });
      consensus.proposeAttestation({
        type: 'mint',
        transferId: event.transferId,
        event: feeAdjustedEvent,
        timestamp: Date.now(),
      });
    } else {
      // 100+ SOL: ZK-only path (committee skipped, proof required)
      logger.info('Large deposit → ZK-only path (committee skipped)', {
        transferId: event.transferId,
        amount: amountBigint.toString(),
        threshold: ZK_ONLY_THRESHOLD.toString(),
      });

      // Feed deposit to ZK pipeline for proof generation
      if (zkService) {
        try {
          zkService.addDeposit(event);
        } catch (err) {
          logger.warn('Failed to add deposit to ZK pipeline', {
            transferId: event.transferId,
            error: err,
          });
        }
      }
    }
  });

  // DCC burn finalized → propose unlock attestation
  dccWatcher.on('burn_finalized', (event: DccBurnEvent) => {
    logger.info('DCC burn finalized → proposing unlock', {
      burnId: event.burnId,
      amount: event.amount.toString(),
    });

    // M-2: Enforce rate limits before processing unlock
    const amountBigint = BigInt(event.amount);
    if (amountBigint > config.maxSingleTxLamports) {
      logger.warn('Unlock exceeds single-tx limit — rejecting', {
        burnId: event.burnId,
        amount: amountBigint.toString(),
        max: config.maxSingleTxLamports.toString(),
      });
      return;
    }
    // SECURITY FIX (VAL-5): Use canConsume (check-only) before consensus.
    if (!rateLimiter.canConsume(amountBigint)) {
      logger.error('RATE LIMIT: Daily outflow limit would be exceeded — rejecting unlock', {
        burnId: event.burnId,
        amount: amountBigint.toString(),
      });
      return;
    }

    // ── Fee Calculation ──
    // Apply fee BEFORE consensus so all validators sign over the net (fee-adjusted) amount.
    const withdrawalFee = calculateWithdrawalFee(amountBigint, config);
    logFee(withdrawalFee, event.burnId);

    // Create a fee-adjusted copy — consensus signs over net amount
    const feeAdjustedBurn = { ...event, amount: withdrawalFee.netAmountLamports };

    logger.info('Withdrawal fee applied before consensus', {
      burnId: event.burnId,
      originalAmount: amountBigint.toString(),
      netAmount: withdrawalFee.netAmountLamports.toString(),
      feeDeducted: withdrawalFee.feeLamports.toString(),
    });

    consensus.proposeAttestation({
      type: 'unlock',
      transferId: event.burnId,
      event: feeAdjustedBurn,
      timestamp: Date.now(),
    });
  });

  // Consensus reached → submit to destination chain
  consensus.on('consensus_reached', async (result: ConsensusResult) => {
    logger.info('Consensus reached — submitting to destination', {
      transferId: result.transferId,
      type: result.type,
      signatures: result.receivedSignatures,
    });

    try {
      // SECURITY FIX (VAL-5): Actually consume rate limit budget AFTER consensus success.
      // The event amount for mints/unlocks was fee-adjusted, so we consume the net amount.
      const eventAmount = result.event
        ? BigInt((result.event as any).amount)
        : 0n;
      if (eventAmount > 0n) {
        if (!rateLimiter.consume(eventAmount)) {
          logger.error('RATE LIMIT: Daily limit exceeded at submission time — aborting', {
            transferId: result.transferId,
          });
          return;
        }
      }

      if (result.type === 'mint') {
        await submitMintToDcc(config, result);
        // Notify API that committee mint is complete
        const API_URL = process.env.API_URL || 'http://api:3000';
        try {
          await fetch(`${API_URL}/api/v1/transfer/notify-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transferId: result.transferId, status: 'completed' }),
          });
        } catch {}
      } else {
        await submitUnlockToSolana(config, result);
      }
    } catch (err) {
      logger.error('Failed to submit consensus result', {
        transferId: result.transferId,
        error: err,
      });
    }
  });

  // Consensus failed → log and alert
  consensus.on('consensus_failed', (result: ConsensusResult) => {
    logger.error('CONSENSUS FAILED', {
      transferId: result.transferId,
      received: result.receivedSignatures,
      required: result.requiredSignatures,
    });
  });

  // Byzantine behavior detected → alert
  consensus.on('byzantine_detected', (info: any) => {
    logger.error('⚠️  BYZANTINE BEHAVIOR DETECTED', info);
    // In production: trigger alert, initiate slashing proposal
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK / METRICS SERVER
  // ═══════════════════════════════════════════════════════════

  const app = express();

  app.get('/health', (_req, res) => {
    const health = {
      status: 'ok',
      nodeId: config.nodeId,
      solanaWatcher: solanaWatcher.getHealth(),
      dccWatcher: dccWatcher.getHealth(),
      consensus: consensus.getStatus(),
      signer: signer.getStats(),
      p2p: { peers: p2p.getPeerStatus() },
      timestamp: Date.now(),
    };
    res.json(health);
  });

  app.get('/metrics', (_req, res) => {
    // Prometheus-compatible metrics
    const consensusStatus = consensus.getStatus();
    const signerStats = signer.getStats();

    let metrics = '';
    metrics += `# HELP bridge_pending_consensus Number of pending consensus rounds\n`;
    metrics += `# TYPE bridge_pending_consensus gauge\n`;
    metrics += `bridge_pending_consensus ${consensusStatus.pending}\n`;
    metrics += `# HELP bridge_processed_transfers Total processed transfers\n`;
    metrics += `# TYPE bridge_processed_transfers counter\n`;
    metrics += `bridge_processed_transfers ${consensusStatus.processed}\n`;
    metrics += `# HELP bridge_signatures_produced Total signatures produced\n`;
    metrics += `# TYPE bridge_signatures_produced counter\n`;
    metrics += `bridge_signatures_produced ${signerStats.signatureCount}\n`;

    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  });

  app.listen(config.healthCheckPort, () => {
    logger.info(`Health check server on port ${config.healthCheckPort}`);
  });

  // ═══════════════════════════════════════════════════════════
  // START WATCHERS
  // ═══════════════════════════════════════════════════════════

  await solanaWatcher.start();
  await dccWatcher.start();
  await p2p.start();

  // Start ZK Bridge Service (Phase 2)
  if (zkService) {
    await zkService.start();
    logger.info('ZK Bridge Service started — Phase 2 active');
  }

  logger.info('Validator node fully operational');
  logger.info(`Public Key: ${signer.getPublicKey().toString('hex')}`);
  logger.info(`P2P: ws://0.0.0.0:${config.p2pPort}`);
  logger.info(`Health: http://localhost:${config.healthCheckPort}/health`);
  if (zkService) {
    logger.info(`ZK Verifier: ${process.env.DCC_ZK_VERIFIER_CONTRACT}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (zkService) await zkService.stop();
    await p2p.stop();
    await solanaWatcher.stop();
    await dccWatcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ═══════════════════════════════════════════════════════════════
// CHAIN SUBMISSION
// ═══════════════════════════════════════════════════════════════

async function submitMintToDcc(
  config: ValidatorConfig,
  result: ConsensusResult,
): Promise<void> {
  const logger = createLogger('DccSubmitter');

  // Extract attestations for DCC contract
  const signatures = result.attestations.map((a: Attestation) => a.signature.toString('base64'));
  const pubkeys = result.attestations.map((a: Attestation) => a.publicKey.toString('base64'));

  logger.info('Submitting mint to DCC', {
    transferId: result.transferId,
    signatures: signatures.length,
  });

  // Extract deposit event data from consensus result
  const depositEvent = result.event as SolanaDepositEvent | undefined;
  if (!depositEvent) {
    throw new Error(`No deposit event in consensus result for transfer ${result.transferId}`);
  }

  // Convert hex-encoded DCC recipient to base58 DCC address string
  // The recipient_dcc is stored as 26 raw bytes (base58-decoded DCC address) + 6 zero-pad bytes
  const recipientHex = depositEvent.recipientDcc;
  const recipientRawBytes = Buffer.from(recipientHex, 'hex');
  // Strip trailing zero-padding to get original base58-decoded bytes
  let lastNonZero = recipientRawBytes.length - 1;
  while (lastNonZero > 0 && recipientRawBytes[lastNonZero] === 0) lastNonZero--;
  const recipientTrimmed = recipientRawBytes.subarray(0, lastNonZero + 1);
  const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function toBase58(buf: Buffer): string {
    let num = BigInt('0x' + buf.toString('hex'));
    let result = '';
    while (num > 0n) {
      result = bs58Chars[Number(num % 58n)] + result;
      num = num / 58n;
    }
    // Preserve leading zeros
    for (let i = 0; i < buf.length && buf[i] === 0; i++) {
      result = '1' + result;
    }
    return result || '1';
  }
  const recipient = toBase58(Buffer.from(recipientTrimmed));
  // Event already has fee-adjusted amount (applied before consensus signing)
  const amount = Number(depositEvent.amount);
  const solSlot = depositEvent.slot;

  if (!recipient || amount <= 0) {
    throw new Error(`Invalid deposit event data for transfer ${result.transferId}`);
  }

  logger.info('Resolved DCC recipient address', {
    transferId: result.transferId,
    recipientHex: recipientHex.slice(0, 20) + '...',
    recipientDcc: recipient,
    mintAmount: amount,
    note: 'Fee already deducted before consensus',
    solSlot,
  });

  try {
    // Sign and broadcast via @decentralchain/decentralchain-transactions
    const { id: txId } = await signAndBroadcastMint({
      dApp: config.dccBridgeContract,
      transferId: result.transferId,
      recipient,
      amount,
      solSlot,
      signatures,
      pubkeys,
      chainId: config.dccChainIdChar,
      nodeUrl: config.dccNodeUrl,
      seed: config.dccSeed,
    });

    logger.info('Mint submitted to DCC successfully', {
      transferId: result.transferId,
      txId,
      dccAddress: getAddressFromSeed(config.dccSeed, config.dccChainIdChar),
    });
  } catch (err: any) {
    logger.error('Failed to submit mint to DCC', {
      transferId: result.transferId,
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

async function submitUnlockToSolana(
  config: ValidatorConfig,
  result: ConsensusResult,
): Promise<void> {
  const logger = createLogger('SolanaSubmitter');

  logger.info('Submitting unlock to Solana', {
    transferId: result.transferId,
    signatures: result.attestations.length,
  });

  // Load the payer keypair (validator's Solana keypair)
  const keypairData = JSON.parse(fs.readFileSync(config.privateKeyPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const programId = new PublicKey(config.solanaProgramId);

  // Extract event data from the consensus result
  // The original DCC burn event is attached to attestations
  const burnEvent = (result as any).event as DccBurnEvent;
  const transferIdBytes = Buffer.from(result.transferId, 'hex');
  const recipientPubkey = new PublicKey(burnEvent?.solRecipient || PublicKey.default.toBase58());
  // Event already has fee-adjusted amount (applied before consensus signing)
  const amount = BigInt(burnEvent?.amount || 0);
  const burnTxHash = Buffer.from(burnEvent?.txId || '', 'hex');
  // SECURITY FIX (CRIT-7): Use the SAME timestamp that was used during consensus signing.
  // Previously this used Date.now() which produces a different expiration than what
  // validators signed, causing Ed25519 verification to fail on-chain.
  const requestTimestamp = (result as any).requestTimestamp || Date.now();
  const expiration = Math.floor(requestTimestamp / 1000) + 3600;

  logger.info('Preparing unlock', {
    transferId: result.transferId,
    unlockAmount: amount.toString(),
    note: 'Fee already deducted before consensus',
  });

  // ── Construct the canonical message (must match on-chain construct_unlock_message) ──
  const domainSeparator = Buffer.from('SOL_DCC_BRIDGE_UNLOCK_V1');
  const message = Buffer.concat([
    domainSeparator,
    transferIdBytes.length === 32 ? transferIdBytes : Buffer.alloc(32),
    recipientPubkey.toBuffer(),
    Buffer.from(new BigUint64Array([BigInt(amount)]).buffer), // amount as u64 LE (unsigned)
    burnTxHash.length === 32 ? burnTxHash : Buffer.alloc(32),
    Buffer.from(new Uint32Array([config.dccChainId]).buffer), // dcc_chain_id as u32 LE
    Buffer.from(new BigInt64Array([BigInt(expiration)]).buffer), // expiration as i64 LE
  ]);

  // ── Build Ed25519 precompile instructions (one per attestation) ──
  const ed25519Instructions: TransactionInstruction[] = [];
  for (const attestation of result.attestations) {
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: Uint8Array.from(attestation.publicKey),
      message: Uint8Array.from(message),
      signature: Uint8Array.from(attestation.signature),
    });
    ed25519Instructions.push(ed25519Ix);
  }

  // ── Derive PDAs ──
  const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId,
  );
  const [unlockRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('unlock'), transferIdBytes],
    programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')],
    programId,
  );

  // ── Build attestations for the unlock instruction data ──
  // Serialize UnlockParams per Anchor's AnchorSerialize format (Borsh)
  const attestationsData = serializeAttestations(result.attestations);
  const unlockParamsData = serializeUnlockParams({
    transferId: transferIdBytes,
    recipient: recipientPubkey,
    amount,
    burnTxHash,
    dccChainId: config.dccChainId,
    expiration,
    attestations: result.attestations,
  });

  // ── Build unlock instruction ──
  // Anchor instruction discriminator for "unlock" = first 8 bytes of SHA256("global:unlock")
  const crypto = await import('crypto');
  const discriminator = crypto
    .createHash('sha256')
    .update('global:unlock')
    .digest()
    .subarray(0, 8);

  const unlockIxData = Buffer.concat([discriminator, unlockParamsData]);

  // Remaining accounts: validator entry PDAs for each attestation
  const remainingAccountMetas = result.attestations.map((a: Attestation) => {
    const [validatorPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('validator'), a.publicKey],
      programId,
    );
    return {
      pubkey: validatorPda,
      isWritable: false,
      isSigner: false,
    };
  });

  const unlockIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
      { pubkey: unlockRecordPda, isWritable: true, isSigner: false },
      { pubkey: vaultPda, isWritable: true, isSigner: false },
      { pubkey: recipientPubkey, isWritable: true, isSigner: false },
      { pubkey: payer.publicKey, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: new PublicKey('Ed25519SigVerify111111111111111111111111111'), isWritable: false, isSigner: false },
      { pubkey: new PublicKey('Sysvar1nstructions1111111111111111111111111'), isWritable: false, isSigner: false },
      ...remainingAccountMetas,
    ],
    data: unlockIxData,
  });

  // ── Assemble and send transaction ──
  try {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ed25519Instructions, unlockIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payer]);

    const txSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(txSig, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    logger.info('Unlock submitted to Solana successfully', {
      transferId: result.transferId,
      txSignature: txSig,
    });
  } catch (err: any) {
    logger.error('Failed to submit unlock to Solana', {
      transferId: result.transferId,
      error: err.message,
    });
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// BORSH SERIALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════

interface UnlockParamsInput {
  transferId: Buffer;
  recipient: PublicKey;
  amount: bigint;
  burnTxHash: Buffer;
  dccChainId: number;
  expiration: number;
  attestations: Attestation[];
}

/**
 * Serialize UnlockParams to Borsh format matching Anchor's AnchorSerialize.
 * Layout:
 *   transfer_id: [u8; 32]
 *   recipient: Pubkey (32 bytes)
 *   amount: u64 (8 bytes LE)
 *   burn_tx_hash: [u8; 32]
 *   dcc_chain_id: u32 (4 bytes LE)
 *   expiration: i64 (8 bytes LE)
 *   attestations: Vec<ValidatorAttestation>
 *     length: u32 (4 bytes LE)
 *     each:
 *       validator: Pubkey (32 bytes)
 *       signature: [u8; 64]
 */
function serializeUnlockParams(params: UnlockParamsInput): Buffer {
  const parts: Buffer[] = [];

  // transfer_id: [u8; 32]
  const tid = Buffer.alloc(32);
  params.transferId.copy(tid, 0, 0, Math.min(32, params.transferId.length));
  parts.push(tid);

  // recipient: Pubkey
  parts.push(params.recipient.toBuffer());

  // amount: u64 LE
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);
  parts.push(amountBuf);

  // burn_tx_hash: [u8; 32]
  const bth = Buffer.alloc(32);
  params.burnTxHash.copy(bth, 0, 0, Math.min(32, params.burnTxHash.length));
  parts.push(bth);

  // dcc_chain_id: u32 LE
  const cidBuf = Buffer.alloc(4);
  cidBuf.writeUInt32LE(params.dccChainId);
  parts.push(cidBuf);

  // expiration: i64 LE
  const expBuf = Buffer.alloc(8);
  expBuf.writeBigInt64LE(BigInt(params.expiration));
  parts.push(expBuf);

  // attestations: Vec<ValidatorAttestation>
  parts.push(serializeAttestations(params.attestations));

  return Buffer.concat(parts);
}

/**
 * Serialize attestations as a Borsh Vec<ValidatorAttestation>.
 * Layout:
 *   length: u32 LE (4 bytes)
 *   each item:
 *     validator: Pubkey (32 bytes)
 *     signature: [u8; 64]
 */
function serializeAttestations(attestations: Attestation[]): Buffer {
  const parts: Buffer[] = [];

  // Vec length prefix (u32 LE)
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(attestations.length);
  parts.push(lenBuf);

  for (const a of attestations) {
    // validator: Pubkey (32 bytes) — from the publicKey field
    const pkBuf = Buffer.alloc(32);
    a.publicKey.copy(pkBuf, 0, 0, Math.min(32, a.publicKey.length));
    parts.push(pkBuf);

    // signature: [u8; 64]
    const sigBuf = Buffer.alloc(64);
    a.signature.copy(sigBuf, 0, 0, Math.min(64, a.signature.length));
    parts.push(sigBuf);
  }

  return Buffer.concat(parts);
}

// ── Entry Point ──
main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
