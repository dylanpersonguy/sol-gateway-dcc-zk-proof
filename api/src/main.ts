// ═══════════════════════════════════════════════════════════════
// BRIDGE API SERVER — Main Entry Point
// ═══════════════════════════════════════════════════════════════
//
// User-facing REST API for the SOL ⇄ DCC Bridge.
//
// SECURITY: This server NEVER holds funds. It only provides:
// - Transfer status tracking
// - Fee estimation
// - Deposit instruction generation (client-side signing)
// - Burn instruction generation (client-side signing)
// - Bridge health/stats

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from './swagger.json';
import { depositRouter } from './routes/deposit';
import { transferRouter } from './routes/transfer';
import { redeemRouter } from './routes/redeem';
import { healthRouter } from './routes/health';
import { statsRouter } from './routes/stats';
import { adminRouter } from './routes/admin';
import { feeRouter } from './routes/fees';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { createLogger } from './utils/logger';

// Load .env from workspace root (parent of api/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // also check api/.env if it exists

const logger = createLogger('API');
const PORT = parseInt(process.env.API_PORT || '3000');

async function main(): Promise<void> {
  const app = express();

  // ── Security Middleware ──
  app.use(helmet());
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // ── Rate Limiting ──
  const isInternalRequest = (req: any) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.') ||
           ip.startsWith('172.') || ip.startsWith('10.') || ip === '::ffff:172.22.0.1';
  };

  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isInternalRequest,
    message: { error: 'Too many requests — rate limit exceeded' },
  });

  const depositLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    skip: isInternalRequest,
    message: { error: 'Deposit rate limit exceeded — try again later' },
  });

  app.use(globalLimiter);

  // ── Body Parsing ──
  app.use(express.json({ limit: '1mb' }));

  // ── Request Logging ──
  app.use(requestLogger);

  // ── Routes ──
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'SOL ⇄ DCC Bridge API Docs',
  }));
  app.use('/api/v1/deposit', depositLimiter, depositRouter);
  app.use('/api/v1/transfer', transferRouter);
  app.use('/api/v1/redeem', depositLimiter, redeemRouter);
  app.use('/api/v1/fees', feeRouter);
  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/stats', statsRouter);
  app.use('/api/v1/admin', adminRouter);

  // ── Error Handling ──
  app.use(errorHandler);

  // ── Start Server ──
  app.listen(PORT, () => {
    logger.info(`Bridge API server running on port ${PORT}`);
    logger.info('Endpoints:');
    logger.info(`  📚 /api/docs             — Swagger UI (interactive docs)`);
    logger.info(`  POST /api/v1/deposit     — Generate deposit instruction`);
    logger.info(`  POST /api/v1/deposit/spl — Generate SPL deposit instruction`);
    logger.info(`  GET  /api/v1/transfer/:id — Get transfer status`);
    logger.info(`  GET  /api/v1/transfer/:id/stream — SSE real-time updates`);
    logger.info(`  POST /api/v1/redeem       — Generate redeem instruction`);
    logger.info(`  GET  /api/v1/fees         — Fee schedule`);
    logger.info(`  GET  /api/v1/fees/quote   — Fee quote calculator`);
    logger.info(`  GET  /api/v1/health       — Bridge health status`);
    logger.info(`  GET  /api/v1/stats        — Bridge statistics`);
    logger.info(`  GET  /api/v1/admin/*      — Admin dashboard (key required)`);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err });
  process.exit(1);
});
