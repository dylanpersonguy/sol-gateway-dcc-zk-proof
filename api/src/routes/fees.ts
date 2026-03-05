// ═══════════════════════════════════════════════════════════════
// FEE ROUTE — Bridge Fee Quotes
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';
import { calculateFee, FEE_SCHEDULES } from '../utils/fee-calculator';

const logger = createLogger('FeeRoute');

export const feeRouter = Router();

/**
 * GET /api/v1/fees
 *
 * Returns the current fee schedule for all paths and directions.
 */
feeRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    fees: FEE_SCHEDULES,
    description: {
      deposit: {
        committee: 'Deposits < 100 SOL via committee fast-path',
        zk: 'Deposits ≥ 100 SOL via ZK proof path',
      },
      withdrawal: {
        committee: 'Withdrawals < 100 SOL via committee fast-path',
        zk: 'Withdrawals ≥ 100 SOL via ZK proof path',
      },
      minFeeSol: 'Minimum fee floor applied to micro-transfers',
      zkThresholdSol: 'Amount threshold for ZK proof path routing',
    },
  });
});

/**
 * GET /api/v1/fees/quote?amount=X&direction=deposit|withdrawal
 *
 * Returns a fee quote for a specific amount and direction.
 */
feeRouter.get('/quote', (req: Request, res: Response, next: NextFunction) => {
  try {
    const amount = parseFloat(req.query.amount as string);
    const direction = req.query.direction as string;

    if (isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Invalid amount — must be a positive number' });
    }

    if (direction !== 'deposit' && direction !== 'withdrawal') {
      return res.status(400).json({ error: 'Invalid direction — must be "deposit" or "withdrawal"' });
    }

    const quote = calculateFee(amount, direction);

    logger.debug('Fee quote generated', {
      amount,
      direction,
      fee: quote.feeAmount,
      receive: quote.receiveAmount,
      path: quote.path,
    });

    res.json({
      success: true,
      quote,
    });
  } catch (err) {
    next(err);
  }
});
