'use strict';
/**
 * /tokens — Supported assets on the bridge
 */
const { getBridgeTokenList } = require('../chains/dcc.cjs');
const config = require('../config.cjs');

async function handleTokens(ctx) {
  const loadMsg = await ctx.reply('Loading assets…');

  try {
    const tokens  = await getBridgeTokenList(config.dccNodeUrl, config.dccBridgeContract);
    const enabled = tokens.filter(t => t.enabled);

    const lines = enabled.map(t => {
      const mintShort = `${t.splMint.slice(0,4)}…${t.splMint.slice(-4)}`;
      const dec = t.solDecimals === t.dccDecimals
        ? `${t.solDecimals} dec`
        : `${t.solDecimals}→${t.dccDecimals} dec`;
      return `*${t.symbol}*  \u00b7  ${mintShort}  \u00b7  ${dec}`;
    });

    const msg =
      `*Supported Assets*  \u00b7  ${enabled.length} tokens\n\n` +
      lines.join('\n') +
      `\n\n_Bridge contract:_\n\`${config.dccBridgeContract}\``;

    await ctx.telegram.editMessageText(
      ctx.chat.id, loadMsg.message_id, null, msg,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, loadMsg.message_id, null,
      `Unable to load tokens: ${e.message}`,
      {}
    );
  }
}

function register(bot) {
  bot.command('tokens', handleTokens);
}

module.exports = { register, handleTokens };
