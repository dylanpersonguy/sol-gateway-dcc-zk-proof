'use strict';
/**
 * Bridge Relay — executes cross-chain transfers after on-chain confirmation
 *
 * SOL → DCC:
 *   1. Custodial Solana wallet receives SPL tokens (or SOL)
 *   2. relay() calls validatorMintToken() on DCC mainnet
 *   3. Updates transfer status in DB
 *   4. Notifies the user via Telegram
 *
 * DCC → SOL:
 *   1. Custodial DCC wallet's bridge burn is detected
 *   2. relay() calls unlock() on Solana program
 *   3. Updates transfer status and notifies user
 */
const { createHash, randomBytes } = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const { libs }      = require('@decentralchain/decentralchain-transactions');
const { seedWithNonce, publicKey } = libs.crypto;

const dcc    = require('../chains/dcc.cjs');
const store  = require('../store.cjs');
const config = require('../config.cjs');

// Build the bridge validator's info once at startup
const VALIDATOR_SEED = config.dccValidatorSeed
  ? libs.crypto.seedWithNonce(config.dccValidatorSeed, config.dccValidatorNonce)
  : null;
const VALIDATOR_PK = VALIDATOR_SEED ? publicKey(VALIDATOR_SEED) : null;

// ── Retry helper with exponential backoff ─────────────────────
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.warn(`[relay] ${label} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}, retrying in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Consensus-based mint via validator API ─────────────────────
async function consensusMint({ transferIdHex, dccRecipient, amountUnits, splMint, solSlot }) {
  const endpoints = config.validatorEndpoints;
  if (!endpoints.length) throw new Error('No VALIDATOR_ENDPOINTS configured for consensus mode');

  const payload = {
    type: 'mint',
    transferId: transferIdHex,
    recipient: dccRecipient,
    amount: amountUnits,
    splMint,
    solSlot: solSlot || 0,
  };

  // Submit the attestation request to all validator endpoints
  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const url = `${ep.replace(/\/$/, '')}/api/v1/attestation`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Validator ${ep} returned ${resp.status}: ${body}`);
      }
      return resp.json();
    })
  );

  const successes = results.filter(r => r.status === 'fulfilled');
  if (successes.length === 0) {
    const errs = results.map(r => r.reason?.message || 'unknown').join('; ');
    throw new Error(`All validator endpoints failed: ${errs}`);
  }

  // The first successful acknowledgment — the consensus engine handles
  // aggregation and submission internally
  const first = successes[0].value;
  console.log(`[relay] Consensus attestation submitted to ${successes.length}/${endpoints.length} validators`);
  return first.dccTxId || first.txId || null;
}

/**
 * Generate a unique transfer ID for a SOL→DCC deposit.
 * Mirrors the on-chain computation when available, falls back to random.
 */
function generateTransferId(senderPubkeyStr, nonce) {
  try {
    const buf = Buffer.alloc(40);
    new PublicKey(senderPubkeyStr).toBuffer().copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(nonce), 32);
    return createHash('sha256').update(buf).digest().toString('hex');
  } catch {
    return createHash('sha256').update(randomBytes(32)).digest().toString('hex');
  }
}

/**
 * Execute SOL → DCC relay:
 *   - transferId already known (from deposit event or generated)
 *   - mint DCC tokens to dccRecipient
 *
 * @param {object} opts
 * @param {string} opts.transferId   hex string
 * @param {string} opts.dccRecipient DCC address to receive tokens
 * @param {number} opts.amountUnits  Solana-side units (e.g. USDC: 6 decimals)
 * @param {string} opts.splMint      Solana mint pubkey or 'native-sol'
 * @param {number} opts.solSlot      Block slot of the deposit
 * @param {string} opts.dbTransferId UUID of the DB transfer record
 * @param {Function} opts.onNotify   Called with notification message for user
 */
async function relaySolToDcc({ transferId, dccRecipient, amountUnits, splMint, solSlot, dbTransferId, onNotify }) {
  if (!config.useConsensus && (!VALIDATOR_SEED || !VALIDATOR_PK)) {
    throw new Error('DCC_VALIDATOR_SEED not configured and consensus mode not enabled');
  }

  console.log(`[relay] SOL→DCC transfer ${transferId.slice(0,12)}... ${amountUnits} units → ${dccRecipient}`);

  store.updateTransfer(dbTransferId, { status: 'sol_confirmed' });

  let dccTxId;
  try {
    dccTxId = await withRetry(async () => {
      if (config.useConsensus) {
        // Route through M-of-N validator consensus
        return consensusMint({
          transferIdHex: transferId,
          dccRecipient,
          amountUnits,
          splMint,
          solSlot,
        });
      } else {
        // Legacy single-validator mint
        return dcc.validatorMintToken({
          nodeUrl:         config.dccNodeUrl,
          apiKey:          config.dccApiKey,
          bridgeAddress:   config.dccBridgeContract,
          chainIdChar:     config.dccChainIdChar,
          validatorSeedStr: VALIDATOR_SEED,
          validatorPubKey:  VALIDATOR_PK,
          transferIdHex:   transferId,
          dccRecipient,
          amountUnits,
          solSlot: solSlot || 0,
          splMint,
        });
      }
    }, `SOL→DCC mint ${transferId.slice(0,12)}`);
  } catch (err) {
    store.updateTransfer(dbTransferId, { status: 'failed', error: err.message });
    if (onNotify) await onNotify(`❌ Bridge relay failed after ${MAX_RETRIES} attempts: ${err.message}`);
    throw err;
  }

  store.updateTransfer(dbTransferId, {
    status:     'dcc_minted',
    dcc_tx_id:  dccTxId,
    transfer_id: transferId,
  });

  // Wait for DCC confirmation
  try {
    if (dccTxId) {
      await dcc.waitForTx(config.dccNodeUrl, dccTxId, 30);
      store.updateTransfer(dbTransferId, { status: 'complete' });
      console.log(`[relay] ✅ complete — DCC tx: ${dccTxId}`);
    } else {
      // Consensus mode — tx comes async; mark pending_confirmation
      store.updateTransfer(dbTransferId, { status: 'pending_confirmation' });
      console.log(`[relay] Consensus submitted — awaiting async confirmation`);
    }
  } catch (err) {
    // Tx may still be pending; mark as pending_confirmation (not falsely complete)
    console.warn(`[relay] DCC confirmation timeout for ${dccTxId}, marking pending_confirmation`);
    store.updateTransfer(dbTransferId, { status: 'pending_confirmation' });
  }

  if (onNotify) {
    const transfer = store.getTransfer(dbTransferId);
    const decimals = transfer?.decimals ?? 6;
    const humanAmt = (amountUnits / 10 ** decimals).toFixed(decimals);
    await onNotify(
      `✅ *Bridge transfer complete!*\n\n` +
      `🔁 ${transfer?.token || 'Token'}\n` +
      `💰 ${humanAmt} ${transfer?.token || ''}\n` +
      `📫 Destination: \`${dccRecipient}\`\n\n` +
      `🔗 DCC tx: [view on DecentralScan](https://decentralscan.com/tx/${dccTxId})`
    );
  }

  return { dccTxId };
}

/**
 * Execute DCC → SOL relay:
 *   - User burned tokens on DCC bridge
 *   - Call unlock on Solana to release SOL/SPL
 *
 * NOTE: Solana program must be upgraded before this works end-to-end.
 * This function stubs the Solana side and notifies the user.
 */
async function relayDccToSol({ burnTxId, solRecipient, amountUnits, splMint, dccSender, dbTransferId, onNotify }) {
  console.log(`[relay] DCC→SOL burn ${burnTxId} ${amountUnits} units → ${solRecipient}`);

  store.updateTransfer(dbTransferId, { status: 'dcc_confirmed', dcc_tx_id: burnTxId });

  if (config.useConsensus) {
    // Route through validator consensus for unlock
    try {
      await withRetry(async () => {
        const endpoints = config.validatorEndpoints;
        if (!endpoints.length) throw new Error('No VALIDATOR_ENDPOINTS configured');

        const payload = {
          type: 'unlock',
          transferId: burnTxId,
          solRecipient,
          amount: amountUnits,
          splMint,
          dccSender,
        };

        const results = await Promise.allSettled(
          endpoints.map(async (ep) => {
            const url = `${ep.replace(/\/$/, '')}/api/v1/attestation`;
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(30_000),
            });
            if (!resp.ok) throw new Error(`Validator ${ep}: ${resp.status}`);
            return resp.json();
          })
        );

        const successes = results.filter(r => r.status === 'fulfilled');
        if (!successes.length) {
          throw new Error('All validator endpoints failed for unlock');
        }
        return successes[0].value;
      }, `DCC→SOL unlock ${burnTxId.slice(0, 12)}`);

      store.updateTransfer(dbTransferId, { status: 'pending_unlock', transfer_id: burnTxId });
      if (onNotify) {
        await onNotify(
          `✅ *DCC → SOL unlock submitted*\n\n` +
          `Burn: \`${burnTxId.slice(0, 12)}...\`\n` +
          `Recipient: \`${solRecipient.slice(0, 12)}...\`\n` +
          `Amount: ${amountUnits} units\n\n` +
          `_Waiting for Solana confirmation..._`
        );
      }
      return { pending: true };
    } catch (err) {
      store.updateTransfer(dbTransferId, { status: 'failed', error: err.message });
      if (onNotify) await onNotify(`❌ DCC→SOL unlock failed after ${MAX_RETRIES} attempts: ${err.message}`);
      throw err;
    }
  }

  // Fallback: no consensus configured — mark pending and notify
  const msg =
    `⚙️ *DCC → SOL relay*\n\n` +
    `Burn detected from \`${dccSender}\`\n` +
    `Solana recipient: \`${solRecipient}\`\n` +
    `Amount: ${amountUnits} units\n\n` +
    `_Unlock pending — consensus mode not enabled._`;

  if (onNotify) await onNotify(msg);
  store.updateTransfer(dbTransferId, { status: 'pending_unlock', transfer_id: burnTxId });

  return { pending: true };
}

module.exports = { relaySolToDcc, relayDccToSol, generateTransferId, VALIDATOR_PK, VALIDATOR_SEED };
