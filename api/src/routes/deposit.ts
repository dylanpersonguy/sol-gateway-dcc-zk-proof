// ═══════════════════════════════════════════════════════════════
// DEPOSIT ROUTE — Generate deposit instructions for clients
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createLogger } from '../utils/logger';
import { isValidDccAddress, getDccConfig, getBridgeStats } from '../utils/dcc-helpers';

const logger = createLogger('DepositRoute');

export const depositRouter = Router();

// Input validation schema
const DepositRequestSchema = z.object({
  // Sender's Solana wallet address
  sender: z.string().min(32).max(44),
  // Recipient on DecentralChain (base58 or hex)
  recipientDcc: z.string().min(20).max(64),
  // Amount in SOL (not lamports) — we convert server-side
  amount: z.number().positive().max(1000),
});

/**
 * POST /api/v1/deposit
 * 
 * Generate a deposit transaction for the client to sign.
 * The API server NEVER has access to the user's private key.
 * 
 * Returns: Serialized transaction for client-side signing
 */
depositRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate input
    const parsed = DepositRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.issues,
      });
    }

    const { sender, recipientDcc, amount } = parsed.data;
    const amountLamports = Math.floor(amount * 1e9); // SOL to lamports

    logger.info('Deposit request', {
      sender,
      recipientDcc,
      amount,
      amountLamports,
    });

    // Validate addresses
    let senderPubkey: PublicKey;
    try {
      senderPubkey = new PublicKey(sender);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    // Validate DCC recipient address
    if (!isValidDccAddress(recipientDcc)) {
      return res.status(400).json({ error: 'Invalid DCC recipient address' });
    }

    // Check if bridge is paused
    try {
      const dccCfg = getDccConfig();
      if (dccCfg.bridgeContract) {
        const stats = await getBridgeStats(dccCfg.bridgeContract, dccCfg.nodeUrl);
        if (stats.paused) {
          return res.status(503).json({ error: 'Bridge is currently paused' });
        }
      }
    } catch { /* proceed if can't reach DCC — Solana side will still work */ }

    // Get bridge program ID from env
    const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || '');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const connection = new Connection(rpcUrl);

    // Derive PDAs
    const [bridgeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_config')],
      programId,
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      programId,
    );
    const [userState] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_state'), senderPubkey.toBuffer()],
      programId,
    );

    // Encode recipient DCC address as 32-byte array
    const recipientBytes = Buffer.alloc(32);
    const recipientBuf = Buffer.from(recipientDcc);
    recipientBuf.copy(recipientBytes, 0, 0, Math.min(recipientBuf.length, 32));

    // Get current slot for transfer ID computation
    const slot = await connection.getSlot();

    // Build the deposit instruction
    // The client will sign and submit this transaction
    const depositInstruction = {
      programId: programId.toString(),
      accounts: [
        { pubkey: bridgeConfig.toString(), isSigner: false, isWritable: true },
        { pubkey: userState.toString(), isSigner: false, isWritable: true },
        // deposit_record PDA will be computed client-side with the actual nonce
        { pubkey: vault.toString(), isSigner: false, isWritable: true },
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId.toString(), isSigner: false, isWritable: false },
      ],
      data: {
        recipientDcc: recipientBytes.toString('hex'),
        amount: amountLamports,
      },
    };

    // Return the instruction data for client-side transaction construction
    res.json({
      success: true,
      instruction: depositInstruction,
      metadata: {
        bridgeConfig: bridgeConfig.toString(),
        vault: vault.toString(),
        userState: userState.toString(),
        programId: programId.toString(),
        recipientDccHex: recipientBytes.toString('hex'),
        amountLamports,
        currentSlot: slot,
        estimatedFee: 5000, // lamports
        estimatedTime: '2-5 minutes',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/deposit/limits
 * 
 * Returns current deposit limits and bridge status
 */
depositRouter.get('/limits', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Read limits from on-chain BridgeConfig account
    const programId = process.env.SOLANA_PROGRAM_ID;
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

    let minDeposit = '0.001';
    let maxDeposit = '100';
    let bridgeStatus = 'active';

    if (programId) {
      try {
        const connection = new Connection(rpcUrl);
        const pid = new PublicKey(programId);
        const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('bridge_config')],
          pid,
        );
        const accountInfo = await connection.getAccountInfo(bridgeConfigPda);
        if (accountInfo?.data) {
          // BridgeConfig layout: 8 (discriminator) + fields
          // We read min_deposit and max_deposit as u64 at known offsets
          // Authority(32) + dcc_contract(32) + threshold(1) + validator_count(1) + paused(1) + nonce(8) + min_deposit(8) + max_deposit(8)
          const data = accountInfo.data;
          const OFFSET_PAUSED = 8 + 32 + 32 + 1 + 1; // discriminator + authority + dcc_contract + threshold + validator_count
          const OFFSET_MIN = OFFSET_PAUSED + 1 + 8; // paused + nonce
          const OFFSET_MAX = OFFSET_MIN + 8;

          if (data.length >= OFFSET_MAX + 8) {
            const paused = data[OFFSET_PAUSED] !== 0;
            const minLamports = data.readBigUInt64LE(OFFSET_MIN);
            const maxLamports = data.readBigUInt64LE(OFFSET_MAX);
            minDeposit = (Number(minLamports) / 1e9).toString();
            maxDeposit = (Number(maxLamports) / 1e9).toString();
            if (paused) bridgeStatus = 'paused';
          }
        }
      } catch (e: any) {
        logger.warn('Could not read on-chain limits, using defaults', { error: e.message });
      }
    }

    res.json({
      minDeposit,
      maxDeposit,
      maxDailyVolume: '1000',
      currentDailyVolume: '0',
      bridgeStatus,
      estimatedMintTime: '2-5 minutes',
      solanaConfirmations: 32,
    });
  } catch (err) {
    next(err);
  }
});

// ── SPL Token Deposit ────────────────────────────────────────

const SplDepositSchema = z.object({
  sender: z.string().min(32).max(44),
  recipientDcc: z.string().min(20).max(64),
  amount: z.number().positive(),
  splMint: z.string().min(32).max(44),
});

/**
 * POST /api/v1/deposit/spl
 *
 * Generate an SPL token deposit instruction for client-side signing.
 */
depositRouter.post('/spl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SplDepositSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    const { sender, recipientDcc, amount, splMint } = parsed.data;

    logger.info('SPL deposit request', { sender, recipientDcc, amount, splMint });

    let senderPubkey: PublicKey;
    let mintPubkey: PublicKey;
    try {
      senderPubkey = new PublicKey(sender);
      mintPubkey = new PublicKey(splMint);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana or mint address' });
    }

    if (!isValidDccAddress(recipientDcc)) {
      return res.status(400).json({ error: 'Invalid DCC recipient address' });
    }

    // Check bridge status
    try {
      const dccCfg = getDccConfig();
      if (dccCfg.bridgeContract) {
        const stats = await getBridgeStats(dccCfg.bridgeContract, dccCfg.nodeUrl);
        if (stats.paused) {
          return res.status(503).json({ error: 'Bridge is currently paused' });
        }
      }
    } catch { /* proceed */ }

    const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || '');

    const [bridgeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_config')], programId,
    );
    const [splVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('spl_vault'), mintPubkey.toBuffer()], programId,
    );
    const [userState] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_state'), senderPubkey.toBuffer()], programId,
    );

    const senderAta = getAssociatedTokenAddressSync(mintPubkey, senderPubkey);

    const recipientBytes = Buffer.alloc(32);
    const recipientBuf = Buffer.from(recipientDcc);
    recipientBuf.copy(recipientBytes, 0, 0, Math.min(recipientBuf.length, 32));

    const depositInstruction = {
      programId: programId.toString(),
      accounts: [
        { pubkey: bridgeConfig.toString(), isSigner: false, isWritable: true },
        { pubkey: userState.toString(), isSigner: false, isWritable: true },
        { pubkey: splVault.toString(), isSigner: false, isWritable: true },
        { pubkey: senderAta.toString(), isSigner: false, isWritable: true },
        { pubkey: mintPubkey.toString(), isSigner: false, isWritable: false },
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID.toString(), isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID.toString(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId.toString(), isSigner: false, isWritable: false },
      ],
      data: {
        recipientDcc: recipientBytes.toString('hex'),
        amount,
        splMint,
      },
    };

    res.json({
      success: true,
      instruction: depositInstruction,
      metadata: {
        bridgeConfig: bridgeConfig.toString(),
        splVault: splVault.toString(),
        userState: userState.toString(),
        senderAta: senderAta.toString(),
        programId: programId.toString(),
        recipientDccHex: recipientBytes.toString('hex'),
        amount,
        splMint,
        estimatedTime: '2-5 minutes',
      },
    });
  } catch (err) {
    next(err);
  }
});
