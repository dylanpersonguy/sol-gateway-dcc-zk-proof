'use strict';
/**
 * SQLite persistence layer — users, transfers, notifications
 */
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  sol_address TEXT NOT NULL,
  dcc_address TEXT NOT NULL,
  created_at  INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL,
  direction      TEXT NOT NULL,    -- 'sol_to_dcc' | 'dcc_to_sol'
  token          TEXT NOT NULL,    -- 'USDC', 'SOL', 'USDT', ...
  spl_mint       TEXT,             -- Solana mint pubkey (base58)
  amount_units   TEXT NOT NULL,    -- store as TEXT to avoid JS BigInt issues
  decimals       INTEGER NOT NULL DEFAULT 6,
  src_address    TEXT NOT NULL,    -- source wallet
  dst_address    TEXT NOT NULL,    -- destination wallet (other chain)
  transfer_id    TEXT,             -- bridge transfer ID hex
  sol_tx_sig     TEXT,             -- Solana tx signature
  dcc_tx_id      TEXT,             -- DCC tx ID
  status         TEXT NOT NULL DEFAULT 'pending',
  error          TEXT,
  notify_msg_id  INTEGER,          -- Telegram message ID for status message
  created_at     INTEGER DEFAULT (strftime('%s','now')),
  updated_at     INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_transfers_user   ON transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
CREATE INDEX IF NOT EXISTS idx_transfers_sol    ON transfers(sol_tx_sig);
CREATE INDEX IF NOT EXISTS idx_transfers_dcc    ON transfers(dcc_tx_id);
CREATE INDEX IF NOT EXISTS idx_transfers_tid    ON transfers(transfer_id);

CREATE TABLE IF NOT EXISTS deposits (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  chain        TEXT NOT NULL,      -- 'solana' | 'dcc'
  address      TEXT NOT NULL,      -- deposit address (custodial wallet)
  token        TEXT NOT NULL,
  spl_mint     TEXT,
  amount_units TEXT NOT NULL,
  tx_sig       TEXT NOT NULL,
  slot_or_height INTEGER,
  seen_at      INTEGER DEFAULT (strftime('%s','now')),
  processed    INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx ON deposits(chain, tx_sig);

CREATE TABLE IF NOT EXISTS scan_cursors (
  chain        TEXT NOT NULL,     -- 'solana' | 'dcc'
  address      TEXT NOT NULL,
  last_slot    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (chain, address)
);
`;

// ── Init ───────────────────────────────────────────────────────────
function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ── Users ──────────────────────────────────────────────────────────
function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function upsertUser({ userId, username, firstName, solAddress, dccAddress }) {
  db.prepare(`
    INSERT INTO users (user_id, username, first_name, sol_address, dcc_address)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name
  `).run(userId, username || null, firstName || null, solAddress, dccAddress);
  return getUser(userId);
}

// ── Transfers ──────────────────────────────────────────────────────
function createTransfer({
  userId, direction, token, splMint, amountUnits, decimals,
  srcAddress, dstAddress,
}) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO transfers
      (id, user_id, direction, token, spl_mint, amount_units, decimals, src_address, dst_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, direction, token, splMint || null, String(amountUnits), decimals, srcAddress, dstAddress);
  return getTransfer(id);
}

function getTransfer(id) {
  return db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
}

// Allowed columns for updateTransfer — whitelist prevents SQL injection
const TRANSFER_UPDATABLE_COLS = new Set([
  'status', 'error', 'transfer_id', 'sol_tx_sig', 'dcc_tx_id', 'notify_msg_id',
]);

function updateTransfer(id, fields) {
  const entries = Object.entries(fields).filter(([k]) => {
    if (!TRANSFER_UPDATABLE_COLS.has(k)) {
      console.warn(`[store] updateTransfer: ignoring unknown column '${k}'`);
      return false;
    }
    return true;
  });
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const vals = entries.map(([, v]) => v);
  db.prepare(`UPDATE transfers SET ${sets}, updated_at = strftime('%s','now') WHERE id = ?`).run(...vals, id);
}

function getTransfersByUser(userId, limit = 10) {
  return db.prepare('SELECT * FROM transfers WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}

function getPendingTransfers() {
  return db.prepare(`SELECT * FROM transfers WHERE status IN ('pending','sol_confirmed','dcc_confirmed')`).all();
}

function getTransferByTid(transferId) {
  return db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId);
}

// ── Deposits ──────────────────────────────────────────────────────
function recordDeposit({ chain, userId, address, token, splMint, amountUnits, txSig, slotOrHeight }) {
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO deposits (id, user_id, chain, address, token, spl_mint, amount_units, tx_sig, slot_or_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, chain, address, token, splMint || null, String(amountUnits), txSig, slotOrHeight || 0);
    return { id, isNew: true };
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return { id: null, isNew: false };
    throw e;
  }
}

function markDepositProcessed(txSig, chain) {
  db.prepare('UPDATE deposits SET processed = 1 WHERE tx_sig = ? AND chain = ?').run(txSig, chain);
}

function getUnprocessedDeposits() {
  return db.prepare('SELECT * FROM deposits WHERE processed = 0').all();
}

// ── Scan Cursors (persistent last-scanned slot/height) ────────
function getScanCursor(chain, address) {
  const row = db.prepare('SELECT last_slot FROM scan_cursors WHERE chain = ? AND address = ?').get(chain, address);
  return row ? row.last_slot : 0;
}

function setScanCursor(chain, address, lastSlot) {
  db.prepare(`
    INSERT INTO scan_cursors (chain, address, last_slot) VALUES (?, ?, ?)
    ON CONFLICT(chain, address) DO UPDATE SET last_slot = excluded.last_slot, updated_at = strftime('%s','now')
  `).run(chain, address, lastSlot);
}

function getAllScanCursors(chain) {
  return db.prepare('SELECT address, last_slot FROM scan_cursors WHERE chain = ?').all(chain);
}

module.exports = {
  init, getUser, upsertUser,
  createTransfer, getTransfer, updateTransfer, getTransfersByUser,
  getPendingTransfers, getTransferByTid,
  recordDeposit, markDepositProcessed, getUnprocessedDeposits,
  getScanCursor, setScanCursor, getAllScanCursors,
};
