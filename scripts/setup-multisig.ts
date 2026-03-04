/**
 * Squads Protocol Multisig Setup for Bridge Authority
 *
 * Creates a 2-of-3 (or M-of-N) multisig using Squads V4 and transfers
 * the bridge program's authority + guardian role to the multisig.
 *
 * Prerequisites:
 *   npm i @sqds/multisig @solana/web3.js
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   DEPLOYER_KEY_PATH=~/.config/solana/deployer.json \
 *   MEMBER_1_PUBKEY=<base58> \
 *   MEMBER_2_PUBKEY=<base58> \
 *   MEMBER_3_PUBKEY=<base58> \
 *   THRESHOLD=2 \
 *   npx ts-node scripts/setup-multisig.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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

// ── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || 'http://localhost:8899';
const DEPLOYER_KEY_PATH = required('DEPLOYER_KEY_PATH');
const PROGRAM_ID_STR = process.env.SOLANA_PROGRAM_ID || 'BRLockv1ViZ7r48ehk2Ru1YDw6kGXhZ3VPmqMFkGfB1s';

const MEMBER_PUBKEYS = [
  required('MEMBER_1_PUBKEY'),
  required('MEMBER_2_PUBKEY'),
  required('MEMBER_3_PUBKEY'),
].map((pk) => new PublicKey(pk));

const THRESHOLD = parseInt(process.env.THRESHOLD || '2', 10);
const TIME_LOCK = parseInt(process.env.TIME_LOCK_SECONDS || '86400', 10); // 24h default

// ── Bridge Program Addresses ────────────────────────────────────────────────

const programId = new PublicKey(PROGRAM_ID_STR);

const [bridgeConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('bridge_config')],
  programId,
);

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Squads Multisig Setup for Bridge Authority');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  const connection = new Connection(RPC_URL, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_KEY_PATH);

  console.log('Deployer:      ', deployer.publicKey.toBase58());
  console.log('Program ID:    ', programId.toBase58());
  console.log('Bridge Config: ', bridgeConfigPda.toBase58());
  console.log('Threshold:     ', `${THRESHOLD}-of-${MEMBER_PUBKEYS.length}`);
  console.log('Time Lock:     ', `${TIME_LOCK}s (${TIME_LOCK / 3600}h)`);
  console.log('Members:');
  MEMBER_PUBKEYS.forEach((pk, i) => console.log(`  ${i + 1}. ${pk.toBase58()}`));
  console.log();

  // ── Step 1: Create the Multisig ─────────────────────────────────────────

  console.log('Step 1: Creating Squads multisig...');

  // Derive a deterministic create key from the deployer + timestamp
  const createKeySeed = createHash('sha256')
    .update(deployer.publicKey.toBuffer())
    .update(Buffer.from('bridge_multisig'))
    .digest();
  const createKey = Keypair.fromSeed(createKeySeed);

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });

  console.log('  Multisig PDA: ', multisigPda.toBase58());
  console.log('  Create Key:   ', createKey.publicKey.toBase58());

  // Build the members list
  const members: multisig.types.Member[] = MEMBER_PUBKEYS.map((key) => ({
    key,
    permissions: multisig.types.Permissions.all(),
  }));

  const createMultisigIx = multisig.instructions.multisigCreateV2({
    createKey: createKey.publicKey,
    creator: deployer.publicKey,
    multisigPda,
    configAuthority: null, // Immutable config — no single key can change the multisig
    timeLock: TIME_LOCK,
    threshold: THRESHOLD,
    members,
    rentCollector: null,
    treasury: multisigPda,
    memo: 'sol-gateway-dcc bridge authority multisig',
  });

  const { blockhash: bh1 } = await connection.getLatestBlockhash('confirmed');
  const msg1 = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: bh1,
    instructions: [createMultisigIx],
  }).compileToV0Message();

  const tx1 = new VersionedTransaction(msg1);
  tx1.sign([deployer, createKey]);

  const sig1 = await connection.sendRawTransaction(tx1.serialize());
  console.log('  Tx:', sig1);
  await connection.confirmTransaction(sig1, 'confirmed');
  console.log('  ✅ Multisig created!\n');

  // ── Step 2: Transfer Bridge Authority to Multisig ───────────────────────

  console.log('Step 2: Transferring bridge authority to multisig...');
  console.log('  This calls update_config on the bridge program.');
  console.log('  New authority = multisig vault PDA');

  // The Squads vault PDA is what signs transactions on behalf of the multisig
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: 0,
  });
  console.log('  Vault PDA:    ', vaultPda.toBase58());

  // Build the Anchor instruction to call update_config(new_authority)
  // Discriminator for "update_config" = sha256("global:update_config")[0..8]
  const updateConfigDisc = createHash('sha256')
    .update('global:update_config')
    .digest()
    .subarray(0, 8);

  // Encode the instruction data:
  // [8 bytes discriminator] [32 bytes new_authority pubkey]
  const updateConfigData = Buffer.concat([
    updateConfigDisc,
    vaultPda.toBuffer(),
  ]);

  const updateConfigIx = {
    programId,
    keys: [
      { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
      { pubkey: deployer.publicKey, isWritable: false, isSigner: true },
    ],
    data: updateConfigData,
  };

  const { blockhash: bh2 } = await connection.getLatestBlockhash('confirmed');
  const msg2 = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: bh2,
    instructions: [updateConfigIx],
  }).compileToV0Message();

  const tx2 = new VersionedTransaction(msg2);
  tx2.sign([deployer]);

  const sig2 = await connection.sendRawTransaction(tx2.serialize());
  console.log('  Tx:', sig2);
  await connection.confirmTransaction(sig2, 'confirmed');
  console.log('  ✅ Authority transferred to multisig!\n');

  // ── Step 3: Transfer Guardian Role to Multisig ──────────────────────────

  console.log('Step 3: Transferring guardian role to multisig...');

  const updateGuardianDisc = createHash('sha256')
    .update('global:update_guardian')
    .digest()
    .subarray(0, 8);

  const updateGuardianData = Buffer.concat([
    updateGuardianDisc,
    vaultPda.toBuffer(),
  ]);

  const updateGuardianIx = {
    programId,
    keys: [
      { pubkey: bridgeConfigPda, isWritable: true, isSigner: false },
      { pubkey: deployer.publicKey, isWritable: false, isSigner: true },
    ],
    data: updateGuardianData,
  };

  const { blockhash: bh3 } = await connection.getLatestBlockhash('confirmed');
  const msg3 = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: bh3,
    instructions: [updateGuardianIx],
  }).compileToV0Message();

  const tx3 = new VersionedTransaction(msg3);
  tx3.sign([deployer]);

  const sig3 = await connection.sendRawTransaction(tx3.serialize());
  console.log('  Tx:', sig3);
  await connection.confirmTransaction(sig3, 'confirmed');
  console.log('  ✅ Guardian transferred to multisig!\n');

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════');
  console.log('  MULTISIG SETUP COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Multisig PDA:     ', multisigPda.toBase58());
  console.log('Vault PDA:        ', vaultPda.toBase58());
  console.log('Threshold:        ', `${THRESHOLD}-of-${MEMBER_PUBKEYS.length}`);
  console.log('Time Lock:        ', `${TIME_LOCK}s`);
  console.log('Bridge Authority: ', vaultPda.toBase58());
  console.log('Bridge Guardian:  ', vaultPda.toBase58());
  console.log();
  console.log('Add to .env:');
  console.log(`MULTISIG_PDA=${multisigPda.toBase58()}`);
  console.log(`MULTISIG_VAULT_PDA=${vaultPda.toBase58()}`);
  console.log();
  console.log('⚠️  IMPORTANT: The deployer key no longer has authority.');
  console.log('   All admin operations now require multisig approval.');
  console.log();
  console.log('To propose a transaction through the multisig:');
  console.log('   npx ts-node scripts/propose-multisig-tx.ts');
}

// ── Example: How to Propose a Multisig Transaction ──────────────────────────

export async function proposeMultisigTransaction(
  connection: Connection,
  proposer: Keypair,
  multisigPda: PublicKey,
  instructions: { programId: PublicKey; keys: any[]; data: Buffer }[],
  memo: string,
): Promise<string> {
  // Get current transaction index
  const msAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  const transactionIndex = Number(msAccount.transactionIndex) + 1;

  // Create the vault transaction
  const createTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    creator: proposer.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: proposer.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: instructions as any,
    }),
    memo,
  });

  // Create the proposal
  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    creator: proposer.publicKey,
  });

  // Approve the proposal (proposer auto-approves)
  const approveIx = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex: BigInt(transactionIndex),
    member: proposer.publicKey,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: proposer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createTxIx, proposalIx, approveIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([proposer]);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');

  console.log(`Proposed transaction #${transactionIndex}`);
  console.log(`  Tx: ${sig}`);
  console.log(`  Needs ${msAccount.threshold - 1} more approval(s) to execute`);

  return sig;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
