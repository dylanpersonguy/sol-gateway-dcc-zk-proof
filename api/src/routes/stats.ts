// ═══════════════════════════════════════════════════════════════
// STATS ROUTE — Real on-chain bridge statistics
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import {
  getDccConfig,
  getBridgeStats,
} from '../utils/dcc-helpers';
import { createLogger } from '../utils/logger';

const logger = createLogger('StatsRoute');

export const statsRouter = Router();

statsRouter.get('/', async (_req: Request, res: Response) => {
  const dccCfg = getDccConfig();
  const solanaRpc = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';

  let stats = {
    totalMinted: 0,
    totalBurned: 0,
    outstanding: 0,
    validatorCount: 0,
    paused: false,
    dailyMinted: 0,
  };

  let vaultBalanceLamports = 0;

  // ── Read DCC contract state ──
  try {
    if (dccCfg.bridgeContract) {
      stats = await getBridgeStats(dccCfg.bridgeContract, dccCfg.nodeUrl);
    }
  } catch (err: any) {
    logger.warn('Failed to fetch DCC bridge stats', { error: err.message });
  }

  // ── Read Solana vault balance ──
  try {
    const connection = new Connection(solanaRpc);
    const programId = process.env.SOLANA_PROGRAM_ID;
    if (programId) {
      const { PublicKey } = await import('@solana/web3.js');
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault')],
        new PublicKey(programId),
      );
      vaultBalanceLamports = await connection.getBalance(vault);
    }
  } catch (err: any) {
    logger.warn('Failed to fetch Solana vault balance', { error: err.message });
  }

  // The DCC contract counts wSOL at 8 decimals; the Solana vault holds lamports
  // at 9. Formatting wSOL with /1e9, or dividing lamports by a wSOL figure,
  // understates supply and overstates backing by exactly 10x — a bridge holding
  // a tenth of what it owes would have reported a healthy 1.0 here.
  const WSOL_TO_LAMPORTS = 10;
  const LAMPORTS_PER_SOL = 1e9;

  const toSolFromWsol = (units: number) =>
    ((units * WSOL_TO_LAMPORTS) / LAMPORTS_PER_SOL).toFixed(9);

  const totalMintedFormatted = toSolFromWsol(stats.totalMinted);
  const totalBurnedFormatted = toSolFromWsol(stats.totalBurned);
  const vaultFormatted = (vaultBalanceLamports / LAMPORTS_PER_SOL).toFixed(9);
  const wsolSupply = toSolFromWsol(stats.totalMinted - stats.totalBurned);

  // Both sides in lamports before dividing.
  const outstandingLamports = stats.outstanding * WSOL_TO_LAMPORTS;
  const collateralization =
    outstandingLamports > 0
      ? (vaultBalanceLamports / outstandingLamports).toFixed(4)
      : '1.0000';

  res.json({
    totalTransfers: stats.totalMinted > 0 || stats.totalBurned > 0 ? 'live' : 0,
    totalVolumeSol: totalMintedFormatted,
    totalBurnedSol: totalBurnedFormatted,
    dailyMintedSol: toSolFromWsol(stats.dailyMinted),
    activeValidators: stats.validatorCount,
    vaultBalance: vaultFormatted,
    wsolSupply,
    collateralizationRatio: collateralization,
    bridgePaused: stats.paused,
    timestamp: Date.now(),
  });
});
