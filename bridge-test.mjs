import { createHash } from 'crypto';
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import fs from 'fs';

const INIT_DISC    = Buffer.from([175,175,109,31,13,152,155,237]);
const DEPOSIT_DISC = Buffer.from([242,35,198,137,82,225,242,182]);
const RPC_URL       = 'https://api.devnet.solana.com';
const PROGRAM_ID    = new PublicKey('9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');
const RECIPIENT_DCC = '3DZazDXzgUZ3gcueJ3wQNqSmwB3wKc4jHuz';
const LAMPORTS      = 10_000_000; // 0.01 SOL

const wallet     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/test-wallet.json','utf8'))));
const connection = new Connection(RPC_URL, 'confirmed');

console.log('Wallet:   ', wallet.publicKey.toBase58());
console.log('Amount:    0.01 SOL ->', LAMPORTS, 'lamports');
console.log('Recipient:', RECIPIENT_DCC);
console.log();

const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);
const [vault]        = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID);
const [userState]    = PublicKey.findProgramAddressSync([Buffer.from('user_state'), wallet.publicKey.toBuffer()], PROGRAM_ID);

// ── STEP 1: Initialize bridge_config if needed ────────────────────────────────
const cfgInfo = await connection.getAccountInfo(bridgeConfig);
if (!cfgInfo) {
  console.log('Initializing bridge_config...');
  // InitializeParams (Borsh): guardian[32] u8 u8 u64 u64 u64 u64 u16 i64 u64 u32 u32
  const p = Buffer.alloc(94);
  let o = 0;
  wallet.publicKey.toBuffer().copy(p, o); o += 32;   // guardian
  p.writeUInt8(1, o); o += 1;                         // min_validators
  p.writeUInt8(5, o); o += 1;                         // max_validators
  p.writeBigUInt64LE(1_000_000n, o); o += 8;          // min_deposit (0.001 SOL)
  p.writeBigUInt64LE(100_000_000_000n, o); o += 8;    // max_deposit (100 SOL)
  p.writeBigUInt64LE(1_000_000_000_000n, o); o += 8;  // max_daily_outflow
  p.writeBigUInt64LE(100_000_000_000n, o); o += 8;    // max_unlock_amount
  p.writeUInt16LE(32, o); o += 2;                     // required_confirmations
  p.writeBigInt64LE(3600n, o); o += 8;                // large_withdrawal_delay
  p.writeBigUInt64LE(10_000_000_000n, o); o += 8;     // large_withdrawal_threshold
  p.writeUInt32LE(1, o); o += 4;                      // dcc_chain_id
  p.writeUInt32LE(2, o); o += 4;                      // solana_chain_id

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bridgeConfig,            isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INIT_DISC, p]),
  });

  const tx = new Transaction().add(ix);
  const { blockhash: bh } = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh;
  tx.feePayer = wallet.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
  console.log('Bridge initialized! Sig:', sig);
  console.log('https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  console.log();
} else {
  console.log('bridge_config already initialized');
}

// ── STEP 2: compute transfer_id = SHA256(sender_bytes || nonce_le8) ───────────
let nonce = 0n;
const usInfo = await connection.getAccountInfo(userState);
if (usInfo) {
  nonce = usInfo.data.readBigUInt64LE(40); // discriminator(8) + user(32) + next_nonce(8)
  console.log('Nonce:', nonce.toString());
} else {
  console.log('First deposit for this wallet (nonce = 0)');
}

const tidBuf = Buffer.alloc(40);
wallet.publicKey.toBuffer().copy(tidBuf, 0);
tidBuf.writeBigUInt64LE(nonce, 32);
const transferId = createHash('sha256').update(tidBuf).digest();
console.log('Transfer ID:', transferId.toString('hex'));

const [depositRecord] = PublicKey.findProgramAddressSync(
  [Buffer.from('deposit'), transferId], PROGRAM_ID
);
console.log('Deposit record:', depositRecord.toBase58());
console.log();

// ── STEP 3: Build & send deposit instruction ──────────────────────────────────
// DepositParams (Borsh): recipient_dcc[32] + amount(u64) + transfer_id[32]
const rBytes = Buffer.alloc(32);
Buffer.from(RECIPIENT_DCC).copy(rBytes, 0, 0, Math.min(RECIPIENT_DCC.length, 32));

const dp = Buffer.alloc(72);
rBytes.copy(dp, 0);
dp.writeBigUInt64LE(BigInt(LAMPORTS), 32);
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

console.log('Submitting deposit...');
const dtx = new Transaction().add(dix);
const { blockhash: bh2 } = await connection.getLatestBlockhash();
dtx.recentBlockhash = bh2;
dtx.feePayer = wallet.publicKey;

const dsig = await sendAndConfirmTransaction(connection, dtx, [wallet], {
  commitment: 'confirmed',
  maxRetries: 5,
});

console.log();
console.log('================================================');
console.log('  DEPOSIT CONFIRMED!');
console.log('================================================');
console.log('Signature:', dsig);
console.log('Explorer: https://explorer.solana.com/tx/' + dsig + '?cluster=devnet');
console.log();

const [recInfo, vaultBal] = await Promise.all([
  connection.getAccountInfo(depositRecord),
  connection.getBalance(vault),
]);
console.log('Deposit record created on-chain:', !!recInfo);
console.log('Vault balance:                  ', (vaultBal / 1e9).toFixed(6), 'SOL');
console.log();
console.log('Validator will observe the BridgeDeposit event and mint wSOL.DCC to:');
console.log(RECIPIENT_DCC);
