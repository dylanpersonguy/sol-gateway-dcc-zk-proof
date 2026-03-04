'use strict';
/**
 * /history — Transfer history
 */
const { Markup } = require('telegraf');
const store      = require('../store.cjs');

const STATUS_LABEL = {
  pending:         'Pending',
  sol_confirmed:   'Solana confirmed',
  dcc_confirmed:   'DCC confirmed',
  dcc_minted:      'Minted on DCC',
  pending_unlock:  'Awaiting unlock',
  complete:        'Complete',
  failed:          'Failed',
};

const STATUS_DOT = {
  pending:         '○',
  sol_confirmed:   '●',
  dcc_confirmed:   '●',
  dcc_minted:      '●',
  pending_unlock:  '●',
  complete:        '✔',
  failed:          '✕',
};

function formatTransfer(t, index) {
  const dot      = STATUS_DOT[t.status]  || '○';
  const label    = STATUS_LABEL[t.status] || t.status;
  const amt      = (Number(BigInt(t.amount_units)) / 10 ** t.decimals).toFixed(t.decimals > 4 ? 4 : t.decimals);
  const dir      = t.direction === 'sol_to_dcc' ? 'SOL \u2192 DCC' : 'DCC \u2192 SOL';
  const dateStr  = new Date(t.created_at * 1000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  let out = `${dot} *${dir}*  \u00b7  ${t.token}\n`;
  out    += `   ${amt} ${t.token}  \u00b7  ${label}\n`;
  out    += `   ${dateStr}`;

  if (t.dcc_tx_id)  out += `  \u00b7  [DCC \u2197](https://decentralscan.com/tx/${t.dcc_tx_id})`;
  if (t.sol_tx_sig) out += `  \u00b7  [SOL \u2197](https://explorer.solana.com/tx/${t.sol_tx_sig}?cluster=devnet)`;
  if (t.error)      out += `\n   _${t.error.slice(0, 80)}_`;

  return out;
}

async function handleHistory(ctx) {
  const transfers = store.getTransfersByUser(ctx.from.id, 8);

  if (!transfers.length) {
    return ctx.replyWithMarkdown(
      `📋 *No transfers yet*\n\n` +
      `Your transfer history will appear here once you use /bridge.`,
      Markup.inlineKeyboard([[Markup.button.callback('🌉 Bridge Now', 'do:bridge')]])
    );
  }

  const body = transfers.map(formatTransfer).join('\n\n');
  const msg  = `📋 *History*  \u00b7  last ${transfers.length}\n\n${body}`;

  await ctx.replyWithMarkdown(msg, { disable_web_page_preview: true });
}

function register(bot) {
  bot.command('status',  handleHistory);
  bot.command('history', handleHistory);
  bot.hears('📋 History', handleHistory);
}

module.exports = { register, handleHistory };
