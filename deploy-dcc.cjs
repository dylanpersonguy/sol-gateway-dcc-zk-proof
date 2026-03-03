'use strict';
/**
 * DCC Bridge Controller Deployment Script (CommonJS)
 *
 * IMPORTANT: The genesis account is the only block forger on the local chain.
 * Scripted accounts CANNOT forge blocks, so the contract MUST be deployed to
 * a separate (non-genesis) account.
 *
 * Steps:
 *  0. Derive genesis (funder) + bridge (contract host) accounts
 *  1. Transfer DCC from genesis → bridge account
 *  2. Compile + SetScript tx  — deploys bridge_controller.ride to bridge account
 *  3. InvokeScript initialize(guardian, minValidators)
 *  4. InvokeScript registerValidator(pubKey)
 */
const fs      = require('fs');
const path    = require('path');
const ROOT    = __dirname;

const {
  setScript,
  invokeScript,
  transfer,
  libs,
} = require('@decentralchain/decentralchain-transactions');

const { privateKey, publicKey, address, base58Decode } = libs.crypto;

// ── Config ────────────────────────────────────────────────────────────────────
const NODE_URL       = 'http://localhost:6869';    // local DCC node
const CHAIN_ID       = 'D';                        // local dev chain byte

// Genesis/miner account — base58-encoded raw-byte seed from node.conf
const GENESIS_SEED_B58 = 'E8kZYpXnUTdo5Wy6FyNfvMW12fQ6WDFWXgs5a6MEz4thNg7hpudkAh6Nj9zmP4J6tvkvMXQUrDxcU5wfWKtC8bKdBkCRL';

// Bridge contract account — plain-text seed (not genesis → safe to script)
const BRIDGE_SEED    = 'bridge controller for sol-gateway-dcc local dev';

// Validator seed (from .env DCC_VALIDATOR_SEED)
const VALIDATOR_SEED = '***REDACTED_SEED_PHRASE***';

const MIN_VALIDATORS = 1;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function apiGet(p) {
  const r = await fetch(NODE_URL + p);
  return r.json();
}

async function compileScript(code) {
  const r = await fetch(`${NODE_URL}/utils/script/compileCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;
}

async function broadcastTx(tx) {
  const r = await fetch(`${NODE_URL}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Node rejected tx: ${d.message || JSON.stringify(d)}`);
  return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTx(txId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await apiGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`Tx ${txId} not confirmed`);
}

// ── Derive keys ───────────────────────────────────────────────────────────────
// Genesis (miner) — DO NOT attach a script to this account!
const GENESIS_SEED    = base58Decode(GENESIS_SEED_B58);
const GENESIS_PUBKEY  = publicKey(GENESIS_SEED);
const GENESIS_ADDR    = address(GENESIS_SEED, CHAIN_ID);
const GENESIS_SIGNER  = { privateKey: privateKey(GENESIS_SEED) };

// Bridge contract account (safe to script — not a forger)
const BRIDGE_PUBKEY   = publicKey(BRIDGE_SEED);
const BRIDGE_ADDR     = address(BRIDGE_SEED, CHAIN_ID);
const BRIDGE_SIGNER   = { privateKey: privateKey(BRIDGE_SEED) };

// Validator account
const VALIDATOR_PUBKEY = publicKey(VALIDATOR_SEED);
const VALIDATOR_ADDR   = address(VALIDATOR_SEED, CHAIN_ID);

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' DCC Bridge Controller Deployment');
  console.log('═══════════════════════════════════════════════════');
  console.log('Genesis  (funder):', GENESIS_ADDR);
  console.log('Bridge  (contract):', BRIDGE_ADDR);
  console.log('Validator         :', VALIDATOR_ADDR, '(pubkey:', VALIDATOR_PUBKEY + ')');
  console.log();

  // Genesis balance check
  const genBal = await apiGet(`/addresses/balance/${GENESIS_ADDR}`);
  console.log('Genesis balance:', ((genBal.balance || 0) / 1e8).toFixed(4), 'DCC');

  // Bridge balance check
  const bridgeBal = await apiGet(`/addresses/balance/${BRIDGE_ADDR}`);
  const bridgeDcc = (bridgeBal.balance || 0) / 1e8;
  console.log('Bridge balance: ', bridgeDcc.toFixed(4), 'DCC');

  // Already initialized?
  const adminData = await apiGet(`/addresses/data/${BRIDGE_ADDR}/admin`);
  if (!adminData.error && adminData.value) {
    console.log('\nAlready initialized!');
    const wsol = await apiGet(`/addresses/data/${BRIDGE_ADDR}/wsol_asset_id`);
    const { TOKEN_REGISTRY } = require('./dcc-contracts/token-registry.cjs');
    printEnvLines(BRIDGE_ADDR, wsol.value, TOKEN_REGISTRY);
    return;
  }

  // ── STEP 0: Fund bridge account ───────────────────────────────────────────
  if (bridgeDcc < 5) {
    console.log('\nStep 0: Funding bridge account with 30 DCC...');
    const txferTx = transfer(
      {
        recipient: BRIDGE_ADDR,
        amount: 30_0000_0000,   // 30 DCC (8 decimals)
        chainId: CHAIN_ID,
        fee: 500000,
        senderPublicKey: GENESIS_PUBKEY,
        version: 2,
      },
      GENESIS_SIGNER
    );
    const txferResp = await broadcastTx(txferTx);
    process.stdout.write('   Confirming');
    await waitForTx(txferResp.id);
    console.log(' ✅');
  }

  // ── STEP 1: Compile ────────────────────────────────────────────────────────
  console.log('Step 1: Compiling bridge_controller.ride...');
  const rideCode    = fs.readFileSync(path.join(ROOT, 'dcc-contracts/bridge-controller/bridge_controller.ride'), 'utf8');
  const compiledB64 = await compileScript(rideCode);
  console.log('   OK —', Math.round(compiledB64.length * 3 / 4), 'bytes');

  // ── STEP 2: SetScript on bridge account ───────────────────────────────────
  console.log('Step 2: setScript on bridge account...');
  const setScriptTx = setScript(
    { script: compiledB64, chainId: CHAIN_ID, fee: 14000000, senderPublicKey: BRIDGE_PUBKEY, version: 1 },
    BRIDGE_SIGNER
  );
  console.log('   Tx ID:', setScriptTx.id);

  const ssResp = await broadcastTx(setScriptTx);
  console.log('   Accepted by node, Tx ID:', ssResp.id);
  process.stdout.write('   Confirming');
  await waitForTx(ssResp.id);
  console.log(' ✅');

  // ── STEP 3: Initialize (called by bridge account as admin) ────────────────
  console.log('Step 3: initialize()...');
  const initTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: { function: 'initialize', args: [
        { type: 'string',  value: BRIDGE_ADDR },      // guardian = bridge itself
        { type: 'integer', value: MIN_VALIDATORS },
      ]},
      payment: [],
      chainId: CHAIN_ID,
      fee: 100500000,   // 1.005 DCC — InvokeScript + Issue action fee
      senderPublicKey: BRIDGE_PUBKEY,
      version: 1,
    },
    BRIDGE_SIGNER
  );
  console.log('   Tx ID:', initTx.id);

  const initResp = await broadcastTx(initTx);
  process.stdout.write('   Confirming');
  await waitForTx(initResp.id);
  console.log(' ✅');

  // ── STEP 4: Register validator ────────────────────────────────────────────
  console.log('Step 4: registerValidator()...');
  const regTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: { function: 'registerValidator', args: [
        { type: 'string', value: VALIDATOR_PUBKEY },
      ]},
      payment: [],
      chainId: CHAIN_ID,
      fee: 5000000,
      senderPublicKey: BRIDGE_PUBKEY,
      version: 1,
    },
    BRIDGE_SIGNER
  );
  console.log('   Tx ID:', regTx.id);

  const regResp = await broadcastTx(regTx);
  process.stdout.write('   Confirming');
  await waitForTx(regResp.id);
  console.log(' ✅');

  // ── Read wSOL asset ID ────────────────────────────────────────────────────
  const wsolEntry = await apiGet(`/addresses/data/${BRIDGE_ADDR}/wsol_asset_id`);
  const wsolAssetId = wsolEntry.value;

  // ── STEP 5: Register SPL tokens ──────────────────────────────────────────
  console.log('Step 5: Registering SPL tokens...');
  const { TOKEN_REGISTRY } = require('./dcc-contracts/token-registry.cjs');
  
  for (let i = 0; i < TOKEN_REGISTRY.length; i++) {
    const t = TOKEN_REGISTRY[i];
    console.log(`   [${i + 1}/${TOKEN_REGISTRY.length}] ${t.symbol} (${t.splMint.slice(0, 8)}...)`);
    
    const regTokenTx = invokeScript(
      {
        dApp: BRIDGE_ADDR,
        call: {
          function: 'registerToken',
          args: [
            { type: 'string',  value: t.splMint },
            { type: 'string',  value: t.name },
            { type: 'string',  value: t.symbol },
            { type: 'string',  value: t.description },
            { type: 'integer', value: t.solDecimals },
            { type: 'integer', value: t.dccDecimals },
          ],
        },
        payment: [],
        chainId: CHAIN_ID,
        fee: 100500000,   // 1.005 DCC — InvokeScript + Issue action
        senderPublicKey: BRIDGE_PUBKEY,
        version: 1,
      },
      BRIDGE_SIGNER
    );
    
    const resp = await broadcastTx(regTokenTx);
    process.stdout.write('      Confirming');
    await waitForTx(resp.id);
    console.log(' ✅');
  }

  // ── Read registered token count ─────────────────────────────────────────
  const tokenCount = await apiGet(`/addresses/data/${BRIDGE_ADDR}/registered_token_count`);
  console.log(`   Total registered tokens: ${tokenCount.value} (incl. native SOL)`);

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log(' DEPLOYMENT COMPLETE!');
  console.log('═══════════════════════════════════════════════════');
  printEnvLines(BRIDGE_ADDR, wsolAssetId, TOKEN_REGISTRY);
}

function printEnvLines(bridgeAddr, wsolId, tokens) {
  console.log();
  console.log('Bridge address:', bridgeAddr);
  console.log('wSOL asset ID: ', wsolId);
  if (tokens && tokens.length > 0) {
    console.log();
    console.log('Registered SPL tokens:');
    tokens.forEach(t => console.log(`  ${t.symbol.padEnd(10)} ${t.splMint}`));
  }
  console.log();
  console.log('Add to .env:');
  console.log(`DCC_BRIDGE_CONTRACT=${bridgeAddr}`);
  console.log(`DCC_NODE_URL=${NODE_URL}`);
  console.log(`DCC_CHAIN_ID=68`);
  console.log(`DCC_CHAIN_ID_CHAR=D`);
  console.log(`WSOL_ASSET_ID=${wsolId}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
