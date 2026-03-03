// Error handling middleware
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const logger = createLogger('ErrorHandler');

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  // Never leak internal error details to client
  res.status(500).json({
    error: 'Internal server error',
    requestId: res.getHeader('X-Request-Id') || 'unknown',
  });
}
