/**
 * mint-dusd-correction.mjs
 *
 * Emergency correction: the two USDC deposits had their wrong token
 * (wSOL) minted by the old v1 bridge controller.  This script calls
 * mintDusd() on the DUSD stablecoin contract directly to issue the
 * correct DUSD to the recipient.
 *
 * The two transfers are NOT marked as processed in the DUSD contract,
 * so this is valid.  The validator registered in DUSD is derived from
 * seedWithNonce(DCC_SEED, 3).
 *
 * DUSD contract:    3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW
 * DUSD asset ID:    ACmPEtWQLQnZJcvZD7BWrnc4EySyu2kYFzEF8YFRcH9q
 * Validator pubkey: 2dsv1uQsH2WswxX8AHMsMGEJfgnoFY8fgKWgk1tUmYJJ (nonce 3)
 *
 * Run: node mint-dusd-correction.mjs
 */

import { invokeScript, broadcast, libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';
dotenv.config();

const { publicKey, signBytes, base58Decode, seedWithNonce } = libs.crypto;

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_SEED   = process.env.DCC_VALIDATOR_SEED || 'museum solution artwork cherry slab please cage bid race team jacket jar rigid diary pole';
const DCC_NODE    = process.env.DCC_NODE_URL        || 'https://mainnet-node.decentralchain.io';
const CHAIN_ID    = process.env.DCC_CHAIN_ID_CHAR   || '?';

// DUSD contract (nonce 3 from BASE_SEED)
const DUSD_CONTRACT = '3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW';
const USDC_SPL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Signing seeds
const TX_SIGNER_SEED  = BASE_SEED;                       // nonce 0 — pays fees
const VAL_SIGNER_SEED = seedWithNonce(BASE_SEED, 3);     // nonce 3 — registered DUSD validator

// ── Transfers to correct ──────────────────────────────────────────────────────

const transfers = [
  {
    transferId : 'a8d40ac88828a1560e59e3b1c0081e67ab1341ff41d441e452ae63ab1d033c44',
    recipient  : '3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq',
    amount     : 3000000,   // 3 USDC (6 decimals) → 3 DUSD (6 decimals, 1:1)
    solSlot    : 406062538,
    splMint    : USDC_SPL_MINT,
  },
  {
    transferId : '1f168e495a8f9dd36f3e0fe7a9f239906f0615dfe2a4739f9a03b567fd5ae864',
    recipient  : '3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq',
    amount     : 2000000,   // 2 USDC → 2 DUSD
    solSlot    : 406061360,
    splMint    : USDC_SPL_MINT,
  },
];

// ── Message format matching DUSD constructMintMessage ─────────────────────────
// "SOL_DCC_DUSD_V1|MINT_DUSD|{transferId}|{recipient}|{amount}|{solSlot}|{splMint}"

function buildMessage(t) {
  return `SOL_DCC_DUSD_V1|MINT_DUSD|${t.transferId}|${t.recipient}|${t.amount}|${t.solSlot}|${t.splMint}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const valPubKey = publicKey(VAL_SIGNER_SEED);
  const txPubKey  = publicKey(TX_SIGNER_SEED);

  console.log('DUSD Correction Mint');
  console.log('────────────────────────────────────────────────────────');
  console.log('DUSD contract    :', DUSD_CONTRACT);
  console.log('Validator pubkey :', valPubKey);
  console.log('Expected         : 2dsv1uQsH2WswxX8AHMsMGEJfgnoFY8fgKWgk1tUmYJJ');
  console.log('TX sender        :', txPubKey);

  if (valPubKey !== '2dsv1uQsH2WswxX8AHMsMGEJfgnoFY8fgKWgk1tUmYJJ') {
    console.error('ERROR: Validator key mismatch — aborting');
    process.exit(1);
  }
  console.log('Validator key verified ✓\n');

  // Check DUSD contract not paused
  const stateResp = await fetch(`${DCC_NODE}/addresses/data/${DUSD_CONTRACT}?matches=paused|processed_a8d40|processed_1f168`);
  const stateData = await stateResp.json();
  for (const entry of stateData) {
    if (entry.key === 'paused' && entry.value === true) {
      console.error('ERROR: DUSD contract is paused — aborting');
      process.exit(1);
    }
    if (entry.key.startsWith('processed_')) {
      console.error(`ERROR: Transfer already processed in DUSD: ${entry.key} — aborting`);
      process.exit(1);
    }
  }
  console.log('DUSD contract is not paused, transfers not yet processed ✓\n');

  for (const t of transfers) {
    console.log('──────────────────────────────────────────────────────');
    console.log('Transfer :', t.transferId.slice(0, 16) + '...');
    console.log('Recipient:', t.recipient);
    console.log('Amount   :', t.amount, '(micro-USDC → DUSD 1:1)');

    const msg = buildMessage(t);
    console.log('Message  :', msg.slice(0, 80) + '...');

    // Sign with the registered DUSD validator key (nonce 3)
    const msgBytes  = new TextEncoder().encode(msg);
    const sigB58    = signBytes(VAL_SIGNER_SEED, msgBytes);
    const sigBytes  = base58Decode(sigB58);
    const pubBytes  = base58Decode(valPubKey);
    const sigB64    = Buffer.from(sigBytes).toString('base64');
    const pubB64    = Buffer.from(pubBytes).toString('base64');

    console.log('Signature:', sigB64.slice(0, 32) + '...');

    // Build invokeScript — signed by TX_SIGNER_SEED (the DCC_SEED account that pays fees)
    let tx;
    try {
      tx = invokeScript(
        {
          dApp    : DUSD_CONTRACT,
          call    : {
            function : 'mintDusd',
            args     : [
              { type: 'string',  value: t.transferId },
              { type: 'string',  value: t.recipient  },
              { type: 'integer', value: t.amount     },
              { type: 'integer', value: t.solSlot    },
              { type: 'string',  value: t.splMint    },
              {
                type  : 'list',
                value : [{ type: 'binary', value: `base64:${sigB64}` }],
              },
              {
                type  : 'list',
                value : [{ type: 'binary', value: `base64:${pubB64}` }],
              },
            ],
          },
          fee       : 900000,
          chainId   : CHAIN_ID.charCodeAt(0),
          version   : 2,
        },
        TX_SIGNER_SEED,
      );
    } catch (err) {
      console.error('  invokeScript build error:', err.message);
      process.exit(1);
    }

    console.log('  tx.id:', tx.id);

    // Broadcast
    let result;
    try {
      result = await broadcast(tx, DCC_NODE);
    } catch (err) {
      console.error('  BROADCAST FAILED:', err.message);
      process.exit(1);
    }

    if (result.error) {
      console.error('  BROADCAST ERROR:', JSON.stringify(result));
      process.exit(1);
    }

    console.log('  BROADCAST SUCCESS: tx', result.id);

    // Wait for confirmation
    console.log('  Waiting for confirmation...');
    let confirmed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const info = await fetch(`${DCC_NODE}/transactions/info/${result.id}`);
        const data = await info.json();
        if (data.height) {
          console.log(`  Confirmed at height ${data.height}, status: ${data.applicationStatus}`);
          if (data.applicationStatus !== 'succeeded') {
            console.error('  ERROR: Transaction did not succeed!');
            console.error('  State changes:', JSON.stringify(data.stateChanges?.errorMessage || data));
            process.exit(1);
          }
          // Show what was transferred
          for (const xfer of (data.stateChanges?.transfers || [])) {
            console.log(`  Minted: ${xfer.amount} of asset ${xfer.asset} → ${xfer.address}`);
          }
          confirmed = true;
          break;
        }
      } catch (_) {}
    }
    if (!confirmed) {
      console.error('  Timed out waiting for confirmation — check manually: tx', result.id);
    }
    console.log();
  }

  console.log('══════════════════════════════════════════════════════');
  console.log('Done. Check recipient wallet for DUSD tokens:');
  console.log(`  https://mainnet-explorer.decentralchain.io/address/3DUDtobNBs6SAHtpjVrPuBB6L4L6ZshsAjq`);
  console.log('DUSD asset ID: ACmPEtWQLQnZJcvZD7BWrnc4EySyu2kYFzEF8YFRcH9q');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
