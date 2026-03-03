/**
 * Check DCC balances and test compile endpoint before deploying.
 */
import * as dcc from '@decentralchain/decentralchain-transactions';
import { readFileSync } from 'fs';

const NODE = 'https://keough-node.decentralchain.io';
const SEED = '***REDACTED_SEED_PHRASE***';
const CHAIN_ID = '?';

const addr0 = dcc.libs.crypto.address(SEED, CHAIN_ID);
const addr1 = dcc.libs.crypto.address({seed: SEED, nonce: 1}, CHAIN_ID);
console.log('Account 0 (bridge_controller):', addr0);
console.log('Account 1 (wsol_token):       ', addr1);

// Check balances
const [b0, b1] = await Promise.all([
  fetch(`${NODE}/addresses/balance/${addr0}`, {signal: AbortSignal.timeout(10000)}).then(r => r.json()),
  fetch(`${NODE}/addresses/balance/${addr1}`, {signal: AbortSignal.timeout(10000)}).then(r => r.json()),
]);
console.log('\nBalance 0:', (b0.balance / 1e8).toFixed(4), 'DCC');
console.log('Balance 1:', (b1.balance / 1e8).toFixed(4), 'DCC');

// Check fee for setScript (dApp)
const feesResp = await fetch(`${NODE}/transactions/calculateFee`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({type: 13, senderPublicKey: dcc.libs.crypto.publicKey(SEED)}),
  signal: AbortSignal.timeout(10000),
}).then(r => r.json());
console.log('\nsetScript fee:', JSON.stringify(feesResp));

// Test compile endpoint with tiny script
const testScript = `{-# STDLIB_VERSION 6 #-}
{-# CONTENT_TYPE DAPP #-}
{-# SCRIPT_TYPE ACCOUNT #-}
@Callable(i)
func hello() = []`;
const compileResp = await fetch(`${NODE}/utils/script/compileCode`, {
  method: 'POST',
  headers: {'Content-Type': 'text/plain'},
  body: testScript,
  signal: AbortSignal.timeout(15000),
}).then(r => r.json()).catch(e => ({error: e.message}));
console.log('\nCompile test:', compileResp.error ? 'FAIL: ' + compileResp.error : 'OK (complexity: ' + compileResp.complexity + ')');
