/**
 * Phase 2 continuation — Set VK on Contract B + Init Checkpoint Committee
 * (Steps 1-5 already completed)
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { invokeScript, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);

const NODE_URL  = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const API_KEY   = process.env.DCC_API_KEY;
const CHAIN_ID  = process.env.DCC_CHAIN_ID_CHAR || '?';
const BASE_SEED = process.env.DCC_VALIDATOR_SEED;

const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

// Contract B (ZK Verifier) — nonce 2
const B_SEED  = seedWithNonce(BASE_SEED, 2);
const B_SIGNER = { privateKey: privateKey(B_SEED) };
const contractB = {
  address:   address(B_SEED, CHAIN_ID),
  publicKey: publicKey(B_SEED),
};

// Validator pubkeys for checkpoint committee
const VALIDATOR_PUBKEYS_B58 = [
  'BARDgEpMkhmcaEDExMCbyYnNoXnAk8KPVhWZaTVoXad',
  'F1Ea6eLBEVzmz25Y3VEyDCSDa5DKbzYdW65S9PvWGCzE',
  '6zKmnzWBSjs2z7QzWrWUHpxNgJgpKzUEPPQv6R9ctLya',
];

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

  result.set(fieldElementToBytes(vkey.vk_alpha_1[0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_alpha_1[1]), offset); offset += 32;

  result.set(fieldElementToBytes(vkey.vk_beta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][1]), offset); offset += 32;

  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][1]), offset); offset += 32;

  result.set(fieldElementToBytes(vkey.vk_delta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][1]), offset); offset += 32;

  for (let i = 0; i < icCount; i++) {
    result.set(fieldElementToBytes(vkey.IC[i][0]), offset); offset += 32;
    result.set(fieldElementToBytes(vkey.IC[i][1]), offset); offset += 32;
  }

  return result;
}

async function main() {
  console.log('Contract B:', contractB.address);
  console.log();

  // ── Step 6: Set Verifying Key ────────────────────────────────────────
  console.log('Step 6: Setting verifying key on Contract B...');

  // Check if already set
  const vkCheck = await apiGet(`/addresses/data/${contractB.address}/groth16_vk_set`).catch(() => null);
  if (vkCheck?.value === true) {
    console.log('  VK already set! (IMMUTABLE) Skipping...');
  } else {
    const vkJson = JSON.parse(
      readFileSync(resolve(__dir, 'zk/circuits/build/verification_key.json'), 'utf8')
    );
    console.log('  VK protocol:', vkJson.protocol, '| curve:', vkJson.curve, '| nPublic:', vkJson.nPublic);

    const vkBytes = serializeVkForRIDE(vkJson);
    console.log('  Serialized VK:', vkBytes.length, 'bytes');

    // Compute keccak256 hash
    const jsSha3 = require2('js-sha3');
    const hashHex = jsSha3.keccak256(vkBytes);
    const hashBytes = new Uint8Array(hashHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const expectedHashBase64 = Buffer.from(hashBytes).toString('base64');
    const vkBase64 = Buffer.from(vkBytes).toString('base64');
    console.log('  VK hash (keccak256):', hashHex.slice(0, 32) + '...');
    console.log('  VK base64 size:', vkBase64.length);

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
  }
  console.log();

  // ── Step 7: Initialize checkpoint committee ──────────────────────────
  console.log('Step 7: Initializing checkpoint committee on Contract B...');
  const commCheck = await apiGet(`/addresses/data/${contractB.address}/committee_size`).catch(() => null);
  if (commCheck?.value > 0) {
    console.log('  Committee already initialized! Size:', commCheck.value, 'Skipping...');
  } else {
    const initCommTx = invokeScript({
      dApp: contractB.address,
      call: {
        function: 'initializeCommittee',
        args: [
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[0] },
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[1] },
          { type: 'string', value: VALIDATOR_PUBKEYS_B58[2] },
          { type: 'integer', value: 2 },
        ],
      },
      payment: [],
      chainId: CHAIN_ID,
      fee: 900000,
      senderPublicKey: contractB.publicKey,
      version: 1,
    }, B_SIGNER);
    const initCommResp = await broadcastTx(initCommTx);
    console.log('  Tx ID:', initCommResp.id);
    await waitForTx(initCommResp.id);
    console.log('  ✅ Checkpoint committee initialized!');
  }
  console.log();

  // ── Verify ──────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Verification');
  console.log('═══════════════════════════════════════════════════════');

  const A_ADDR = '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG';

  const zkVer = await apiGet(`/addresses/data/${A_ADDR}/zk_verifier_address`).catch(() => null);
  console.log('Contract A → zk_verifier_address:', zkVer?.value || 'NOT SET');

  const bridge = await apiGet(`/addresses/data/${contractB.address}/bridge_core_address`).catch(() => null);
  console.log('Contract B → bridge_core_address:', bridge?.value || 'NOT SET');

  const vkSet = await apiGet(`/addresses/data/${contractB.address}/groth16_vk_set`).catch(() => null);
  console.log('Contract B → groth16_vk_set:', vkSet?.value ?? 'NOT SET');

  const commSize = await apiGet(`/addresses/data/${contractB.address}/committee_size`).catch(() => null);
  console.log('Contract B → committee_size:', commSize?.value ?? 'NOT SET');

  const thresh = await apiGet(`/addresses/data/${contractB.address}/approval_threshold`).catch(() => null);
  console.log('Contract B → approval_threshold:', thresh?.value ?? 'NOT SET');

  console.log();
  console.log('✅ Phase 2 setup complete!');
  console.log('Contract B (ZK Verifier):', contractB.address);
  console.log();
  console.log('Add to .env:');
  console.log(`DCC_ZK_VERIFIER_CONTRACT=${contractB.address}`);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
