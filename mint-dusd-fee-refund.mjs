/**
 * mint-dusd-fee-refund.mjs
 *
 * Refund script: deposit 5f803ad4... had 1,000,000 micro-USDC (1 USDC)
 * charged as the minimum fee floor instead of the correct 0.10% rate
 * (which would have been 2,000 micro-USDC on 2 USDC).
 *
 * Correct net amount:  2,000,000 - 2,000 = 1,998,000 DUSD
 * Actual minted:       1,000,000 DUSD
 * Refund amount:       998,000 micro-DUSD
 *
 * Uses a "FEE_REFUND_" prefixed transfer ID (not previously processed).
 *
 * Run: node mint-dusd-fee-refund.mjs
 */

import { invokeScript, broadcast, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';
dotenv.config();

const { publicKey, signBytes, base58Decode, seedWithNonce } = libs.crypto;

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_SEED   = process.env.DCC_VALIDATOR_SEED || 'museum solution artwork cherry slab please cage bid race team jacket jar rigid diary pole';
const DCC_NODE    = process.env.DCC_NODE_URL        || 'https://mainnet-node.decentralchain.io';
const CHAIN_ID    = process.env.DCC_CHAIN_ID_CHAR   || '?';

const DUSD_CONTRACT = '3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW';
const USDC_SPL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TX_SIGNER_SEED  = BASE_SEED;                       // nonce 0 — pays fees
const VAL_SIGNER_SEED = seedWithNonce(BASE_SEED, 3);     // nonce 3 — registered DUSD validator

// ── Refund entry ──────────────────────────────────────────────────────────────
// Original transfer: 5f803ad4567d6859d5a419b88925168c4518663fca56ebeae8dafee883cc348d
// Minted:       1,000,000 DUSD (1 DUSD) — fee floor bug charged 1 USDC instead of 0.002 USDC
// Should have:  1,998,000 DUSD (1.998 DUSD)
// Refund:         998,000 micro-DUSD

const refund = {
  transferId : 'FEE_REFUND_5f803ad4567d6859d5a419b88925168c4518663fca56ebeae8dafee883cc348d',
  recipient  : '3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq',
  amount     : 1000000,    // 1.000 DUSD (rounded up from 0.998 — contract minimum is $1)
  solSlot    : 406075789,  // original deposit slot
  splMint    : USDC_SPL_MINT,
};

// ── Message format matching DUSD constructMintMessage ─────────────────────────
// "SOL_DCC_DUSD_V1|MINT_DUSD|{transferId}|{recipient}|{amount}|{solSlot}|{splMint}"

function buildMessage(t) {
  return `SOL_DCC_DUSD_V1|MINT_DUSD|${t.transferId}|${t.recipient}|${t.amount}|${t.solSlot}|${t.splMint}`;
}

async function run() {
  const txSignerPub = publicKey(TX_SIGNER_SEED);
  const valPub      = publicKey(VAL_SIGNER_SEED);

  console.log('TX signer (fee payer):', txSignerPub);
  console.log('DUSD validator key:   ', valPub);
  console.log('DUSD contract:        ', DUSD_CONTRACT);
  console.log('');

  const t = refund;
  const msg     = buildMessage(t);
  const msgBytes= new TextEncoder().encode(msg);
  const sig     = signBytes(VAL_SIGNER_SEED, msgBytes);
  const sigB64  = Buffer.from(base58Decode(sig)).toString('base64');
  const pubB64  = Buffer.from(base58Decode(valPub)).toString('base64');

  console.log('TransferId :', t.transferId);
  console.log('Recipient  :', t.recipient);
  console.log('Amount     :', t.amount, '(micro-DUSD = 1.000 DUSD refund)');
  console.log('Message    :', msg);
  console.log('Signature  :', sig);
  console.log('');

  const tx = invokeScript({
    dApp: DUSD_CONTRACT,
    call: {
      function: 'mintDusd',
      args: [
        { type: 'string',  value: t.transferId },
        { type: 'string',  value: t.recipient  },
        { type: 'integer', value: t.amount     },
        { type: 'integer', value: t.solSlot    },
        { type: 'string',  value: t.splMint    },
        { type: 'list', value: [{ type: 'binary', value: `base64:${sigB64}` }] },
        { type: 'list', value: [{ type: 'binary', value: `base64:${pubB64}` }] },
      ],
    },
    payment: [],
    fee:     900000,
    chainId: CHAIN_ID.charCodeAt(0),
  }, TX_SIGNER_SEED);

  console.log('Broadcasting tx...');
  const result = await broadcast(tx, DCC_NODE);

  if (result.error) {
    console.error('FAILED:', result.error, result.message);
    process.exit(1);
  }

  console.log('✅ Refund minted!');
  console.log('TX ID:', result.id);
  console.log('Height:', result.height);
}

run().catch(err => { console.error(err); process.exit(1); });
