'use strict';
/**
 * redeploy-bridge-contract.cjs
 *
 * Compiles the updated bridge_controller.ride and updates the on-chain script
 * at the bridge address (3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG) via SetScript.
 *
 * SECURITY FIX: The original contract counted signatures but never verified them
 * cryptographically.  The fix adds verifyValidatorSignatures() calls in both
 * mintToken() and the legacy mint().  After this deploy any call with invalid
 * or all-zero signatures will be rejected on-chain.
 *
 * Run: node scripts/redeploy-bridge-contract.cjs
 */

const fs   = require('fs');
const path = require('path');
const { setScript, libs } = require('@decentralchain/decentralchain-transactions');
const { privateKey, publicKey, address, seedWithNonce } = libs.crypto;
require('dotenv').config();

// ── Config ─────────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const DCC_NODE   = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_CHAIN  = process.env.DCC_CHAIN_ID_CHAR || '?';
const API_KEY    = process.env.DCC_API_KEY || '';
const BASE_SEED  = required('DCC_VALIDATOR_SEED');
const BASE_NONCE = parseInt(process.env.DCC_VALIDATOR_NONCE || '1', 10);

const SEED        = seedWithNonce(BASE_SEED, BASE_NONCE);
const ADMIN_PK    = publicKey(SEED);
const ADMIN_ADDR  = address(SEED, DCC_CHAIN);
const SIGNER      = { privateKey: privateKey(SEED) };

const RIDE_FILE = path.resolve(__dirname, '../dcc-contracts/bridge-controller/bridge_controller.ride');

// ── Helpers ─────────────────────────────────────────────────────
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const dccGet = (p)  => fetch(`${DCC_NODE}${p}`).then(r => r.json());

async function dccPost(endpoint, body) {
  const r = await fetch(`${DCC_NODE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC ${endpoint}: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function compileRide(source) {
  const r = await fetch(`${DCC_NODE}/utils/script/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
    },
    body: source,
  });
  const d = await r.json();
  if (d.error || !d.script) throw new Error(`Compile failed: ${d.message || JSON.stringify(d)}`);
  console.log(`  Script size: ${d.complexity} complexity`);
  return d.script; // base64 encoded script
}

async function waitTx(txId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`Tx ${txId} not confirmed`);
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Bridge Contract Redeploy — Signature Verification Fix');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Admin:   ${ADMIN_ADDR}`);
  console.log(`  PubKey:  ${ADMIN_PK}`);
  console.log();

  // Verify admin DCC balance
  const { balance } = await dccGet(`/addresses/balance/${ADMIN_ADDR}`);
  const dccBal = balance / 1e8;
  console.log(`  DCC balance: ${dccBal.toFixed(4)} DCC`);
  if (dccBal < 0.15) throw new Error('Insufficient DCC for SetScript fee (need ≥0.15 DCC)');

  // Read and compile the RIDE source
  console.log(`\n  Reading: ${RIDE_FILE}`);
  const source = fs.readFileSync(RIDE_FILE, 'utf8');

  console.log('  Compiling RIDE script...');
  const scriptBase64 = await compileRide(source);
  console.log('  Compilation OK ✅');

  // Build SetScript transaction
  const tx = setScript(
    {
      script:    scriptBase64,
      chainId:   DCC_CHAIN,
      fee:       14_000_000, // 0.14 DCC — same as original deployment
      senderPublicKey: ADMIN_PK,
      version:   1,          // version 2 has uninitialized protobuf in this lib build
    },
    SIGNER
  );

  console.log('\n  Broadcasting SetScript...');
  const resp = await dccPost('/transactions/broadcast', tx);
  console.log(`  TX ID: ${resp.id}`);
  process.stdout.write('  Confirming');
  await waitTx(resp.id);
  console.log(' ✅\n');

  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅  CONTRACT UPDATED SUCCESSFULLY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`\n  TX: https://decentralscan.com/tx/${resp.id}`);
  console.log(`  Contract: https://decentralscan.com/address/${ADMIN_ADDR}`);
  console.log('\n  The bridge now cryptographically verifies all validator');
  console.log('  signatures on mintToken() and mint(). Zero-sig exploits');
  console.log('  are no longer possible.');
  console.log();
}

main().catch(e => {
  console.error('\n❌ FAILED:', e.message || e);
  process.exit(1);
});
