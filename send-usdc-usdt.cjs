'use strict';
/**
 * Send 1 USDT + 1 USDC through the SOL gateway to DCC.
 * Recipient: 3DZazDXzgUZ3gcueJ3wQNqSmwB3wKc4jHuz
 */
const { createHash, randomBytes } = require('crypto');
const { invokeScript, libs } = require('@decentralchain/decentralchain-transactions');
const { privateKey, publicKey, address, seedWithNonce, base58Decode, signBytes } = libs.crypto;
require('dotenv').config();

// DCC chain ID integer constant (matches RIDE contract constant dccChainId = 2)
const DCC_CHAIN_ID_INT = 2;

// ── Config ─────────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const DCC_NODE    = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_CHAIN   = process.env.DCC_CHAIN_ID_CHAR || '?';
const API_KEY     = required('DCC_API_KEY');
const BASE_SEED   = required('DCC_VALIDATOR_SEED');
const BASE_NONCE  = parseInt(process.env.DCC_VALIDATOR_NONCE || '1', 10);

const SEED        = seedWithNonce(BASE_SEED, BASE_NONCE);
const VALIDATOR_PK = publicKey(SEED);
const BRIDGE_ADDR  = address(SEED, DCC_CHAIN);
const SIGNER       = { privateKey: privateKey(SEED) };

const DCC_RECIPIENT = '3DZazDXzgUZ3gcueJ3wQNqSmwB3wKc4jHuz';

const TRANSFERS = [
  { symbol: 'USDC', splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amount: 1_000_000 },
  { symbol: 'USDT', splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  decimals: 6, amount: 1_000_000 },
];

// ── Helpers ─────────────────────────────────────────────────────
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const dccGet = (path) => fetch(`${DCC_NODE}${path}`).then(r => r.json());

async function dccBroadcast(tx) {
  const r = await fetch(`${DCC_NODE}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC rejected: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function waitDccTx(txId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`DCC tx ${txId} not confirmed after ${attempts * 3}s`);
}

async function mintToken(symbol, splMint, amount) {
  const transferIdHex = createHash('sha256').update(randomBytes(32)).digest('hex');
  const validatorPKBytes = Buffer.from(base58Decode(VALIDATOR_PK));
  const fakeSolSlot = 447000000;

  // Sign the canonical mint message (matches RIDE constructMintMessage)
  const canonicalMsg = `SOL_DCC_BRIDGE_V2|MINT|${transferIdHex}|${DCC_RECIPIENT}|${amount}|${fakeSolSlot}|${splMint}|${DCC_CHAIN_ID_INT}`;
  const sigBase58 = signBytes({ privateKey: privateKey(SEED) }, Buffer.from(canonicalMsg, 'utf8'));
  const sigBytes  = Buffer.from(base58Decode(sigBase58));

  const mintTx = invokeScript(
    {
      dApp:  BRIDGE_ADDR,
      call: {
        function: 'mintToken',
        args: [
          { type: 'string',  value: transferIdHex },
          { type: 'string',  value: DCC_RECIPIENT },
          { type: 'integer', value: amount },
          { type: 'integer', value: fakeSolSlot },
          { type: 'string',  value: splMint },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + sigBytes.toString('base64') }] },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + validatorPKBytes.toString('base64') }] },
        ],
      },
      payment:         [],
      chainId:         DCC_CHAIN,
      fee:             5000000,
      senderPublicKey: VALIDATOR_PK,
      version:         1,
    },
    SIGNER
  );

  process.stdout.write(`  Calling mintToken(${symbol})... `);
  const resp = await dccBroadcast(mintTx);
  process.stdout.write(`tx=${resp.id.slice(0,12)}… waiting`);
  await waitDccTx(resp.id);
  console.log(' ✅');
  return resp.id;
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  SOL Gateway → DCC  |  1 USDC + 1 USDT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Bridge:    ${BRIDGE_ADDR}`);
  console.log(`  Recipient: ${DCC_RECIPIENT}`);
  console.log();

  const { height } = await dccGet('/blocks/height');
  console.log(`  DCC mainnet height: ${height}`);

  // Verify bridge is live + tokens registered
  const paused = await dccGet(`/addresses/data/${BRIDGE_ADDR}/paused`).catch(() => null);
  if (paused?.value === true) throw new Error('Bridge is paused!');
  console.log('  Bridge: ✅ active\n');

  const results = [];

  for (const t of TRANSFERS) {
    // Verify token is registered
    const entry = await dccGet(`/addresses/data/${BRIDGE_ADDR}/token_${t.splMint}_asset_id`);
    if (!entry?.value) throw new Error(`${t.symbol} not registered on bridge`);
    console.log(`  ${t.symbol} asset ID: ${entry.value}`);

    const txId = await mintToken(t.symbol, t.splMint, t.amount);
    results.push({ symbol: t.symbol, txId, assetId: entry.value });
    // Small pause between mints
    await sleep(2000);
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅  TRANSFER COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  for (const r of results) {
    console.log(`\n  ${r.symbol}`);
    console.log(`    TX ID:   ${r.txId}`);
    console.log(`    Explorer: https://decentralscan.com/tx/${r.txId}`);
  }
  console.log(`\n  Recipient: https://decentralscan.com/address/${DCC_RECIPIENT}`);
  console.log();
}

main().catch(e => {
  console.error('\n❌ FAILED:', e.message || e);
  process.exit(1);
});
