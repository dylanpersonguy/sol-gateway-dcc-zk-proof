'use strict';
/**
 * /start — Welcome + user registration
 * /help  — Usage guide
 */
const { Markup } = require('telegraf');
const store      = require('../store.cjs');
const config     = require('../config.cjs');
const { deriveSolanaWallet, deriveDccWallet } = require('../wallet.cjs');

// ── Persistent reply keyboard (shown below chat input) ────────────
const MAIN_KEYBOARD = Markup.keyboard([
  ['🌉 Bridge'],
  ['⚖️ Balances', '💼 Wallet'],
  ['📋 History',  'ℹ️ Help'],
]).resize();

const HELP_TEXT = [
  '*SOL \u2194 DCC Bridge*',
  '',
  'Move assets between Solana and DecentralChain instantly.',
  '',
  '*Commands*',
  '/bridge    \u2014 Start a transfer',
  '/balance   \u2014 View your balances',
  '/wallet    \u2014 Your deposit addresses',
  '/history   \u2014 Recent transfers',
  '/tokens    \u2014 Supported assets',
  '/help      \u2014 This guide',
  '',
  '*How it works*',
  '1. Tap Bridge and choose your direction',
  '2. Send tokens to the shown deposit address',
  '3. The bot detects the deposit and relays it automatically',
  '4. Tokens arrive on the destination chain within minutes',
  '',
  '_Note: custodial relay bot. Wallets are derived from your Telegram ID. Use amounts you are comfortable with during testing._',
].join('\n');

async function handleHelp(ctx) {
  await ctx.replyWithMarkdown(HELP_TEXT, Markup.inlineKeyboard([
    [Markup.button.callback('Bridge Now', 'do:bridge')],
  ]));
}

function register(bot) {
  bot.start(async (ctx) => {
    const userId    = ctx.from.id;
    const firstName = ctx.from.first_name || 'there';

    let user = store.getUser(userId);
    if (!user) {
      const solWallet = deriveSolanaWallet(config.masterSecret, userId);
      const dccWallet = deriveDccWallet(config.masterSecret, userId, config.dccChainIdChar);
      user = store.upsertUser({
        userId,
        username:   ctx.from.username,
        firstName,
        solAddress: solWallet.address,
        dccAddress: dccWallet.address,
      });
      console.log(`[start] registered user=${userId} sol=${solWallet.address}`);
    } else {
      store.upsertUser({
        userId, username: ctx.from.username, firstName,
        solAddress: user.sol_address, dccAddress: user.dcc_address,
      });
    }

    // Register commands in the Telegram /  menu
    try {
      await ctx.telegram.setMyCommands([
        { command: 'bridge',  description: 'Start a bridge transfer' },
        { command: 'balance', description: 'View your balances' },
        { command: 'wallet',  description: 'Your deposit addresses' },
        { command: 'history', description: 'Recent transfers' },
        { command: 'tokens',  description: 'Supported assets' },
        { command: 'help',    description: 'Help & guide' },
      ]);
    } catch {}

    await ctx.replyWithMarkdown(
      `*SOL \u2194 DCC Bridge*\n\nWelcome, ${firstName}.\nYour bridge wallets are ready \u2014 use the menu below.`,
      MAIN_KEYBOARD
    );
  });

  bot.help(handleHelp);
  bot.hears('ℹ️ Help', handleHelp);

  // inline action shortcut from other menus
  bot.action('do:bridge', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.scene.enter('bridge_wizard');
  });
}

module.exports = { register, handleHelp, MAIN_KEYBOARD };
