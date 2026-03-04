'use strict';
/**
 * bot.cjs — Main entry point for the Sol-Gateway DCC Telegram Bot
 *
 * Start with:  node src/bot.cjs
 * Dev mode:    node --watch src/bot.cjs
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Telegraf, Scenes, session } = require('telegraf');
const config = require('./config.cjs');
const store  = require('./store.cjs');
const { rateLimiter } = require('./middleware/rateLimiter.cjs');

// ── Bridge wizard scene ────────────────────────────────────────
const { createBridgeWizard } = require('./scenes/bridge-wizard.cjs');

// ── Command handlers ───────────────────────────────────────────
const startCmd   = require('./commands/start.cjs');
const walletCmd  = require('./commands/wallet.cjs');
const statusCmd  = require('./commands/status.cjs');
const tokensCmd  = require('./commands/tokens.cjs');

// ── Monitor ────────────────────────────────────────────────────
const monitor = require('./bridge/monitor.cjs');

// ── Initialise DB ──────────────────────────────────────────────
store.init(config.dbPath);
console.log(`[bot] DB initialised at ${config.dbPath}`);

// ── Create bot ─────────────────────────────────────────────────
const bot = new Telegraf(config.botToken);

// ── Session middleware (required for scenes) ───────────────────
bot.use(session());
// ── Rate limiter ──────────────────────────────────────────────
bot.use(rateLimiter({ windowMs: 10_000, maxRequests: 8 }));
// ── Scene / Stage ──────────────────────────────────────────────
const bridgeWizard = createBridgeWizard();
const stage = new Scenes.Stage([bridgeWizard]);
bot.use(stage.middleware());

// ── Global error handler ───────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[bot] Error for ${ctx.updateType}:`, err);
  try {
    // Use plain text for error messages to prevent Markdown injection
    // from untrusted error strings (RPC errors, network errors, etc.)
    ctx.reply('❌ An internal error occurred. Please try again or send /start to reset.');
  } catch {}
});

// ── Register commands ──────────────────────────────────────────
startCmd.register(bot);
walletCmd.register(bot);
statusCmd.register(bot);
tokensCmd.register(bot);

// Bridge wizard (also handles /bridge + "🌉 Bridge" hear)
const { register: registerBridge } = require('./scenes/bridge-wizard.cjs');
registerBridge(bot);

// ── Hears wiring — main keyboard buttons ──────────────────────
// 🌉 Bridge  is handled by bridge-wizard.cjs register()
bot.hears('⚖️ Balances', (ctx) => !ctx.scene?.current && walletCmd.handleBalance(ctx));
bot.hears('💼 Wallet',    (ctx) => !ctx.scene?.current && walletCmd.handleWallet(ctx));
bot.hears('📋 History',   (ctx) => !ctx.scene?.current && statusCmd.handleHistory(ctx));
bot.hears('ℹ️ Help',      (ctx) => !ctx.scene?.current && startCmd.handleHelp(ctx));

// ── /cancel anywhere ───────────────────────────────────────────
bot.command('cancel', async (ctx) => {
  try { await ctx.scene.leave(); } catch {}
  await ctx.reply('Cancelled. Send /start to go back to the main menu.');
});

// ── Start background monitor ───────────────────────────────────
monitor.start(bot);
console.log('[bot] Bridge monitor started.');

// ── Launch ─────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('[bot] Telegram bot is running ✅');
}).catch((err) => {
  console.error('[bot] Failed to launch:', err);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────
process.once('SIGINT',  () => {
  monitor.stop();
  bot.stop('SIGINT');
  console.log('[bot] Stopped (SIGINT)');
});
process.once('SIGTERM', () => {
  monitor.stop();
  bot.stop('SIGTERM');
  console.log('[bot] Stopped (SIGTERM)');
});
