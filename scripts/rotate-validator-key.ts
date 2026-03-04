/**
 * Validator Key Rotation Script
 *
 * Performs zero-downtime Ed25519 key rotation for bridge validators.
 *
 * Strategy:
 *   1. Generate new validator keypair
 *   2. Register new key on Solana (register_validator)
 *   3. Register new key on DCC (registerValidator)
 *   4. Update validator service config to sign with new key
 *   5. Verify new key is producing valid attestations
 *   6. Remove old key on Solana (remove_validator)
 *   7. Remove old key on DCC (removeValidator)
 *   8. Archive old key securely
 *
 * Both keys are active simultaneously during steps 2–5, ensuring
 * zero downtime and no missed attestations.
 *
 * Usage:
 *   SOLANA_RPC_URL=<url> \
 *   SOLANA_PROGRAM_ID=<pubkey> \
 *   AUTHORITY_KEY_PATH=<path> \
 *   OLD_VALIDATOR_PUBKEY=<base58> \
 *   DCC_NODE_URL=<url> \
 *   DCC_BRIDGE_CONTRACT=<address> \
 *   DCC_AUTHORITY_SEED=<seed> \
 *   npx ts-node scripts/rotate-validator-key.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// ── Helpers ─────────────────────────────────────────────────────────────────

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function loadKeypair(keyPath: string): Keypair {
  const resolved = keyPath.startsWith('~')
    ? path.join(process.env.HOME!, keyPath.slice(1))
    : keyPath;
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

// ── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || 'http://localhost:8899';
const PROGRAM_ID = new PublicKey(required('SOLANA_PROGRAM_ID'));
const AUTHORITY_KEY_PATH = required('AUTHORITY_KEY_PATH');
const OLD_VALIDATOR_PUBKEY = new PublicKey(required('OLD_VALIDATOR_PUBKEY'));
const DCC_NODE_URL = required('DCC_NODE_URL');
const DCC_BRIDGE_CONTRACT = required('DCC_BRIDGE_CONTRACT');
const DCC_AUTHORITY_SEED = required('DCC_AUTHORITY_SEED');
const DCC_CHAIN_ID = process.env.DCC_CHAIN_ID_CHAR || '?';

// Output path for new keypair
const NEW_KEY_OUTPUT_DIR = process.env.NEW_KEY_OUTPUT_DIR || './keys';

// ── PDAs ────────────────────────────────────────────────────────────────────

const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('bridge_config')],
  PROGRAM_ID,
);

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Validator Key Rotation — Zero Downtime');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  const connection = new Connection(RPC_URL, 'confirmed');
  const authority = loadKeypair(AUTHORITY_KEY_PATH);

  console.log('Authority:         ', authority.publicKey.toBase58());
  console.log('Old Validator Key: ', OLD_VALIDATOR_PUBKEY.toBase58());
  console.log('Program ID:        ', PROGRAM_ID.toBase58());
  console.log();

  // ── Step 1: Generate New Keypair ──────────────────────────────────────

  console.log('Step 1: Generating new validator keypair...');
  const newValidator = Keypair.generate();
  console.log('  New Public Key: ', newValidator.publicKey.toBase58());

  // Save the new keypair
  if (!fs.existsSync(NEW_KEY_OUTPUT_DIR)) {
    fs.mkdirSync(NEW_KEY_OUTPUT_DIR, { recursive: true });
  }
  const keyFilePath = path.join(
    NEW_KEY_OUTPUT_DIR,
    `validator-${newValidator.publicKey.toBase58().slice(0, 8)}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    keyFilePath,
    JSON.stringify(Array.from(newValidator.secretKey)),
    { mode: 0o600 }, // read/write only by owner
  );
  console.log('  Saved to:       ', keyFilePath);
  console.log();

  // ── Step 2: Register New Key on Solana ────────────────────────────────

  console.log('Step 2: Registering new key on Solana...');
  
  const [newValidatorEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from('validator'), newValidator.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const registerDisc = anchorDiscriminator('register_validator');
  const registerData = Buffer.concat([
    registerDisc,
    newValidator.publicKey.toBuffer(),
  ]);

  const registerIx = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
      { pubkey: newValidatorEntry, isWritable: true, isSigner: false },
      { pubkey: authority.publicKey, isWritable: true, isSigner: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isWritable: false, isSigner: false }, // System program
    ],
    data: registerData,
  };

  const { blockhash: bh1 } = await connection.getLatestBlockhash('confirmed');
  const msg1 = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: bh1,
    instructions: [registerIx],
  }).compileToV0Message();

  const tx1 = new VersionedTransaction(msg1);
  tx1.sign([authority]);

  const sig1 = await connection.sendRawTransaction(tx1.serialize());
  console.log('  Tx:', sig1);
  await connection.confirmTransaction(sig1, 'confirmed');
  console.log('  ✅ New key registered on Solana');
  console.log();

  // ── Step 3: Register New Key on DCC ───────────────────────────────────

  console.log('Step 3: Registering new key on DCC...');
  
  try {
    const { invokeScript, libs } = await import('@decentralchain/decentralchain-transactions');
    const { privateKey, publicKey } = libs.crypto;
    
    const dccSigner = { privateKey: privateKey(DCC_AUTHORITY_SEED) };
    const dccPubKey = publicKey(DCC_AUTHORITY_SEED);

    const regTx = invokeScript({
      dApp: DCC_BRIDGE_CONTRACT,
      call: {
        function: 'registerValidator',
        args: [
          { type: 'string', value: newValidator.publicKey.toBase58() },
        ],
      },
      payment: [],
      chainId: DCC_CHAIN_ID,
      fee: 500000,
      senderPublicKey: dccPubKey,
    }, dccSigner);

    const resp = await axios.post(`${DCC_NODE_URL}/transactions/broadcast`, regTx, {
      timeout: 15000,
    });
    console.log('  DCC Tx ID:', resp.data?.id || 'unknown');
    console.log('  ✅ New key registered on DCC');
  } catch (err: any) {
    console.error('  ⚠️  DCC registration failed:', err.message);
    console.error('  You may need to register manually on DCC.');
  }
  console.log();

  // ── Step 4: Transition Period ─────────────────────────────────────────

  console.log('Step 4: TRANSITION PERIOD');
  console.log('  Both old and new keys are now active.');
  console.log('  ');
  console.log('  ACTION REQUIRED:');
  console.log('  1. Update your validator service config to use the new key:');
  console.log(`     VALIDATOR_KEY_PATH=${keyFilePath}`);
  console.log('  2. Restart the validator service');
  console.log('  3. Verify the new key is producing valid attestations');
  console.log('  4. Wait at least 10 minutes to confirm stability');
  console.log('  ');
  console.log('  When ready, run this script again with --remove-old to remove the old key.');
  console.log();

  // Check if the user passed --remove-old flag
  if (process.argv.includes('--remove-old')) {
    await removeOldKey(connection, authority);
  } else {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ROTATION PHASE 1 COMPLETE');
    console.log('═══════════════════════════════════════════════════');
    console.log();
    console.log('New validator keypair:', keyFilePath);
    console.log('New public key:       ', newValidator.publicKey.toBase58());
    console.log();
    console.log('To complete rotation (remove old key), run:');
    console.log('  npx ts-node scripts/rotate-validator-key.ts --remove-old');
  }
}

// ── Remove Old Key ──────────────────────────────────────────────────────────

async function removeOldKey(
  connection: Connection,
  authority: Keypair,
): Promise<void> {
  console.log('Step 5: Removing old key from Solana...');

  const [oldValidatorEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from('validator'), OLD_VALIDATOR_PUBKEY.toBuffer()],
    PROGRAM_ID,
  );

  const removeDisc = anchorDiscriminator('remove_validator');
  const removeData = Buffer.concat([
    removeDisc,
    OLD_VALIDATOR_PUBKEY.toBuffer(),
  ]);

  const removeIx = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
      { pubkey: oldValidatorEntry, isWritable: true, isSigner: false },
      { pubkey: authority.publicKey, isWritable: true, isSigner: true },
    ],
    data: removeData,
  };

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [removeIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([authority]);

  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log('  Tx:', sig);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('  ✅ Old key removed from Solana');
  console.log();

  // ── Remove from DCC ──────────────────────────────────────────────────

  console.log('Step 6: Removing old key from DCC...');

  try {
    const { invokeScript, libs } = await import('@decentralchain/decentralchain-transactions');
    const { privateKey, publicKey } = libs.crypto;

    const dccSigner = { privateKey: privateKey(DCC_AUTHORITY_SEED) };
    const dccPubKey = publicKey(DCC_AUTHORITY_SEED);

    const removeTx = invokeScript({
      dApp: DCC_BRIDGE_CONTRACT,
      call: {
        function: 'removeValidator',
        args: [
          { type: 'string', value: OLD_VALIDATOR_PUBKEY.toBase58() },
        ],
      },
      payment: [],
      chainId: DCC_CHAIN_ID,
      fee: 500000,
      senderPublicKey: dccPubKey,
    }, dccSigner);

    const resp = await axios.post(`${DCC_NODE_URL}/transactions/broadcast`, removeTx, {
      timeout: 15000,
    });
    console.log('  DCC Tx ID:', resp.data?.id || 'unknown');
    console.log('  ✅ Old key removed from DCC');
  } catch (err: any) {
    console.error('  ⚠️  DCC removal failed:', err.message);
    console.error('  You may need to remove manually on DCC.');
  }

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log('  KEY ROTATION COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Old key (removed):', OLD_VALIDATOR_PUBKEY.toBase58());
  console.log();
  console.log('⚠️  SECURITY: Archive and destroy the old key file.');
  console.log('   The old key should not be reused.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
