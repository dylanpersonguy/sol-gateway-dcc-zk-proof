// ═══════════════════════════════════════════════════════════════
// API Transfer Store — SQLite persistence for transfer records
// ═══════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from './logger';

const logger = createLogger('TransferStore');

const DB_PATH = process.env.API_DB_PATH || path.resolve(__dirname, '../../data/api-transfers.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  const fs = require('fs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  logger.info('Transfer store initialized', { path: DB_PATH });
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id     TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending_confirmation',
  source_chain    TEXT NOT NULL,
  dest_chain      TEXT NOT NULL,
  sender          TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  amount          TEXT NOT NULL,
  amount_formatted TEXT,
  spl_mint        TEXT,
  source_tx_hash  TEXT,
  dest_tx_hash    TEXT,
  confirmations   INTEGER DEFAULT 0,
  validator_sigs  INTEGER DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender);
CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers(recipient);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfers(created_at DESC);
`;

// ── CRUD Operations ──

export function createTransfer(params: {
  transferId: string;
  sourceChain: 'solana' | 'dcc';
  destChain: 'solana' | 'dcc';
  sender: string;
  recipient: string;
  amount: string;
  amountFormatted?: string;
  splMint?: string;
  sourceTxHash?: string;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transfers
      (transfer_id, source_chain, dest_chain, sender, recipient, amount, amount_formatted, spl_mint, source_tx_hash)
    VALUES
      (@transferId, @sourceChain, @destChain, @sender, @recipient, @amount, @amountFormatted, @splMint, @sourceTxHash)
  `);
  return stmt.run({
    transferId: params.transferId,
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    sender: params.sender,
    recipient: params.recipient,
    amount: params.amount,
    amountFormatted: params.amountFormatted || null,
    splMint: params.splMint || null,
    sourceTxHash: params.sourceTxHash || null,
  });
}

export function updateTransferStatus(transferId: string, status: string, extra?: {
  destTxHash?: string;
  confirmations?: number;
  validatorSigs?: number;
  error?: string;
}) {
  const db = getDb();
  const sets = ['status = @status', 'updated_at = unixepoch()'];
  const params: any = { transferId, status };

  if (extra?.destTxHash) {
    sets.push('dest_tx_hash = @destTxHash');
    params.destTxHash = extra.destTxHash;
  }
  if (extra?.confirmations !== undefined) {
    sets.push('confirmations = @confirmations');
    params.confirmations = extra.confirmations;
  }
  if (extra?.validatorSigs !== undefined) {
    sets.push('validator_sigs = @validatorSigs');
    params.validatorSigs = extra.validatorSigs;
  }
  if (extra?.error) {
    sets.push('error = @error');
    params.error = extra.error;
  }

  const stmt = db.prepare(
    `UPDATE transfers SET ${sets.join(', ')} WHERE transfer_id = @transferId`
  );
  return stmt.run(params);
}

export function getTransferById(transferId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId) as any;
}

export function getTransfersByAddress(address: string, page = 1, limit = 20) {
  const db = getDb();
  const offset = (page - 1) * limit;

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM transfers WHERE sender = ? OR recipient = ?'
  ).get(address, address) as any;

  const rows = db.prepare(
    `SELECT * FROM transfers WHERE sender = ? OR recipient = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(address, address, limit, offset);

  return {
    transfers: rows,
    total: total?.count || 0,
    totalPages: Math.ceil((total?.count || 0) / limit),
  };
}

export function getRecentTransfers(limit = 50) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

export function getTransferStats() {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_transfers,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN status NOT IN ('completed', 'failed') THEN 1 END) as pending
    FROM transfers
  `).get() as any;

  return stats || { total_transfers: 0, completed: 0, failed: 0, pending: 0 };
}
