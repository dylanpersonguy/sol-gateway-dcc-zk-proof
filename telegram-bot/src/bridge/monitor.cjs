'use strict';
const { createHash } = require('crypto');
/**
 * Bridge Monitor — background polling loops that watch both chains
 * for incoming deposits and burn events, triggering the relay.
 *
 * Architecture:
 *   - Every SOL_POLL_INTERVAL_MS: scan custodial Solana wallets for incoming SPL/SOL
 *   - Every DCC_POLL_INTERVAL_MS: scan DCC bridge for burnToken events
 *   - On match: call relay + notify user via Telegram bot
 */
const { makeConnection, scanIncomingSpl, scanIncomingSol, KNOWN_TOKENS, NATIVE_SOL_MINT } = require('../chains/solana.cjs');
const { scanBurnRecords, getTokenAssetId }   = require('../chains/dcc.cjs');
const { relaySolToDcc, relayDccToSol } = require('./relay.cjs');
const store   = require('../store.cjs');
const config  = require('../config.cjs');
const { escMd } = require('../utils/escape-md.cjs');

// State maps: address → last seen slot/height (warm cache backed by SQLite)
const solSlotMap = new Map();  // sol_address → last slot scanned
const dccHeightMap = new Map(); // dcc_address → last height scanned

/** Load persisted cursors from SQLite into in-memory maps */
function loadCursors() {
  try {
    for (const row of store.getAllScanCursors('solana')) {
      solSlotMap.set(row.address, row.last_slot);
    }
    for (const row of store.getAllScanCursors('dcc')) {
      dccHeightMap.set(row.address, row.last_slot);
    }
    console.log(`[monitor] Loaded cursors: ${solSlotMap.size} Solana, ${dccHeightMap.size} DCC`);
  } catch (e) {
    console.warn('[monitor] Could not load scan cursors:', e.message);
  }
}

let botRef = null;    // Telegraf bot instance (set at start)
let connRef = null;   // Solana Connection

// Map of SPL mint → token info (built once from DB token cache)
let tokenByMint = {};  // splMint → { symbol, decimals }

function buildTokenIndex() {
  tokenByMint = {};
  for (const [sym, info] of Object.entries(KNOWN_TOKENS)) {
    tokenByMint[info.mint] = info;
  }
}

buildTokenIndex();

/**
 * Notify a user via Telegram bot
 */
async function notifyUser(userId, message) {
  if (!botRef) return;
  try {
    await botRef.telegram.sendMessage(userId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error(`[monitor] notify user ${userId} failed:`, e.message);
  }
}

/**
 * Poll all watched Solana custodial addresses for incoming transfers.
 * Uses concurrency limiter to avoid hammering the RPC endpoint.
 */
const SOL_POLL_CONCURRENCY = 5;

async function pollSolana() {
  const allUserRows = _getDb()?.prepare('SELECT * FROM users')?.all() || [];

  // Process users in batches of SOL_POLL_CONCURRENCY
  for (let i = 0; i < allUserRows.length; i += SOL_POLL_CONCURRENCY) {
    const batch = allUserRows.slice(i, i + SOL_POLL_CONCURRENCY);
    await Promise.allSettled(batch.map(user => pollSolanaUser(user)));
  }
}

async function pollSolanaUser(user) {
    const sol_addr = user.sol_address;
    const lastSlot = solSlotMap.get(sol_addr) || 0;

    try {
      // Check SPL tokens
      const splTransfers = await scanIncomingSpl(connRef, sol_addr, lastSlot);
      for (const t of splTransfers) {
        const tokenInfo = tokenByMint[t.mint];
        if (!tokenInfo) continue;  // Ignore unregistered tokens

        // Check for duplicate
        const { isNew } = store.recordDeposit({
          chain: 'solana', userId: user.user_id, address: sol_addr,
          token: tokenInfo.symbol, splMint: t.mint,
          amountUnits: t.amountUnits, txSig: t.sig, slotOrHeight: t.slot,
        });
        if (!isNew) continue;

        console.log(`[monitor] SOL incoming: ${t.amountUnits} ${tokenInfo.symbol} → ${sol_addr} (user ${user.user_id})`);

        // Create a transfer record
        const dbTransfer = store.createTransfer({
          userId: user.user_id, direction: 'sol_to_dcc',
          token: tokenInfo.symbol, splMint: t.mint,
          amountUnits: t.amountUnits, decimals: tokenInfo.decimals,
          srcAddress: sol_addr, dstAddress: user.dcc_address,
        });

        const transferId = createHash('sha256').update(t.sig).digest('hex');

        await notifyUser(user.user_id,
          `📥 *Deposit detected on Solana!*\n\n` +
          `Token: ${escMd(tokenInfo.symbol)}\n` +
          `Amount: ${(t.amountUnits / 10 ** tokenInfo.decimals).toFixed(tokenInfo.decimals)}\n` +
          `From: \`${escMd(t.fromAddress.slice(0,8))}...\`\n\n` +
          `Processing bridge relay...`
        );

        relaySolToDcc({
          transferId,
          dccRecipient: user.dcc_address,
          amountUnits: t.amountUnits,
          splMint: t.mint,
          solSlot: t.slot,
          dbTransferId: dbTransfer.id,
          onNotify: (msg) => notifyUser(user.user_id, msg),
        }).catch(e => console.error('[monitor] relay error:', e.message));

        solSlotMap.set(sol_addr, t.slot);
        store.setScanCursor('solana', sol_addr, t.slot);
      }

      // Check native SOL
      const solTransfers = await scanIncomingSol(connRef, sol_addr, lastSlot);
      for (const t of solTransfers) {
        if (t.amountLamports < 5_000_000) continue; // ignore dust (<0.005 SOL)

        const { isNew } = store.recordDeposit({
          chain: 'solana', userId: user.user_id, address: sol_addr,
          token: 'SOL', splMint: NATIVE_SOL_MINT,
          amountUnits: t.amountLamports, txSig: t.sig, slotOrHeight: t.slot,
        });
        if (!isNew) continue;

        console.log(`[monitor] SOL incoming: ${t.amountLamports} lamports → ${sol_addr} (user ${user.user_id})`);

        const dbTransfer = store.createTransfer({
          userId: user.user_id, direction: 'sol_to_dcc',
          token: 'SOL', splMint: NATIVE_SOL_MINT,
          amountUnits: t.amountLamports, decimals: 9,
          srcAddress: sol_addr, dstAddress: user.dcc_address,
        });

        const transferId = createHash('sha256').update(t.sig).digest('hex');

        await notifyUser(user.user_id,
          `📥 *SOL deposit detected!*\n\n` +
          `Amount: ${(t.amountLamports / 1e9).toFixed(6)} SOL\n` +
          `Processing bridge relay...`
        );

        relaySolToDcc({
          transferId,
          dccRecipient: user.dcc_address,
          amountUnits: t.amountLamports,
          splMint: NATIVE_SOL_MINT,
          solSlot: t.slot,
          dbTransferId: dbTransfer.id,
          onNotify: (msg) => notifyUser(user.user_id, msg),
        }).catch(e => console.error('[monitor] relay error:', e.message));

        if (t.slot > (solSlotMap.get(sol_addr) || 0)) {
          solSlotMap.set(sol_addr, t.slot);
          store.setScanCursor('solana', sol_addr, t.slot);
        }
      }
    } catch (e) {
      // Don't crash the entire poll loop for one user
      if (!e.message?.includes('timeout')) {
        console.error(`[monitor] Solana poll error for ${sol_addr}:`, e.message);
      }
    }
}

/**
 * Poll DCC bridge for burnToken events on custodial DCC wallets.
 */
async function pollDcc() {
  const allUserRows = _getDb()?.prepare('SELECT * FROM users')?.all() || [];

  // Build lookup map: dcc_address → user  (O(1) per burn instead of O(n))
  const userByDcc = new Map();
  for (const u of allUserRows) {
    if (u.dcc_address) userByDcc.set(u.dcc_address, u);
  }

  const minHeight = Math.min(...([...dccHeightMap.values(), 0]));
  const burns = await scanBurnRecords(config.dccNodeUrl, config.dccBridgeContract, minHeight);

  for (const burn of burns) {
    // Find which user this burn belongs to
    const user = userByDcc.get(burn.sender);
    if (!user) continue;

    const lastH = dccHeightMap.get(burn.sender) || 0;
    if (burn.height <= lastH) continue;

    const { isNew } = store.recordDeposit({
      chain: 'dcc', userId: user.user_id, address: burn.sender,
      token: burn.splMint || 'UNKNOWN', splMint: burn.splMint,
      amountUnits: burn.amountUnits, txSig: burn.dccTxId, slotOrHeight: burn.height,
    });
    if (!isNew) continue;

    console.log(`[monitor] DCC burn: ${burn.amountUnits} units from ${burn.sender} → SOL ${burn.solRecipient}`);

    const dbTransfer = store.createTransfer({
      userId: user.user_id, direction: 'dcc_to_sol',
      token: burn.splMint || 'UNKNOWN', splMint: burn.splMint,
      amountUnits: burn.amountUnits, decimals: 6,
      srcAddress: burn.sender, dstAddress: burn.solRecipient || '',
    });

    await notifyUser(user.user_id,
      `📤 *Burn detected on DCC!*\n\n` +
      `Amount: ${escMd(String(burn.amountUnits))} units\n` +
      `SOL recipient: \`${escMd((burn.solRecipient || '').slice(0,8))}...\`\n\n` +
      `Processing unlock on Solana...`
    );

    relayDccToSol({
      burnTxId: burn.dccTxId,
      solRecipient: burn.solRecipient || '',
      amountUnits: burn.amountUnits,
      splMint: burn.splMint,
      dccSender: burn.sender,
      dbTransferId: dbTransfer.id,
      onNotify: (msg) => notifyUser(user.user_id, msg),
    }).catch(e => console.error('[monitor] DCC relay error:', e.message));

    dccHeightMap.set(burn.sender, burn.height);
    store.setScanCursor('dcc', burn.sender, burn.height);
  }
}

// ── Internal DB accessor ───────────────────────────────────────
let _dbInstance = null;
function _getDb() {
  if (_dbInstance) return _dbInstance;
  try {
    const Database = require('better-sqlite3');
    const path     = require('path');
    _dbInstance    = new Database(config.dbPath, { readonly: true });
    return _dbInstance;
  } catch {
    return null;
  }
}

// ── Start / Stop ──────────────────────────────────────────────
let solTimer = null;
let dccTimer = null;

function start(bot) {
  botRef  = bot;
  connRef = makeConnection(config.solRpcUrl);
  _dbInstance = null; // reset so it's re-opened read-only

  // Load persisted scan cursors from SQLite
  loadCursors();

  console.log('[monitor] Starting bridge monitors...');
  console.log(`  Solana poll: every ${config.solPollIntervalMs}ms`);
  console.log(`  DCC poll:    every ${config.dccPollIntervalMs}ms`);

  // First poll after 5 seconds, then repeat
  setTimeout(async () => {
    await pollSolana().catch(e => console.error('[monitor] pollSolana error:', e.message));
    solTimer = setInterval(
      () => pollSolana().catch(e => console.error('[monitor] pollSolana error:', e.message)),
      config.solPollIntervalMs
    );
  }, 5000);

  setTimeout(async () => {
    await pollDcc().catch(e => console.error('[monitor] pollDcc error:', e.message));
    dccTimer = setInterval(
      () => pollDcc().catch(e => console.error('[monitor] pollDcc error:', e.message)),
      config.dccPollIntervalMs
    );
  }, 7000);
}

function stop() {
  if (solTimer) clearInterval(solTimer);
  if (dccTimer) clearInterval(dccTimer);
  console.log('[monitor] Stopped.');
}

module.exports = { start, stop };
