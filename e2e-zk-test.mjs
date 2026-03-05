/**
 * E2E ZK Bridge Test — Deposit 0.001234 SOL → DCC via ZK Proof
 *
 * 1. Deposits SOL into the bridge vault on Solana
 * 2. Waits for validator consensus + checkpoint activation
 * 3. Generates ZK proof on host
 * 4. Submits proof to DCC for minting
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=b2d48101-dab0-43d8-863a-2db864a1a059';
const PROGRAM_ID = new PublicKey(process.env.SOLANA_PROGRAM_ID || '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');
const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

// ── Config ──
const DEPOSIT_AMOUNT = 1_234_000n;  // 0.001234 SOL in lamports
const DCC_RECIPIENT = '3DXbZsC9M73r5b8FxJV5YMr5qeq5VNDqwpR';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' E2E ZK Bridge Test — 0.001234 SOL → DCC');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // Load wallet
  const keyPath = process.env.SOLANA_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const keyData = JSON.parse(readFileSync(keyPath, 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keyData));
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Deposit:', Number(DEPOSIT_AMOUNT) / 1e9, 'SOL');
  console.log('DCC Recipient:', DCC_RECIPIENT);
  console.log();

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');
  if (balance < Number(DEPOSIT_AMOUNT) + 5_000_000) {
    throw new Error(`Insufficient balance. Need at least ${(Number(DEPOSIT_AMOUNT) + 5_000_000) / 1e9} SOL`);
  }

  // ── Derive PDAs ──
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')], PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')], PROGRAM_ID
  );
  const [userState] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_state'), wallet.publicKey.toBuffer()], PROGRAM_ID
  );

  console.log('Bridge Config:', bridgeConfig.toBase58());
  console.log('Vault:', vault.toBase58());
  console.log('User State:', userState.toBase58());

  // Read current nonce from UserState
  let nonce = 0n;
  const usInfo = await connection.getAccountInfo(userState);
  if (usInfo && usInfo.data.length >= 48) {
    nonce = usInfo.data.readBigUInt64LE(40);
    console.log('Current nonce:', nonce.toString());
  } else {
    console.log('First deposit — nonce: 0');
  }

  // Compute transfer_id = SHA256(sender || nonce_le)
  const tidBuf = Buffer.alloc(40);
  wallet.publicKey.toBuffer().copy(tidBuf, 0);
  tidBuf.writeBigUInt64LE(nonce, 32);
  const transferId = createHash('sha256').update(tidBuf).digest();
  console.log('Transfer ID:', transferId.toString('hex'));

  // Derive deposit record PDA
  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), transferId], PROGRAM_ID
  );
  console.log('Deposit Record:', depositRecord.toBase58());

  // Encode DCC recipient as 32 bytes
  const recipientDecoded = Buffer.from(bs58.decode(DCC_RECIPIENT));
  const recipientBytes = Buffer.alloc(32);
  recipientDecoded.copy(recipientBytes, 0, 0, Math.min(recipientDecoded.length, 32));

  // Serialize: recipient_dcc[32] + amount(u64 LE) + transfer_id[32]
  const dp = Buffer.alloc(72);
  recipientBytes.copy(dp, 0);
  dp.writeBigUInt64LE(DEPOSIT_AMOUNT, 32);
  transferId.copy(dp, 40);

  // Build instruction
  const ix = new TransactionInstruction({
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

  // Build & send
  console.log();
  console.log('📤 Sending deposit transaction...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msgV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msgV0);
  tx.sign([wallet]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log('Tx Signature:', sig);
  console.log('Explorer:', `https://solscan.io/tx/${sig}`);
  console.log();

  // Wait for confirmation
  console.log('⏳ Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    console.error('❌ Transaction FAILED:', confirmation.value.err);
    process.exit(1);
  }

  console.log('✅ Deposit confirmed on Solana!');
  console.log();

  // Verify deposit record
  const drInfo = await connection.getAccountInfo(depositRecord);
  if (drInfo) {
    console.log('Deposit Record PDA:', depositRecord.toBase58());
    console.log('Record size:', drInfo.data.length, 'bytes');
  }

  const vaultBalance = await connection.getBalance(vault);
  console.log('Vault balance:', vaultBalance / 1e9, 'SOL');

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log(' STEP 1 COMPLETE — Deposit on Solana');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Next steps:');
  console.log('  1. Validators will detect deposit and reach consensus');
  console.log('  2. A checkpoint will be proposed → approved → activated');
  console.log('  3. Run: node --max-old-space-size=8192 generate-proof-host.mjs');
  console.log('     to generate ZK proof and submit to DCC');
  console.log();
  console.log('Monitor validators:');
  console.log('  curl -s http://localhost:8080/health | jq .');
  console.log('  docker compose logs -f validator-1 --tail 50');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
