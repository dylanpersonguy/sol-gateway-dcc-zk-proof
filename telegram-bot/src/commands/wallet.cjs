'use strict';
/**
 * /wallet  — Custodial wallet addresses
 * /balance — Live balances on both chains
 */
const { Markup }      = require('telegraf');
const store           = require('../store.cjs');
const config          = require('../config.cjs');
const { makeConnection, getAllBalances } = require('../chains/solana.cjs');
const { getDccBalance, getAssetBalance, getBridgeTokenList } = require('../chains/dcc.cjs');
const { deriveSolanaWallet, deriveDccWallet } = require('../wallet.cjs');

function ensureUser(ctx) {
  const userId = ctx.from.id;
  let user = store.getUser(userId);
  if (!user) {
    const solWallet = deriveSolanaWallet(config.masterSecret, userId);
    const dccWallet = deriveDccWallet(config.masterSecret, userId, config.dccChainIdChar);
    user = store.upsertUser({
      userId, username: ctx.from.username, firstName: ctx.from.first_name,
      solAddress: solWallet.address, dccAddress: dccWallet.address,
    });
  }
  return user;
}

async function handleWallet(ctx) {
  const user = ensureUser(ctx);
  const msg =
    `💼 *Your Wallets*\n\n` +
    `*Solana*  \u00b7  devnet\n` +
    `\`${user.sol_address}\`\n\n` +
    `*DecentralChain*  \u00b7  mainnet\n` +
    `\`${user.dcc_address}\`\n\n` +
    `To bridge *SOL \u2192 DCC*, send tokens to your Solana address above.\n` +
    `For *DCC \u2192 SOL*, tap Bridge.`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [
      Markup.button.url('Solana \u2197', `https://explorer.solana.com/address/${user.sol_address}?cluster=devnet`),
      Markup.button.url('DCC \u2197', `https://decentralscan.com/address/${user.dcc_address}`),
    ],
    [Markup.button.callback('🌉 Bridge Now', 'do:bridge')],
  ]));
}

async function handleBalance(ctx) {
  const user = ensureUser(ctx);
  const loadMsg = await ctx.reply('Fetching balances\u2026');

  let solLines = '';
  let dccLines = '';

  try {
    const conn    = makeConnection(config.solRpcUrl);
    const bals    = await getAllBalances(conn, user.sol_address);
    const nonZero = bals.filter(b => b.units > 0);
    solLines = nonZero.length
      ? nonZero.map(b => `  ${b.symbol.padEnd(8)}  *${b.balance.toFixed(b.decimals > 4 ? 4 : b.decimals)}*`).join('\n')
      : '  _empty_';
  } catch (e) {
    solLines = `  _${e.message.slice(0, 60)}_`;
  }

  try {
    const bridgeDcc = await getDccBalance(config.dccNodeUrl, user.dcc_address);
    const tokenList = await getBridgeTokenList(config.dccNodeUrl, config.dccBridgeContract);
    const assetBals = await Promise.all(
      tokenList.filter(t => t.enabled).map(async t => {
        const bal = await getAssetBalance(config.dccNodeUrl, user.dcc_address, t.dccAssetId);
        return { symbol: t.symbol, balance: bal, decimals: t.dccDecimals };
      })
    );
    const gasLine  = `  ${'DCC'.padEnd(8)}  *${(bridgeDcc / 1e8).toFixed(4)}*`;
    const nonZero  = assetBals.filter(b => b.balance > 0);
    const tokLines = nonZero.map(b =>
      `  ${b.symbol.padEnd(8)}  *${(b.balance / 10 ** b.decimals).toFixed(b.decimals > 4 ? 4 : b.decimals)}*`
    ).join('\n');
    dccLines = gasLine + (nonZero.length ? '\n' + tokLines : '\n  _no bridge tokens yet_');
  } catch (e) {
    dccLines = `  _${e.message.slice(0, 60)}_`;
  }

  const msg =
    `\u2696\ufe0f *Balances*\n\n` +
    `*Solana*  \u00b7  devnet\n${solLines}\n\n` +
    `*DecentralChain*  \u00b7  mainnet\n${dccLines}`;

  await ctx.telegram.editMessageText(
    ctx.chat.id, loadMsg.message_id, null, msg,
    { parse_mode: 'Markdown' }
  );
}

function register(bot) {
  bot.command('wallet',  handleWallet);
  bot.command('balance', handleBalance);
  bot.hears('💼 Wallet',   handleWallet);
  bot.hears('\u2696\ufe0f Balances', handleBalance);
}

module.exports = { register, handleWallet, handleBalance };

