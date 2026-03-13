// ═══════════════════════════════════════════════════════════════
// DECENTRAL USD (DUSD) MINT / REDEEM ROUTE
// ═══════════════════════════════════════════════════════════════
//
// Generates deposit instructions for minting DUSD tokens.
// Users deposit USDC or USDT on Solana and receive DUSD 1:1.
// Reuses the existing bridge deposit infrastructure.

import { Router, Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { createLogger } from '../utils/logger';

const logger = createLogger('DUSD');

export const dusdRouter = Router();

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const BRIDGE_PROGRAM_ID = process.env.BRIDGE_PROGRAM_ID || '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || 'A2CMs9oPjSW46NvQDKFDqBqxj9EMvoJbTKkJJP9WK96U';

/** Accepted source tokens for DUSD minting */
const ACCEPTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const DUSD_MINT_FEE_RATE = 0.001; // 0.1%
const DUSD_REDEEM_FEE_RATE = 0.001; // 0.1%
const DUSD_MINIMUM = 1; // $1 minimum

/**
 * POST /api/v1/dusd/mint
 * Generate a deposit instruction for minting DUSD.
 * Accepts USDC or USDT — 1:1 backed stablecoin.
 */
dusdRouter.post('/mint', async (req: Request, res: Response) => {
  try {
    const { sender, recipientDcc, amount, splMint } = req.body;

    // Validate required fields
    if (!sender || typeof sender !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid sender address' });
    }
    if (!recipientDcc || typeof recipientDcc !== 'string' || recipientDcc.length < 20) {
      return res.status(400).json({ error: 'Missing or invalid DCC recipient address' });
    }
    if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (amount < DUSD_MINIMUM) {
      return res.status(400).json({ error: `Minimum mint amount is $${DUSD_MINIMUM}` });
    }
    if (!splMint || !ACCEPTED_MINTS.has(splMint)) {
      return res.status(400).json({
        error: 'Invalid source token. Accepted: USDC, USDT',
        acceptedMints: Array.from(ACCEPTED_MINTS),
      });
    }

    // Validate Solana address
    let senderPubkey: PublicKey;
    try {
      senderPubkey = new PublicKey(sender);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana sender address' });
    }

    const programId = new PublicKey(BRIDGE_PROGRAM_ID);

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
      [Buffer.from('user_state'), senderPubkey.toBytes()],
      programId,
    );

    // Compute amount in token smallest units (USDC/USDT = 6 decimals)
    const amountLamports = Math.round(amount * 1e6);
    const feeAmount = amount * DUSD_MINT_FEE_RATE;
    const mintAmount = amount - feeAmount;

    logger.info('DUSD mint request', {
      sender: sender.slice(0, 8) + '...',
      splMint: splMint.slice(0, 8) + '...',
      amount,
      mintAmount: mintAmount.toFixed(2),
      feeAmount: feeAmount.toFixed(4),
    });

    return res.json({
      success: true,
      metadata: {
        programId: BRIDGE_PROGRAM_ID,
        bridgeConfig: bridgeConfig.toBase58(),
        vault: vault.toBase58(),
        userState: userState.toBase58(),
        amountLamports: amountLamports.toString(),
        splMint,
      },
      dusd: {
        mintAmount: mintAmount.toFixed(6),
        feeAmount: feeAmount.toFixed(6),
        feeRate: DUSD_MINT_FEE_RATE,
        symbol: 'DUSD',
      },
    });
  } catch (err: any) {
    logger.error('DUSD mint error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/dusd/redeem
 * Generate a redeem instruction for burning DUSD and unlocking USDC/USDT.
 */
dusdRouter.post('/redeem', async (req: Request, res: Response) => {
  try {
    const { sender, recipientSol, amount, outputMint } = req.body;

    // Validate required fields
    if (!sender || typeof sender !== 'string' || sender.length < 20) {
      return res.status(400).json({ error: 'Missing or invalid DCC sender address' });
    }
    if (!recipientSol || typeof recipientSol !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid Solana recipient address' });
    }
    if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (amount < DUSD_MINIMUM) {
      return res.status(400).json({ error: `Minimum redeem amount is $${DUSD_MINIMUM}` });
    }
    if (!outputMint || !ACCEPTED_MINTS.has(outputMint)) {
      return res.status(400).json({
        error: 'Invalid output token. Accepted: USDC, USDT',
        acceptedMints: Array.from(ACCEPTED_MINTS),
      });
    }

    // Validate Solana recipient address
    try {
      new PublicKey(recipientSol);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana recipient address' });
    }

    const feeAmount = amount * DUSD_REDEEM_FEE_RATE;
    const redeemAmount = amount - feeAmount;

    logger.info('DUSD redeem request', {
      sender: sender.slice(0, 8) + '...',
      recipientSol: recipientSol.slice(0, 8) + '...',
      amount,
      redeemAmount: redeemAmount.toFixed(2),
      feeAmount: feeAmount.toFixed(4),
    });

    return res.json({
      success: true,
      redeem: {
        recipientSol,
        outputMint,
        redeemAmount: redeemAmount.toFixed(6),
        feeAmount: feeAmount.toFixed(6),
        feeRate: DUSD_REDEEM_FEE_RATE,
        symbol: 'DUSD',
      },
    });
  } catch (err: any) {
    logger.error('DUSD redeem error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/dusd/info
 * Return DUSD token info and reserve status.
 */
dusdRouter.get('/info', async (_req: Request, res: Response) => {
  try {
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const vaultPubkey = new PublicKey(VAULT_ADDRESS);

    // Check vault balance for reserve reporting
    let vaultBalance = 0;
    try {
      const balInfo = await connection.getBalance(vaultPubkey);
      vaultBalance = balInfo / 1e9;
    } catch {
      // Non-critical
    }

    return res.json({
      symbol: 'DUSD',
      name: 'Decentral USD',
      fullName: 'Decentral USD Stablecoin',
      decimals: 6,
      description: 'A decentralized stablecoin backed 1:1 by USDC/USDT reserves locked on Solana. Deposit USDC or USDT to mint DUSD; redeem DUSD to unlock your collateral.',
      backing: {
        acceptedTokens: ['USDC', 'USDT'],
        mechanism: '1:1 collateralized',
        vaultAddress: VAULT_ADDRESS,
        vaultBalanceSol: vaultBalance,
      },
      fees: {
        mintFee: '0.10%',
        redeemFee: '0.10%',
        minimumMint: DUSD_MINIMUM,
        minimumRedeem: DUSD_MINIMUM,
      },
    });
  } catch (err: any) {
    logger.error('DUSD info error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
