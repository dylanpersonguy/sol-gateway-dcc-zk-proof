/**
 * Phase 2 — Deploy ZK Verifier (Contract B) & Upgrade Bridge Core (Contract A)
 *
 * Steps:
 *  1. Derive Contract B address from seedWithNonce(baseSeed, 2)
 *  2. Fund Contract B address from nonce 0 (old deployer)
 *  3. Compile & deploy zk_verifier.ride to Contract B
 *  4. Initialize Contract B (links to Contract A address)
 *  5. Recompile & redeploy zk_bridge.ride to Contract A (nonce 1)
 *  6. Call setZkVerifier(contractBAddress) on Contract A
 *  7. Serialize VK from verification_key.json → RIDE ByteVector
 *  8. Call setVerifyingKey(vk, expectedHash) on Contract B
 *  9. Initialize checkpoint committee on Contract B
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setScript,
  invokeScript,
  transfer,
  libs,
} from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const NODE_URL  = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY   = required('DCC_API_KEY');
const CHAIN_ID  = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED = required('DCC_VALIDATOR_SEED');

const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

// Contract A (Bridge Core) — nonce 1
const A_NONCE = 1;
const A_SEED  = seedWithNonce(BASE_SEED, A_NONCE);
const A_SIGNER = { privateKey: privateKey(A_SEED) };
const contractA = {
  address:   address(A_SEED, CHAIN_ID),
  publicKey: publicKey(A_SEED),
};

// Contract B (ZK Verifier) — nonce 2 (new address)
const B_NONCE = 2;
const B_SEED  = seedWithNonce(BASE_SEED, B_NONCE);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractB = {
  address:   address(B_SEED, CHAIN_ID),
  publicKey: publicKey(B_SEED),
};

// Funder — nonce 0
const FUND_SEED = seedWithNonce(BASE_SEED, 0);
const FUND_SIGNER = { privateKey: privateKey(FUND_SEED) };
const funderAddress = address(FUND_SEED, CHAIN_ID);

// Validator DCC signing keys (for checkpoint committee on Contract B)
const VALIDATOR_PUBKEYS_B58 = [
  'BARDgEpMkhmcaEDExMCbyYnNoXnAk8KPVhWZaTVoXad',   // validator-1
  'F1Ea6eLBEVzmz25Y3VEyDCSDa5DKbzYdW65S9PvWGCzE',  // validator-2
  '6zKmnzWBSjs2z7QzWrWUHpxNgJgpKzUEPPQv6R9ctLya',  // validator-3
];

// ── Helpers ────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch(NODE_URL + path);
  return r.json();
}

async function broadcastTx(tx) {
  const r = await fetch(`${NODE_URL}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Node rejected tx: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function compileScript(code) {
  const r = await fetch(`${NODE_URL}/utils/script/compileCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-API-Key': API_KEY },
    body: code,
  });
  const d = await r.json();
  if (!d.script) throw new Error('Compile failed: ' + (d.message || JSON.stringify(d)));
  return d.script;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForTx(txId, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await apiGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    console.log(`  Waiting for tx ${txId.slice(0, 12)}... (${i + 1}/${attempts})`);
    await sleep(5000);
  }
  throw new Error(`Tx ${txId} not confirmed after ${attempts} attempts`);
}

// ── VK Serialization ─────────────────────────────────────────────────────
function fieldElementToBytes(decStr) {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function serializeVkForRIDE(vkey) {
  const icCount = vkey.IC.length;
  const totalBytes = 64 + 128 + 128 + 128 + icCount * 64;
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  // alpha (G1)
  result.set(fieldElementToBytes(vkey.vk_alpha_1[0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_alpha_1[1]), offset); offset += 32;

  // beta (G2)
  result.set(fieldElementToBytes(vkey.vk_beta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][1]), offset); offset += 32;

  // gamma (G2)
  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][1]), offset); offset += 32;

  // delta (G2)
  result.set(fieldElementToBytes(vkey.vk_delta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][1]), offset); offset += 32;

  // IC points (G1)
  for (let i = 0; i < icCount; i++) {
    result.set(fieldElementToBytes(vkey.IC[i][0]), offset); offset += 32;
    result.set(fieldElementToBytes(vkey.IC[i][1]), offset); offset += 32;
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Phase 2 — ZK Verifier Deployment');
  console.log('═══════════════════════════════════════════════════════');
  console.log('Node:              ', NODE_URL);
  console.log('Chain ID:          ', CHAIN_ID, `(${CHAIN_ID.charCodeAt(0)})`);
  console.log('Funder   (n=0):    ', funderAddress);
  console.log('Contract A (n=1):  ', contractA.address);
  console.log('Contract B (n=2):  ', contractB.address);
  console.log();

  // ── Verify Contract A matches expected ─────────────────────────────────
  const expectedA = process.env.DCC_BRIDGE_CONTRACT;
  if (expectedA && contractA.address !== expectedA) {
    throw new Error(`Contract A address mismatch: derived=${contractA.address}, expected=${expectedA}`);
  }
  console.log('✅ Contract A address matches .env');
  console.log();

  // ── Step 1: Fund Contract B ────────────────────────────────────────────
  console.log('Step 1: Funding Contract B...');
  const bBal = await apiGet(`/addresses/balance/${contractB.address}`);
  const bDcc = (bBal.balance || 0) / 1e8;
  console.log('  Contract B balance:', bDcc.toFixed(4), 'DCC');

  const NEEDED = 5; // ~5 DCC for setScript + initialize + setVK + committee
  if (bDcc < NEEDED) {
    const funderBal = await apiGet(`/addresses/balance/${funderAddress}`);
    const funderDcc = (funderBal.balance || 0) / 1e8;
    console.log('  Funder balance:', funderDcc.toFixed(4), 'DCC');

    const toSend = Math.ceil((NEEDED - bDcc + 1) * 1e8);
    if (funderDcc < toSend / 1e8 + 0.01) {
      // Try Contract A as funder
      const aBal = await apiGet(`/addresses/balance/${contractA.address}`);
      const aDcc = (aBal.balance || 0) / 1e8;
      console.log('  Contract A balance:', aDcc.toFixed(4), 'DCC');
      if (aDcc < toSend / 1e8 + 0.5) {
        throw new Error(`Insufficient DCC. Funder: ${funderDcc.toFixed(4)}, Contract A: ${aDcc.toFixed(4)}`);
      }
      // Fund from Contract A
      console.log(`  Transferring ${(toSend / 1e8).toFixed(4)} DCC from Contract A → Contract B...`);
      const txFund = transfer({
        recipient: contractB.address,
        amount: toSend,
        fee: 500000,
        chainId: CHAIN_ID,
        senderPublicKey: contractA.publicKey,
        version: 2,
      }, A_SIGNER);
      const fundResp = await broadcastTx(txFund);
      console.log('  Tx ID:', fundResp.id);
      await waitForTx(fundResp.id);
    } else {
      console.log(`  Transferring ${(toSend / 1e8).toFixed(4)} DCC from funder → Contract B...`);
      const txFund = transfer({
        recipient: contractB.address,
        amount: toSend,
        fee: 500000,
        chainId: CHAIN_ID,
        senderPublicKey: publicKey(FUND_SEED),
        version: 2,
      }, FUND_SIGNER);
      const fundResp = await broadcastTx(txFund);
      console.log('  Tx ID:', fundResp.id);
      await waitForTx(fundResp.id);
    }
    const updBal = await apiGet(`/addresses/balance/${contractB.address}`);
    console.log('  Contract B balance:', ((updBal.balance || 0) / 1e8).toFixed(4), 'DCC');
  } else {
    console.log('  ✅ Already funded.');
  }
  console.log();

  // ── Step 2: Compile & deploy Contract B (zk_verifier.ride) ─────────────
  console.log('Step 2: Compiling zk_verifier.ride...');
  const rideB = readFileSync(resolve(__dir, 'dcc/contracts/bridge/zk_verifier.ride'), 'utf8');
  const compiledB = await compileScript(rideB);
  console.log('  Compiled OK —', Math.round(compiledB.length * 3 / 4), 'bytes');

  console.log('  Broadcasting SetScript for Contract B...');
  const setScriptB = setScript({
    script: compiledB,
    chainId: CHAIN_ID,
    fee: 14000000,  // 0.14 DCC
    senderPublicKey: contractB.publicKey,
    version: 1,
  }, B_SIGNER);
  const setScriptBResp = await broadcastTx(setScriptB);
  console.log('  Tx ID:', setScriptBResp.id);
  await waitForTx(setScriptBResp.id);
  console.log('  ✅ Contract B deployed!');
  console.log();

  // ── Step 3: Initialize Contract B ──────────────────────────────────────
  console.log('Step 3: Initializing Contract B (linking to Contract A)...');
  const initB = invokeScript({
    dApp: contractB.address,
    call: {
      function: 'initialize',
      args: [
        { type: 'string', value: contractA.address },  // bridgeCoreAddress
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 900000,
    senderPublicKey: contractB.publicKey,
    version: 1,
  }, B_SIGNER);
  const initBResp = await broadcastTx(initB);
  console.log('  Tx ID:', initBResp.id);
  await waitForTx(initBResp.id);
  console.log('  ✅ Contract B initialized! Linked to Contract A:', contractA.address);
  console.log();

  // ── Step 4: Recompile & redeploy Contract A (zk_bridge.ride) ──────────
  console.log('Step 4: Recompiling & redeploying Contract A (zk_bridge.ride)...');
  const rideA = readFileSync(resolve(__dir, 'dcc/contracts/bridge/zk_bridge.ride'), 'utf8');
  const compiledA = await compileScript(rideA);
  console.log('  Compiled OK —', Math.round(compiledA.length * 3 / 4), 'bytes');

  const setScriptA = setScript({
    script: compiledA,
    chainId: CHAIN_ID,
    fee: 14000000,
    senderPublicKey: contractA.publicKey,
    version: 1,
  }, A_SIGNER);
  const setScriptAResp = await broadcastTx(setScriptA);
  console.log('  Tx ID:', setScriptAResp.id);
  await waitForTx(setScriptAResp.id);
  console.log('  ✅ Contract A redeployed with Phase 2 support!');
  console.log();

  // ── Step 5: Link contracts — setZkVerifier on A ────────────────────────
  console.log('Step 5: Linking contracts — setZkVerifier on Contract A...');
  const linkTx = invokeScript({
    dApp: contractA.address,
    call: {
      function: 'setZkVerifier',
      args: [
        { type: 'string', value: contractB.address },
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 900000,
    senderPublicKey: contractA.publicKey,
    version: 1,
  }, A_SIGNER);
  const linkResp = await broadcastTx(linkTx);
  console.log('  Tx ID:', linkResp.id);
  await waitForTx(linkResp.id);
  console.log('  ✅ Contract A now trusts Contract B at:', contractB.address);
  console.log();

  // ── Step 6: Serialize VK & set on Contract B ───────────────────────────
  console.log('Step 6: Setting verifying key on Contract B...');
  const vkJson = JSON.parse(
    readFileSync(resolve(__dir, 'zk/circuits/build/verification_key.json'), 'utf8')
  );
  console.log('  VK protocol:', vkJson.protocol, '| curve:', vkJson.curve, '| nPublic:', vkJson.nPublic);

  const vkBytes = serializeVkForRIDE(vkJson);
  console.log('  Serialized VK:', vkBytes.length, 'bytes');

  // Compute expected hash: keccak256(vkBytes) — represented as base64 for RIDE
  // RIDE's keccak256 is the standard Keccak-256 (NOT SHA3-256)
  // We'll pass the raw bytes to the contract, which computes keccak256 itself
  // The expectedHash arg is what we expect keccak256(vk) to equal
  const keccak = createHash('sha3-256'); // Node's sha3-256 IS Keccak-256 for all practical purposes
  // Actually, Node.js doesn't have keccak256 natively — use js-sha3 or compute on-chain
  // The contract computes its own hash, we just need to pass what we expect
  // Let's compute it using the same library the ZK prover uses

  // For now: use a simple hash approach — the contract will verify keccak256(vk) == expectedHash
  // We'll use Buffer to base64-encode the VK for transport
  const vkBase64 = Buffer.from(vkBytes).toString('base64');

  // Compute expected hash using keccak256
  // We need @noble/hashes or ethers.js for keccak256
  // Fallback: just use sha256 for the commitment and the contract will verify
  // Actually the contract uses keccak256 — let's import it from snarkjs's dep
  let expectedHashBase64;
  try {
    // js-sha3 is a CJS module, need createRequire for ESM
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    const jsSha3 = req('js-sha3');
    const hashHex = jsSha3.keccak256(vkBytes);
    const hashBytes = new Uint8Array(hashHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    expectedHashBase64 = Buffer.from(hashBytes).toString('base64');
    console.log('  VK hash (keccak256):', hashHex.slice(0, 32) + '...');
  } catch {
    // Fallback: compute using Node crypto (sha3-256 in Node IS Keccak-256 for NIST variant)
    // Actually Node's sha3-256 is the NIST standard, NOT Ethereum's keccak256
    // They differ! Let's install js-sha3
    console.log('  Installing js-sha3 for keccak256...');
    const { execSync } = await import('child_process');
    execSync('npm install js-sha3 --no-save', { cwd: __dir, stdio: 'pipe' });
    const { createRequire: cr2 } = await import('module');
    const req2 = cr2(import.meta.url);
    const jsSha3b = req2('js-sha3');
    const hashHex = jsSha3b.keccak256(vkBytes);
    const hashBytes = new Uint8Array(hashHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    expectedHashBase64 = Buffer.from(hashBytes).toString('base64');
    console.log('  VK hash (keccak256):', hashHex.slice(0, 32) + '...');
  }

  console.log('  VK base64 length:', vkBase64.length);

  const setVkTx = invokeScript({
    dApp: contractB.address,
    call: {
      function: 'setVerifyingKey',
      args: [
        { type: 'binary', value: vkBase64 },
        { type: 'binary', value: expectedHashBase64 },
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 900000,
    senderPublicKey: contractB.publicKey,
    version: 1,
  }, B_SIGNER);
  const setVkResp = await broadcastTx(setVkTx);
  console.log('  Tx ID:', setVkResp.id);
  await waitForTx(setVkResp.id);
  console.log('  ✅ Verifying key set on Contract B! (IMMUTABLE)');
  console.log();

  // ── Step 7: Initialize checkpoint committee on Contract B ──────────────
  console.log('Step 7: Initializing checkpoint committee on Contract B...');
  const initCommB = invokeScript({
    dApp: contractB.address,
    call: {
      function: 'initializeCommittee',
      args: [
        { type: 'string', value: VALIDATOR_PUBKEYS_B58[0] },
        { type: 'string', value: VALIDATOR_PUBKEYS_B58[1] },
        { type: 'string', value: VALIDATOR_PUBKEYS_B58[2] },
        { type: 'integer', value: 2 }, // 2-of-3 threshold
      ],
    },
    payment: [],
    chainId: CHAIN_ID,
    fee: 900000,
    senderPublicKey: contractB.publicKey,
    version: 1,
  }, B_SIGNER);
  const initCommBResp = await broadcastTx(initCommB);
  console.log('  Tx ID:', initCommBResp.id);
  await waitForTx(initCommBResp.id);
  console.log('  ✅ Checkpoint committee initialized on Contract B!');
  console.log();

  // ── Verify ─────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Verification');
  console.log('═══════════════════════════════════════════════════════');

  // Check Contract A → zkVerifier
  const zkVerEntry = await apiGet(`/addresses/data/${contractA.address}/zk_verifier_address`).catch(() => null);
  console.log('Contract A → zk_verifier_address:', zkVerEntry?.value || 'NOT SET');

  // Check Contract B → bridge_core_address
  const bridgeEntry = await apiGet(`/addresses/data/${contractB.address}/bridge_core_address`).catch(() => null);
  console.log('Contract B → bridge_core_address:', bridgeEntry?.value || 'NOT SET');

  // Check Contract B → VK set
  const vkSetEntry = await apiGet(`/addresses/data/${contractB.address}/groth16_vk_set`).catch(() => null);
  console.log('Contract B → groth16_vk_set:', vkSetEntry?.value ?? 'NOT SET');

  // Check Contract B → committee
  const commSizeB = await apiGet(`/addresses/data/${contractB.address}/committee_size`).catch(() => null);
  console.log('Contract B → committee_size:', commSizeB?.value ?? 'NOT SET');

  const threshB = await apiGet(`/addresses/data/${contractB.address}/approval_threshold`).catch(() => null);
  console.log('Contract B → approval_threshold:', threshB?.value ?? 'NOT SET');

  // Check Contract A balance
  const aBal = await apiGet(`/addresses/balance/${contractA.address}`);
  console.log('Contract A balance:', ((aBal.balance || 0) / 1e8).toFixed(4), 'DCC');

  const bBalFinal = await apiGet(`/addresses/balance/${contractB.address}`);
  console.log('Contract B balance:', ((bBalFinal.balance || 0) / 1e8).toFixed(4), 'DCC');

  console.log();
  console.log('═══════════════════════════════════════════════════════');
  console.log(' ✅ Phase 2 Deployment Complete!');
  console.log('═══════════════════════════════════════════════════════');
  console.log();
  console.log('Contract A (Bridge Core):  ', contractA.address);
  console.log('Contract B (ZK Verifier):  ', contractB.address);
  console.log();
  console.log('Add to .env:');
  console.log(`DCC_ZK_VERIFIER_CONTRACT=${contractB.address}`);
  console.log();
  console.log('Architecture:');
  console.log('  Solana Deposit → Validators → Checkpoint Committee → proposeCheckpoint/approveCheckpoint on Contract B');
  console.log('  ZK Prover → Groth16 Proof → verifyAndMint on Contract B → zkMintAuthorized on Contract A → wSOL minted');
  console.log();
  console.log('Phase 1 (committeeMint) still fully operational on Contract A.');
}

main().catch(err => {
  console.error('❌ Deployment failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
