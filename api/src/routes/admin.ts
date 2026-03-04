// ═══════════════════════════════════════════════════════════════
// ADMIN DASHBOARD ROUTE
// ═══════════════════════════════════════════════════════════════
//
// Protected admin endpoints for bridge operators.
// Requires ADMIN_API_KEY to access any endpoint.

import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { createLogger } from '../utils/logger';
import {
  getRecentTransfers,
  getTransferStats,
  updateTransferStatus,
} from '../utils/transfer-store';
import {
  getDccConfig,
  getBridgeStats,
} from '../utils/dcc-helpers';

const logger = createLogger('AdminRoute');
export const adminRouter = Router();

// ── Auth Middleware ──────────────────────────────────────────

function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: 'Admin API not configured' });
  }

  const provided =
    req.headers['x-admin-key'] as string ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!provided || provided.length !== adminKey.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(adminKey))) {
    logger.warn('Unauthorized admin access attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

adminRouter.use(requireAdminKey);

// ── Dashboard Overview ──────────────────────────────────────

/**
 * GET /api/v1/admin/dashboard
 *
 * Returns a comprehensive overview for operator monitoring.
 */
adminRouter.get('/dashboard', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const transferStats = getTransferStats();
    const recentTransfers = getRecentTransfers(20);

    // Get DCC bridge stats
    let bridgeOnChain: any = {};
    try {
      const dccCfg = getDccConfig();
      if (dccCfg.bridgeContract) {
        bridgeOnChain = await getBridgeStats(dccCfg.bridgeContract, dccCfg.nodeUrl);
      }
    } catch { /* proceed with empty */ }

    res.json({
      success: true,
      timestamp: Date.now(),
      transfers: transferStats,
      recentTransfers,
      bridge: {
        paused: bridgeOnChain.paused ?? false,
        totalMinted: bridgeOnChain.totalMinted ?? '0',
        dccContract: process.env.DCC_BRIDGE_CONTRACT || '',
        solanaProgram: process.env.SOLANA_PROGRAM_ID || '',
      },
      system: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Recent Transfers ────────────────────────────────────────

/**
 * GET /api/v1/admin/transfers?limit=50&status=pending_confirmation
 */
adminRouter.get('/transfers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const transfers = getRecentTransfers(limit);

    // Optionally filter by status
    const statusFilter = req.query.status as string;
    const filtered = statusFilter
      ? transfers.filter((t: any) => t.status === statusFilter)
      : transfers;

    res.json({
      success: true,
      count: filtered.length,
      transfers: filtered,
    });
  } catch (err) {
    next(err);
  }
});

// ── Manual Status Update ────────────────────────────────────

/**
 * PATCH /api/v1/admin/transfer/:id/status
 *
 * Manually update a transfer's status (for operator intervention).
 */
adminRouter.patch('/transfer/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status, error, destTxHash } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const validStatuses = [
      'pending_confirmation', 'awaiting_consensus', 'consensus_reached',
      'minting', 'completed', 'failed', 'expired', 'paused',
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    logger.info('Admin manual status update', { transferId: id, status, operator: 'admin' });

    const result = updateTransferStatus(id, status, {
      destTxHash,
      error,
    });

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Transfer not found' });
    }

    // Broadcast SSE update
    try {
      const { broadcastTransferUpdate } = require('./transfer');
      broadcastTransferUpdate(id, { status, error, destTxHash, updatedBy: 'admin' });
    } catch { /* SSE not critical */ }

    res.json({ success: true, transferId: id, status });
  } catch (err) {
    next(err);
  }
});

// ── Stats Summary ───────────────────────────────────────────

/**
 * GET /api/v1/admin/stats
 */
adminRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getTransferStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
});
