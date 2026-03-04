'use strict';
/**
 * Bridge Wizard Scene — multi-step Telegraf Wizard for initiating transfers
 *
 * Steps:
 *   0. Choose direction: SOL→DCC  |  DCC→SOL
 *   1. Choose token (from registered list)
 *   2. Enter amount
 *   3. Enter destination address (or use custodial default)
 *   4. Confirm → execute
 */
const { Scenes, Markup } = require('telegraf');
const { getBridgeTokenList }  = require('../chains/dcc.cjs');
const { makeConnection, getSplBalance, getSolBalance, KNOWN_TOKENS } = require('../chains/solana.cjs');
const { relaySolToDcc, relayDccToSol, generateTransferId } = require('../bridge/relay.cjs');
const store   = require('../store.cjs');
const config  = require('../config.cjs');
const { deriveSolanaWallet, deriveDccWallet } = require('../wallet.cjs');

const SCENE_ID = 'bridge_wizard';

// ── Helper: ensure user exists ────────────────────────────────
function ensureUser(ctx) {
  const userId = ctx.from.id;
  let user = store.getUser(userId);
  if (!user) {
    const solW = deriveSolanaWallet(config.masterSecret, userId);
    const dccW = deriveDccWallet(config.masterSecret, userId, config.dccChainIdChar);
    user = store.upsertUser({
      userId, username: ctx.from.username, firstName: ctx.from.first_name,
      solAddress: solW.address, dccAddress: dccW.address,
    });
  }
  return user;
}

// ── Token list cache (refreshed in wizard) ────────────────────
let _cachedTokens = null;
let _cacheTime = 0;

async function getTokens() {
  if (_cachedTokens && Date.now() - _cacheTime < 300_000) return _cachedTokens;  // 5 min cache
  _cachedTokens = await getBridgeTokenList(config.dccNodeUrl, config.dccBridgeContract);
  _cacheTime = Date.now();
  return _cachedTokens;
}

// ── Step 0: Choose direction ───────────────────────────────────
async function stepDirection(ctx) {
  ctx.wizard.state.data = {};
  await ctx.replyWithMarkdown(
    `🌉 *Bridge Transfer*\n\nWhich direction do you want to bridge?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔵 Solana → DCC', 'dir:sol_to_dcc')],
      [Markup.button.callback('🟣 DCC → Solana', 'dir:dcc_to_sol')],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ])
  );
}

// ── Step 1: Choose token ──────────────────────────────────────
async function stepToken(ctx, direction) {
  ctx.wizard.state.data.direction = direction;
  
  let tokens;
  try {
    tokens = await getTokens();
  } catch (e) {
    return ctx.replyWithMarkdown(`❌ Failed to load tokens: ${e.message}`);
  }

  const enabled = tokens.filter(t => t.enabled);
  if (!enabled.length) {
    return ctx.replyWithMarkdown('❌ No tokens registered on the bridge yet.');
  }

  // Show groups: native SOL first, then stablecoins, then others
  const rows = [];
  const sol  = enabled.find(t => t.symbol === 'SOL' || t.splMint?.includes('11111111'));
  if (sol) rows.push([Markup.button.callback(`SOL — Native Solana`, `token:${sol.splMint}`)]);

  const stable = enabled.filter(t => ['USDC', 'USDT', 'PYUSD', 'DAI'].includes(t.symbol));
  for (const t of stable) {
    rows.push([Markup.button.callback(`${t.symbol} — ${t.decimals || t.solDecimals}⁻ dec`, `token:${t.splMint}`)]);
  }

  const other = enabled.filter(t => t.symbol !== 'SOL' && !['USDC', 'USDT', 'PYUSD', 'DAI'].includes(t.symbol));
  for (let i = 0; i < other.length; i += 2) {
    const pair = [Markup.button.callback(other[i].symbol, `token:${other[i].splMint}`)];
    if (other[i + 1]) pair.push(Markup.button.callback(other[i + 1].symbol, `token:${other[i + 1].splMint}`));
    rows.push(pair);
  }

  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);

  ctx.wizard.state.data.tokens = enabled;

  await ctx.replyWithMarkdown(
    `🪙 *Choose Token*\n\nSelect the token you want to bridge:`,
    Markup.inlineKeyboard(rows)
  );
  return ctx.wizard.next();
}

// ── Step 2: Enter amount ──────────────────────────────────────
async function stepAmount(ctx, splMint) {
  const tokens = ctx.wizard.state.data.tokens || [];
  const found  = tokens.find(t => t.splMint === splMint);
  ctx.wizard.state.data.splMint    = splMint;
  ctx.wizard.state.data.tokenInfo  = found;
  ctx.wizard.state.data.tokenSymbol = found?.symbol || 'TOKEN';

  const direction = ctx.wizard.state.data.direction;
  const user      = ensureUser(ctx);

  // Show current balance as context
  let balanceHint = '';
  try {
    if (direction === 'sol_to_dcc') {
      const conn = makeConnection(config.solRpcUrl);
      if (splMint === 'So11111111111111111111111111111111111111112') {
        const lamports = await getSolBalance(conn, user.sol_address);
        balanceHint = `\n_Your SOL balance: ${(lamports / 1e9).toFixed(4)} SOL_`;
      } else {
        const units = await getSplBalance(conn, splMint, user.sol_address);
        const dec = found?.solDecimals ?? 6;
        balanceHint = `\n_Your balance: ${(Number(units) / 10 ** dec).toFixed(4)} ${found?.symbol || ''}_`;
      }
    }
  } catch {}

  await ctx.replyWithMarkdown(
    `💵 *Enter Amount*\n\n` +
    `Token: *${ctx.wizard.state.data.tokenSymbol}*${balanceHint}\n\n` +
    `How much do you want to bridge?\n` +
    `_(e.g. \`1\`, \`0.5\`, \`100\`)_`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel')]])
  );
  return ctx.wizard.next();
}

// ── Step 3: Enter destination ────────────────────────────────
// DCC mainnet addresses: start with '3D', 26-36 chars, base58 alphabet (no 0/O/I/l)
const DCC_ADDR_RE = /^3D[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{24,34}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // Solana base58 pubkey

function validateDestination(direction, addr) {
  if (!addr || addr.length < 10) return 'Address is too short.';
  if (direction === 'sol_to_dcc' && !DCC_ADDR_RE.test(addr))
    return 'That does not look like a valid DCC mainnet address (should start with 3D, 26–36 chars).';
  if (direction === 'dcc_to_sol' && !SOL_ADDR_RE.test(addr))
    return 'That does not look like a valid Solana address (base58, 32–44 chars).';
  return null; // valid
}

async function stepDestination(ctx, amountStr) {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return ctx.replyWithMarkdown('❌ Invalid amount. Please enter a positive number:');
  }
  if (amount < config.minAmountUsdc) {
    return ctx.replyWithMarkdown(`❌ Minimum amount is ${config.minAmountUsdc}. Please try again:`);
  }
  if (amount > config.maxAmountUsdc) {
    return ctx.replyWithMarkdown(`❌ Maximum amount per transfer is ${config.maxAmountUsdc}. Please try again:`);
  }

  ctx.wizard.state.data.amount = amount;

  const direction = ctx.wizard.state.data.direction;
  const chainName  = direction === 'sol_to_dcc' ? 'DecentralChain (DCC)' : 'Solana';

  await ctx.replyWithMarkdown(
    `📫 *Destination Address*\n\n` +
    `Destination chain: *${chainName}*\n\n` +
    `Please send your ${chainName} destination address:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ])
  );
  return ctx.wizard.next();
}

// ── Step 4: Confirm ───────────────────────────────────────────
async function stepConfirm(ctx, destination) {
  ctx.wizard.state.data.destination = destination;

  const d     = ctx.wizard.state.data;
  const dec   = d.tokenInfo?.solDecimals ?? 6;
  const arrow = d.direction === 'sol_to_dcc' ? 'Solana → DCC' : 'DCC → Solana';
  const user  = ensureUser(ctx);
  const src   = d.direction === 'sol_to_dcc' ? user.sol_address : user.dcc_address;

  const msg =
    `📋 *Confirm Transfer*\n\n` +
    `Direction: *${arrow}*\n` +
    `Token: *${d.tokenSymbol}*\n` +
    `Amount: *${d.amount} ${d.tokenSymbol}*\n` +
    `From: \`${src.slice(0,12)}...\`\n` +
    `To: \`${destination.slice(0,12)}...\`\n\n` +
    `Ready to bridge?`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm & Bridge', 'confirm:yes')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]));
  return ctx.wizard.next();
}

// ── Step 5: Execute ───────────────────────────────────────────
async function stepExecute(ctx) {
  const d    = ctx.wizard.state.data;
  const user = ensureUser(ctx);
  const dec  = d.tokenInfo?.solDecimals ?? 6;
  const amountUnits = Math.floor(d.amount * 10 ** dec);

  const notifyMsg = await ctx.replyWithMarkdown('⏳ *Initiating bridge transfer...*');

  const dbTransfer = store.createTransfer({
    userId: ctx.from.id,
    direction: d.direction,
    token:    d.tokenSymbol,
    splMint:  d.splMint,
    amountUnits,
    decimals: dec,
    srcAddress: d.direction === 'sol_to_dcc' ? user.sol_address : user.dcc_address,
    dstAddress: d.destination,
  });

  await ctx.scene.leave();

  if (d.direction === 'sol_to_dcc') {
    // Custodial bridge model: user must deposit to their Solana custodial address.
    // The monitor detects on-chain deposits and calls the relay automatically.
    // We NEVER mint without a confirmed Solana-side deposit — doing so would
    // allow anyone to fabricate tokens without locking real assets.
    const dec    = d.tokenInfo?.solDecimals ?? 6;
    const isNativeSol = d.splMint === 'So11111111111111111111111111111111111111112';
    const depositNote = isNativeSol
      ? `Send *${d.amount} SOL* to your Solana address shown below.`
      : `Send *${d.amount} ${d.tokenSymbol}* to your Solana address shown below.`;

    await ctx.telegram.editMessageText(
      ctx.chat.id, notifyMsg.message_id, null,
      `✅ *Deposit Instructions*\n\n` +
      `${depositNote}\n\n` +
      `📥 *Your Solana deposit address:*\n` +
      `\`${user.sol_address}\`\n\n` +
      `Once your deposit is confirmed on Solana, the bot will automatically bridge it to:\n` +
      `📫 \`${d.destination}\`\n\n` +
      `_You will receive a notification when the DCC tokens arrive._`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

  } else {
    // DCC → SOL: give user the burn instructions
    const msg =
      `📋 *DCC → SOL Bridge Instructions*\n\n` +
      `To complete this transfer, call \`burnToken\` on the DCC bridge:\n\n` +
      `*Bridge contract:*\n\`${config.dccBridgeContract}\`\n\n` +
      `*Function:* \`burnToken(solRecipient, splMint)\`\n` +
      `*Payment:* ${d.amount} ${d.tokenSymbol} (the DCC asset)\n` +
      `*Sol recipient:* \`${d.destination}\`\n` +
      `*SPL Mint:* \`${d.splMint}\`\n\n` +
      `Once confirmed on DCC, the bot will automatically unlock your tokens on Solana.`;

    await ctx.telegram.editMessageText(
      ctx.chat.id, notifyMsg.message_id, null, msg,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  }
}

// ── Build the wizard scene ────────────────────────────────────
function createBridgeWizard() {
  const wizard = new Scenes.WizardScene(
    SCENE_ID,

    // Step 0: direction
    async (ctx) => {
      await stepDirection(ctx);
      // Don't advance yet — wait for callback
    },

    // Step 1: token (entered after direction callback)
    async (ctx) => {
      if (ctx.callbackQuery?.data?.startsWith('token:')) {
        await ctx.answerCbQuery();
        const mint = ctx.callbackQuery.data.replace('token:', '');
        return stepAmount(ctx, mint);
      }
      // Ignore unexpected input
    },

    // Step 2: amount text input
    async (ctx) => {
      if (ctx.message?.text) {
        return stepDestination(ctx, ctx.message.text.trim());
      }
      if (ctx.callbackQuery?.data === 'cancel') {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown('👋 Bridge cancelled.');
        return ctx.scene.leave();
      }
    },

    // Step 3: destination — text or callback
    async (ctx) => {
      if (ctx.message?.text) {
        const addr = ctx.message.text.trim();
        const direction = ctx.wizard.state.data.direction;
        const err = validateDestination(direction, addr);
        if (err) return ctx.replyWithMarkdown(`❌ ${err}\nPlease enter a valid address:`);
        return stepConfirm(ctx, addr);
      }
      if (ctx.callbackQuery?.data === 'cancel') {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown('👋 Bridge cancelled.');
        return ctx.scene.leave();
      }
    },

    // Step 4: confirm
    async (ctx) => {
      if (ctx.callbackQuery?.data === 'confirm:yes') {
        await ctx.answerCbQuery();
        return stepExecute(ctx);
      }
      if (ctx.callbackQuery?.data === 'cancel') {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown('👋 Bridge cancelled.');
        return ctx.scene.leave();
      }
    },
  );

  // ── Global action handlers inside wizard ───────────────────
  // Direction callback fires in step 0 → advance to step 1 (token chooser)
  wizard.action(/^dir:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const direction = ctx.match[1];
    await stepToken(ctx, direction);
  });

  wizard.action('cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown('👋 Bridge cancelled.');
    return ctx.scene.leave();
  });

  return wizard;
}

/**
 * Register the /bridge command with the stage
 */
function register(bot) {
  bot.command('bridge', (ctx) => ctx.scene.enter(SCENE_ID));
  bot.hears('🌉 Bridge', (ctx) => ctx.scene.enter(SCENE_ID));
}

module.exports = { createBridgeWizard, register, SCENE_ID };
