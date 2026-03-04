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
import {
  getTransferById,
  getTransfersByAddress,
} from '../utils/transfer-store';

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

    // First check local database
    const dbTransfer = getTransferById(id);

    const dccCfg = getDccConfig();
    let status: TransferStatus = dbTransfer?.status || 'pending_confirmation';
    let destinationTxHash: string | null = dbTransfer?.dest_tx_hash || null;

    // If not yet completed, check on-chain state
    if (status !== 'completed') {
      try {
        if (dccCfg.bridgeContract) {
          const processed = await isTransferProcessed(
            dccCfg.bridgeContract,
            id,
            dccCfg.nodeUrl,
          );
          if (processed) status = 'completed';

          const burnRecord = await getBurnRecord(dccCfg.bridgeContract, id, dccCfg.nodeUrl);
          if (burnRecord) status = 'completed';
        }
      } catch (err: any) {
        logger.warn('Failed to query DCC for transfer status', { transferId: id, error: err.message });
      }
    }

    const transfer: TransferDetails = {
      transferId: id,
      status,
      sourceChain: dbTransfer?.source_chain || 'solana',
      destinationChain: dbTransfer?.dest_chain || 'dcc',
      sender: dbTransfer?.sender || '',
      recipient: dbTransfer?.recipient || '',
      amount: dbTransfer?.amount || '0',
      amountFormatted: dbTransfer?.amount_formatted || '0 SOL',
      sourceTxHash: dbTransfer?.source_tx_hash || null,
      destinationTxHash,
      confirmations: dbTransfer?.confirmations || 0,
      requiredConfirmations: 32,
      validatorSignatures: dbTransfer?.validator_sigs || 0,
      requiredSignatures: 3,
      createdAt: dbTransfer?.created_at ? dbTransfer.created_at * 1000 : Date.now(),
      updatedAt: dbTransfer?.updated_at ? dbTransfer.updated_at * 1000 : Date.now(),
      estimatedCompletion: null,
      error: dbTransfer?.error || null,
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

    const result = getTransfersByAddress(address, page, limit);

    res.json({
      success: true,
      transfers: result.transfers,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── SSE: Real-time Transfer Status Push ──────────────────────

// In-memory subscriber map: transferId → Set<Response>
const sseClients = new Map<string, Set<Response>>();

/**
 * Broadcast a status update to all SSE subscribers for a transfer.
 * Call this from anywhere in the API when a transfer status changes.
 */
export function broadcastTransferUpdate(transferId: string, data: Record<string, any>): void {
  const clients = sseClients.get(transferId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify({ transferId, ...data })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }

  // Clean up completed transfers
  if (data.status === 'completed' || data.status === 'failed') {
    for (const res of clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseClients.delete(transferId);
  }
}

/**
 * GET /api/v1/transfer/:id/stream
 *
 * Server-Sent Events stream for real-time transfer status updates.
 * The client connects and receives push updates as the transfer progresses.
 */
transferRouter.get('/:id/stream', (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id || id.length < 16) {
    return res.status(400).json({ error: 'Invalid transfer ID' });
  }

  logger.info('SSE client connected', { transferId: id });

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });

  // Send initial keepalive
  res.write(': connected\n\n');

  // Register client
  if (!sseClients.has(id)) {
    sseClients.set(id, new Set());
  }
  sseClients.get(id)!.add(res);

  // Send current status immediately
  const current = getTransferById(id);
  if (current) {
    res.write(`data: ${JSON.stringify({ transferId: id, status: current.status, ...current })}\n\n`);
  }

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 30_000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.get(id)?.delete(res);
    if (sseClients.get(id)?.size === 0) sseClients.delete(id);
    logger.info('SSE client disconnected', { transferId: id });
  });
});
