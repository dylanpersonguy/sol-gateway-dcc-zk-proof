/**
 * recover-stuck-mints.mjs
 *
 * One-shot recovery script for two USDC deposits that reached validator
 * consensus but whose DCC mint transactions failed due to the ESM/CJS
 * protobuf incompatibility (now fixed).
 *
 * The on-chain bridge contract requires 2-of-3 DCC Curve25519 signatures
 * (approval_threshold: 2).  We derive all 3 validator signing seeds from
 * the master DCC seed and sign with validators 1 and 2.
 *
 * Run: node recover-stuck-mints.mjs
 */

import { invokeScript, broadcast, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';
dotenv.config();

// ── Configuration ────────────────────────────────────────────────────────────

const DCC_SEED     = process.env.DCC_VALIDATOR_SEED || 'museum solution artwork cherry slab please cage bid race team jacket jar rigid diary pole';
const DCC_CONTRACT = process.env.DCC_BRIDGE_CONTRACT || '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG';
const DCC_NODE_URL = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_CHAIN_ID = process.env.DCC_CHAIN_ID_CHAR || '?';

const { publicKey, signBytes, base58Decode } = libs.crypto;

// Validator signing seeds (DCC Curve25519 — matches RIDE sigVerify)
const V1_SEED = DCC_SEED + ':bridge-signer:validator-1';
const V2_SEED = DCC_SEED + ':bridge-signer:validator-2';
const V3_SEED = DCC_SEED + ':bridge-signer:validator-3';

// ── Deposits to recover ──────────────────────────────────────────────────────

const deposits = [
  {
    transferId : 'a8d40ac88828a1560e59e3b1c0081e67ab1341ff41d441e452ae63ab1d033c44',
    recipient  : '3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq',
    amount     : 3000000,   // net after 0.10 % fee (4 USDC → 3 USDC)
    solSlot    : 406062538,
  },
  {
    transferId : '1f168e495a8f9dd36f3e0fe7a9f239906f0615dfe2a4739f9a03b567fd5ae864',
    recipient  : '3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq',
    amount     : 2000000,   // net after 0.10 % fee (3 USDC → 2 USDC)
    solSlot    : 406061360,
  },
];

// ── Canonical message matching RIDE committeeMint verification ────────────────
// Format used by the validator (from consensus/engine.ts constructMintMessage):
//   transferId + "|" + recipient + "|" + amount + "|" + solSlot

function canonicalMessage(deposit) {
  return `${deposit.transferId}|${deposit.recipient}|${deposit.amount}|${deposit.solSlot}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify committee key derivation
  const v1Pub = publicKey(V1_SEED);
  const v2Pub = publicKey(V2_SEED);
  const v3Pub = publicKey(V3_SEED);
  console.log('Committee public keys:');
  console.log('  V1:', v1Pub, '(expected: BARDgEpMkhmcaEDExMCbyYnNoXnAk8KPVhWZaTVoXad)');
  console.log('  V2:', v2Pub, '(expected: F1Ea6eLBEVzmz25Y3VEyDCSDa5DKbzYdW65S9PvWGCzE)');
  console.log('  V3:', v3Pub, '(expected: 6zKmnzWBSjs2z7QzWrWUHpxNgJgpKzUEPPQv6R9ctLya)');

  const ok = v1Pub === 'BARDgEpMkhmcaEDExMCbyYnNoXnAk8KPVhWZaTVoXad'
          && v2Pub === 'F1Ea6eLBEVzmz25Y3VEyDCSDa5DKbzYdW65S9PvWGCzE'
          && v3Pub === '6zKmnzWBSjs2z7QzWrWUHpxNgJgpKzUEPPQv6R9ctLya';
  if (!ok) { console.error('Key mismatch — aborting'); process.exit(1); }
  console.log('  Keys verified ✓\n');

  for (const deposit of deposits) {
    console.log('──────────────────────────────────────────────────────────');
    console.log('Processing:', deposit.transferId.slice(0, 16) + '...');
    console.log('  Recipient:', deposit.recipient);
    console.log('  Amount   :', deposit.amount, '(micro)');
    console.log('  Slot     :', deposit.solSlot);

    const msg = canonicalMessage(deposit);
    console.log('  Message  :', msg);

    // Sign with V1 and V2 (DCC Curve25519 — satisfies approval_threshold: 2)
    const msgBytes = new TextEncoder().encode(msg);
    const sig1B58 = signBytes(V1_SEED, msgBytes);
    const sig2B58 = signBytes(V2_SEED, msgBytes);
    const sig1Bytes = base58Decode(sig1B58);
    const sig2Bytes = base58Decode(sig2B58);
    const pk1Bytes  = base58Decode(v1Pub);
    const pk2Bytes  = base58Decode(v2Pub);

    const sig1B64 = Buffer.from(sig1Bytes).toString('base64');
    const sig2B64 = Buffer.from(sig2Bytes).toString('base64');
    const pk1B64  = Buffer.from(pk1Bytes).toString('base64');
    const pk2B64  = Buffer.from(pk2Bytes).toString('base64');

    console.log('  Sig V1   :', sig1B64.slice(0, 32) + '...');
    console.log('  Sig V2   :', sig2B64.slice(0, 32) + '...');

    // Build invokeScript transaction signed with DCC_SEED
    let signedTx;
    try {
      signedTx = invokeScript(
        {
          dApp    : DCC_CONTRACT,
          call    : {
            function : 'committeeMint',
            args     : [
              { type: 'string',  value: deposit.transferId },
              { type: 'string',  value: deposit.recipient  },
              { type: 'integer', value: deposit.amount     },
              { type: 'integer', value: deposit.solSlot    },
              {
                type  : 'list',
                value : [
                  { type: 'binary', value: `base64:${sig1B64}` },
                  { type: 'binary', value: `base64:${sig2B64}` },
                ],
              },
              {
                type  : 'list',
                value : [
                  { type: 'binary', value: `base64:${pk1B64}` },
                  { type: 'binary', value: `base64:${pk2B64}` },
                ],
              },
            ],
          },
          payment  : [],
          fee      : 900000,
          chainId  : DCC_CHAIN_ID,
        },
        DCC_SEED,
      );
    } catch (err) {
      console.error('  ERROR building tx:', err.message);
      continue;
    }

    console.log('  DCC tx ID:', signedTx.id);

    try {
      const result = await broadcast(signedTx, DCC_NODE_URL);
      console.log('  BROADCAST SUCCESS: tx', result.id);
    } catch (err) {
      const detail = err?.response?.data ?? err?.message ?? String(err);
      console.error('  BROADCAST FAILED:', JSON.stringify(detail));
    }
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('Recovery script complete.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
