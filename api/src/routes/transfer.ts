// ═══════════════════════════════════════════════════════════════
// TRANSFER STATUS ROUTE
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';
import {
  isTransferProcessed,
  getBurnRecord,
  getDccConfig,
} from '../utils/dcc-helpers';

const logger = createLogger('TransferRoute');

export const transferRouter = Router();

export type TransferStatus =
  | 'pending_confirmation'  // Waiting for Solana finality
  | 'awaiting_consensus'    // Waiting for validator consensus
  | 'consensus_reached'     // Validators agreed
  | 'minting'              // Minting on DCC
  | 'completed'            // Transfer complete
  | 'failed'               // Transfer failed
  | 'expired'              // Transfer expired
  | 'paused';              // Bridge paused

export interface TransferDetails {
  transferId: string;
  status: TransferStatus;
  sourceChain: 'solana' | 'dcc';
  destinationChain: 'solana' | 'dcc';
  sender: string;
  recipient: string;
  amount: string;
  amountFormatted: string;
  sourceTxHash: string | null;
  destinationTxHash: string | null;
  confirmations: number;
  requiredConfirmations: number;
  validatorSignatures: number;
  requiredSignatures: number;
  createdAt: number;
  updatedAt: number;
  estimatedCompletion: number | null;
  error: string | null;
}

/**
 * GET /api/v1/transfer/:id
 * 
 * Get detailed status of a bridge transfer
 */
transferRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    if (!id || id.length < 16) {
      return res.status(400).json({ error: 'Invalid transfer ID' });
    }

    logger.info('Transfer status query', { transferId: id });

    const dccCfg = getDccConfig();
    let status: TransferStatus = 'pending_confirmation';
    let destinationTxHash: string | null = null;

    // Check on-chain state for this transfer
    try {
      if (dccCfg.bridgeContract) {
        // Check if this was a deposit (mint) that's been processed
        const processed = await isTransferProcessed(
          dccCfg.bridgeContract,
          id,
          dccCfg.nodeUrl,
        );
        if (processed) {
          status = 'completed';
        }

        // Check if this is a burn record
        const burnRecord = await getBurnRecord(dccCfg.bridgeContract, id, dccCfg.nodeUrl);
        if (burnRecord) {
          status = 'completed';
        }
      }
    } catch (err: any) {
      logger.warn('Failed to query DCC for transfer status', { transferId: id, error: err.message });
    }

    const transfer: TransferDetails = {
      transferId: id,
      status,
      sourceChain: 'solana',
      destinationChain: 'dcc',
      sender: '',
      recipient: '',
      amount: '0',
      amountFormatted: '0 SOL',
      sourceTxHash: null,
      destinationTxHash,
      confirmations: 0,
      requiredConfirmations: 32,
      validatorSignatures: 0,
      requiredSignatures: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      estimatedCompletion: null,
      error: null,
    };

    res.json({ success: true, transfer });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/transfer/history/:address
 * 
 * Get transfer history for a wallet address
 */
transferRouter.get('/history/:address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    logger.info('Transfer history query', { address, page, limit });

    // TODO: Query from database
    res.json({
      success: true,
      transfers: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
    });
  } catch (err) {
    next(err);
  }
});
