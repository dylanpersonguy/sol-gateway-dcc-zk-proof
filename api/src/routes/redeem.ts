// ═══════════════════════════════════════════════════════════════
// REDEEM ROUTE — Generate burn/redeem instructions for clients
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { createLogger } from '../utils/logger';
import {
  isValidDccAddress,
  buildBurnInstruction,
  getDccConfig,
  getBridgeStats,
} from '../utils/dcc-helpers';

const logger = createLogger('RedeemRoute');

export const redeemRouter = Router();

const RedeemRequestSchema = z.object({
  // DCC wallet address (sender of wSOL.DCC)
  sender: z.string().min(20).max(64),
  // Solana wallet address to receive unlocked SOL
  solRecipient: z.string().min(32).max(44),
  // Amount in wSOL.DCC to burn
  amount: z.number().positive().max(1000),
});

/**
 * POST /api/v1/redeem
 * 
 * Generate a burn/redeem instruction for the DCC client.
 * The user will sign this on the DCC side to burn wSOL.DCC,
 * which triggers validators to unlock SOL on Solana.
 */
redeemRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = RedeemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.issues,
      });
    }

    const { sender, solRecipient, amount } = parsed.data;
    const amountUnits = Math.floor(amount * 1e9); // Convert to smallest unit

    // Validate DCC address
    if (!isValidDccAddress(sender)) {
      return res.status(400).json({ error: 'Invalid DCC address for sender' });
    }

    try {
      new PublicKey(solRecipient);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana recipient address' });
    }

    logger.info('Redeem request', { sender, solRecipient, amount });

    const dccCfg = getDccConfig();

    if (!dccCfg.bridgeContract || !dccCfg.wsolAssetId) {
      return res.status(503).json({ error: 'Bridge not configured — missing contract or asset ID' });
    }

    // Generate the DCC burn instruction for client-side signing
    const redeemInstruction = buildBurnInstruction({
      dApp: dccCfg.bridgeContract,
      solRecipient,
      wsolAssetId: dccCfg.wsolAssetId,
      amount: amountUnits,
      chainId: dccCfg.chainIdChar,
    });

    res.json({
      success: true,
      instruction: redeemInstruction,
      metadata: {
        bridgeContract: dccCfg.bridgeContract,
        wsolAssetId: dccCfg.wsolAssetId,
        amountUnits,
        solRecipient,
        estimatedUnlockTime: '3-10 minutes',
        estimatedFee: '0.005 DCC',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/redeem/limits
 * 
 * Returns current redeem limits (reads paused state from chain)
 */
redeemRouter.get('/limits', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const dccCfg = getDccConfig();
    let paused = false;
    try {
      if (dccCfg.bridgeContract) {
        const stats = await getBridgeStats(dccCfg.bridgeContract, dccCfg.nodeUrl);
        paused = stats.paused;
      }
    } catch { /* use defaults */ }

    res.json({
      minRedeem: '0.001',
      maxRedeem: '100',
      maxDailyRedeem: '1000',
      bridgeStatus: paused ? 'paused' : 'active',
      estimatedUnlockTime: '3-10 minutes',
      dccConfirmations: 10,
    });
  } catch (err) {
    next(err);
  }
});
