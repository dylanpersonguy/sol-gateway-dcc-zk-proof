/**
 * E2E Bridge Test — Deposit 0.01 SOL → DCC
 *
 * Sends a real deposit on Solana mainnet targeting a DCC recipient address.
 * The validators will observe the deposit and relay it to DCC.
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

// Target: 0.01 SOL = 10,000,000 lamports
const DEPOSIT_AMOUNT = 10_000_000n;
const DCC_RECIPIENT = '3Da7xwRRtXfkA46jaKTYb75Usd2ZNWdY6HX';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' E2E Bridge Test — Deposit 0.01 SOL → DCC');
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
  if (balance < Number(DEPOSIT_AMOUNT) + 10_000_000) {
    throw new Error(`Insufficient balance. Need at least ${Number(DEPOSIT_AMOUNT + 10_000_000n) / 1e9} SOL`);
  }

  // Derive PDAs
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

  // Read current nonce from user_state (if it exists)
  let nonce = 0n;
  const usInfo = await connection.getAccountInfo(userState);
  if (usInfo && usInfo.data.length >= 48) {
    // UserState layout: disc(8) + user(32) + next_nonce(u64 at offset 40)
    nonce = usInfo.data.readBigUInt64LE(40);
    console.log('Current nonce:', nonce.toString());
  } else {
    console.log('First deposit — nonce: 0');
  }

  // Compute transfer_id = SHA256(sender || nonce_le_bytes)
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

  // Encode DCC recipient as 32 bytes (base58 decode → pad to 32)
  const recipientDecoded = Buffer.from(bs58.decode(DCC_RECIPIENT));
  const recipientBytes = Buffer.alloc(32);
  recipientDecoded.copy(recipientBytes, 0, 0, Math.min(recipientDecoded.length, 32));

  // Serialize DepositParams: recipient_dcc[32] + amount(u64 LE) + transfer_id[32]
  const dp = Buffer.alloc(72);
  recipientBytes.copy(dp, 0);              // 32 bytes: recipient_dcc
  dp.writeBigUInt64LE(DEPOSIT_AMOUNT, 32); // 8 bytes: amount
  transferId.copy(dp, 40);                 // 32 bytes: transfer_id

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

  // Build & send transaction
  console.log();
  console.log('Building transaction...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msgV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msgV0);
  tx.sign([wallet]);

  console.log('Sending deposit transaction...');
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log('Tx Signature:', sig);
  console.log('Explorer:', `https://solscan.io/tx/${sig}`);
  console.log();

  // Wait for confirmation
  console.log('Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    console.error('Transaction FAILED:', confirmation.value.err);
    process.exit(1);
  }

  console.log('✅ Deposit confirmed!');
  console.log();

  // Read the deposit record
  const drInfo = await connection.getAccountInfo(depositRecord);
  if (drInfo) {
    console.log('Deposit Record created:', depositRecord.toBase58());
    console.log('Record data length:', drInfo.data.length, 'bytes');
  }

  // Poll the vault balance
  const vaultBalance = await connection.getBalance(vault);
  console.log('Vault balance:', vaultBalance / 1e9, 'SOL');

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log(' DEPOSIT COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('The validators should now observe this deposit and');
  console.log('relay it to DCC via ZK proof.');
  console.log();
  console.log('Monitor progress:');
  console.log('  curl http://localhost:3000/api/v1/health');
  console.log('  docker compose logs -f validator-1');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
