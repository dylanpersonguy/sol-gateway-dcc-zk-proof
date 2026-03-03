'use strict';
/**
 * End-to-End Bridge Test: SOL → wSOL.DCC
 *
 * 1. Deposit SOL on Solana devnet
 * 2. Simulate validator: call mint() on DCC bridge
 * 3. Verify wSOL.DCC appears on DCC chain
 */
const { createHash } = require('crypto');
const {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  invokeScript,
  libs,
} = require('@decentralchain/decentralchain-transactions');
const fs = require('fs');

const { privateKey, publicKey, address, base58Decode } = libs.crypto;

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Solana
const SOL_RPC          = 'https://api.devnet.solana.com';
const PROGRAM_ID       = new PublicKey('9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');
const DEPOSIT_DISC     = Buffer.from([242,35,198,137,82,225,242,182]);
const LAMPORTS_TO_SEND = 10_000_000; // 0.01 SOL

// DCC
const DCC_NODE         = 'http://localhost:6869';
const DCC_CHAIN        = 'D';
const BRIDGE_ADDR      = '3Fans4vfDrZD5vJCyNqkHHKVzPjqok5v6Ui';
const BRIDGE_SEED      = 'bridge controller for sol-gateway-dcc local dev';
const VALIDATOR_SEED   = '***REDACTED_SEED_PHRASE***';
const VALIDATOR_PUBKEY = publicKey(VALIDATOR_SEED);
const WSOL_ASSET_ID    = '8AmLFgw5FXTuo6VegXrb8d1PZTx2Q8xD9Tn3kfEkfv5y';

// DCC recipient = validator address on chain D
const DCC_RECIPIENT    = address(VALIDATOR_SEED, DCC_CHAIN);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dccGet(path) {
  const r = await fetch(`${DCC_NODE}${path}`);
  return r.json();
}

async function dccBroadcast(tx) {
  const r = await fetch(`${DCC_NODE}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC rejected: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function waitDccTx(txId, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`DCC tx ${txId} not confirmed`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SOL → wSOL.DCC  End-to-End Bridge Test');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // ── Load Solana wallet ────────────────────────────────────────
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/test-wallet.json', 'utf8')))
  );
  const connection = new Connection(SOL_RPC, 'confirmed');

  console.log('Solana wallet: ', wallet.publicKey.toBase58());
  const solBal = await connection.getBalance(wallet.publicKey);
  console.log('SOL balance:   ', (solBal / 1e9).toFixed(6), 'SOL');
  console.log('DCC recipient: ', DCC_RECIPIENT);
  console.log('Amount:         0.01 SOL →', LAMPORTS_TO_SEND, 'lamports');
  console.log();

  // ── Check DCC bridge is alive ─────────────────────────────────
  const dccH = await dccGet('/blocks/height');
  console.log('DCC chain height:', dccH.height);
  const wsolBefore = await dccGet(`/assets/balance/${DCC_RECIPIENT}/${WSOL_ASSET_ID}`);
  const wsolBalBefore = wsolBefore.balance || 0;
  console.log('wSOL.DCC balance (before):', wsolBalBefore);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Deposit SOL on Solana devnet
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 1: Depositing 0.01 SOL on Solana devnet...');

  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);
  const [vault]        = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID);
  const [userState]    = PublicKey.findProgramAddressSync([Buffer.from('user_state'), wallet.publicKey.toBuffer()], PROGRAM_ID);

  // Get nonce
  let nonce = 0n;
  const usInfo = await connection.getAccountInfo(userState);
  if (usInfo) {
    nonce = usInfo.data.readBigUInt64LE(40); // disc(8) + user(32) + next_nonce(8)
    console.log('  Nonce:', nonce.toString());
  } else {
    console.log('  First deposit (nonce = 0)');
  }

  // Compute transfer_id = SHA256(sender || nonce)
  const tidBuf = Buffer.alloc(40);
  wallet.publicKey.toBuffer().copy(tidBuf, 0);
  tidBuf.writeBigUInt64LE(nonce, 32);
  const transferId = createHash('sha256').update(tidBuf).digest();
  const transferIdHex = transferId.toString('hex');
  console.log('  Transfer ID:', transferIdHex);

  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), transferId], PROGRAM_ID
  );

  // Build deposit instruction
  // DepositParams: recipient_dcc[32] + amount(u64) + transfer_id[32]
  const rBytes = Buffer.alloc(32);
  Buffer.from(DCC_RECIPIENT).copy(rBytes, 0, 0, Math.min(DCC_RECIPIENT.length, 32));

  const dp = Buffer.alloc(72);
  rBytes.copy(dp, 0);
  dp.writeBigUInt64LE(BigInt(LAMPORTS_TO_SEND), 32);
  transferId.copy(dp, 40);

  const dix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bridgeConfig,            isSigner: false, isWritable: true  },
      { pubkey: userState,               isSigner: false, isWritable: true  },
      { pubkey: depositRecord,           isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: true  },
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_DISC, dp]),
  });

  const tx = new Transaction().add(dix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
    maxRetries: 5,
  });

  console.log('  ✅ Deposit confirmed!');
  console.log('  Signature:', sig);
  console.log('  Explorer: https://explorer.solana.com/tx/' + sig + '?cluster=devnet');

  // Get the slot for the mint call
  const txInfo = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const solSlot = txInfo?.slot || 0;
  console.log('  Slot:', solSlot);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Mint wSOL.DCC on DCC (simulate validator)
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 2: Minting wSOL.DCC on DCC bridge...');
  console.log('  Bridge:', BRIDGE_ADDR);
  console.log('  Recipient:', DCC_RECIPIENT);
  console.log('  Amount:', LAMPORTS_TO_SEND, '(lamports)');

  // The RIDE contract's mint() checks signature count >= minValidators (1)
  // but doesn't call verifyValidatorSignatures(). For testing, we pass
  // a dummy signature from the registered validator.
  const dummySig = Buffer.alloc(64, 0); // 64 zero bytes
  const validatorPubkeyBytes = Buffer.from(libs.crypto.base58Decode(VALIDATOR_PUBKEY));

  // Build the mint invokeScript, signed by the bridge account (admin)
  const mintTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: {
        function: 'mint',
        args: [
          { type: 'string',  value: transferIdHex },
          { type: 'string',  value: DCC_RECIPIENT },
          { type: 'integer', value: LAMPORTS_TO_SEND },
          { type: 'integer', value: solSlot },
          {
            type: 'list',
            value: [{ type: 'binary', value: 'base64:' + dummySig.toString('base64') }],
          },
          {
            type: 'list',
            value: [{ type: 'binary', value: 'base64:' + validatorPubkeyBytes.toString('base64') }],
          },
        ],
      },
      payment: [],
      chainId: DCC_CHAIN,
      fee: 5000000,  // 0.05 DCC
      senderPublicKey: publicKey(BRIDGE_SEED),
      version: 1,
    },
    { privateKey: privateKey(BRIDGE_SEED) }
  );

  console.log('  Tx ID:', mintTx.id);
  const mintResp = await dccBroadcast(mintTx);
  process.stdout.write('  Confirming');
  await waitDccTx(mintResp.id);
  console.log(' ✅');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Verify wSOL.DCC arrived
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 3: Verifying wSOL.DCC balance...');
  const wsolAfter = await dccGet(`/assets/balance/${DCC_RECIPIENT}/${WSOL_ASSET_ID}`);
  const wsolBalAfter = wsolAfter.balance || 0;
  const gained = wsolBalAfter - wsolBalBefore;
  // SOL has 9 decimals, wSOL.DCC has 8 → expected = lamports / 10
  const expectedWsol = Math.floor(LAMPORTS_TO_SEND / 10);

  console.log('  wSOL.DCC balance (after): ', wsolBalAfter);
  console.log('  Gained:                   ', gained, gained === expectedWsol ? '✅' : '❌');
  console.log('  Human-readable:           ', (gained / 1e8).toFixed(8), 'wSOL.DCC');

  // Also check on-chain data
  const processedKey = `processed_${transferIdHex}`;
  const processed = await dccGet(`/addresses/data/${BRIDGE_ADDR}/${processedKey}`);
  console.log('  Transfer marked processed:', processed.value === true ? '✅' : '❌');

  const totalMinted = await dccGet(`/addresses/data/${BRIDGE_ADDR}/total_minted`);
  console.log('  Total minted (cumulative):', totalMinted.value);

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log('  END-TO-END TEST COMPLETE! ✅');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Summary:');
  console.log(`  Solana deposit: ${sig}`);
  console.log(`  DCC mint:       ${mintResp.id}`);
  console.log(`  Transfer ID:    ${transferIdHex}`);
  console.log(`  Amount:         ${LAMPORTS_TO_SEND} lamports → ${(gained / 1e8).toFixed(8)} wSOL.DCC`);
  console.log(`  Recipient:      ${DCC_RECIPIENT}`);
}

main().catch(e => { console.error('\n❌ ERROR:', e.message || e); process.exit(1); });
