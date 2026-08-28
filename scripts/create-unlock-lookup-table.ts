#!/usr/bin/env ts-node

/**
 * create-unlock-lookup-table.ts
 *
 * Creates the Address Lookup Table the unlock path needs.
 *
 * An unlock carries ~13 account keys at 32 bytes each. With min_validators = 3
 * the transaction measures ~1395 bytes against Solana's 1232-byte limit, so it
 * cannot be submitted at all. Referencing the static accounts through a lookup
 * table costs 1 byte each instead of 32 and brings it to ~1147.
 *
 * Only genuinely static accounts go in. The payer must stay a static key
 * because it signs, and the recipient and unlock-record PDA differ per
 * transfer.
 *
 * Usage:
 *   ts-node scripts/create-unlock-lookup-table.ts            # show what it would do
 *   ts-node scripts/create-unlock-lookup-table.ts --broadcast
 */

import {
  Connection, PublicKey, Keypair, AddressLookupTableProgram,
  TransactionMessage, VersionedTransaction, SystemProgram,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ED25519_PROGRAM = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  const rpc = process.env.SOLANA_RPC_URL!;
  const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID!);

  const authorityPath = process.env.ALT_AUTHORITY_KEYPAIR_PATH
    || `${process.env.HOME}/.config/solana/deployer.json`;
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, 'utf-8'))),
  );

  const conn = new Connection(rpc, 'confirmed');

  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);

  // Every registered validator's entry PDA, read from the program itself so the
  // table matches the on-chain validator set rather than a hardcoded list.
  const VALIDATOR_ENTRY_LEN = 66;
  const validatorEntries = (await conn.getProgramAccounts(programId))
    .filter((a) => a.account.data.length === VALIDATOR_ENTRY_LEN)
    .map((a) => new PublicKey(a.account.data.subarray(8, 40)));

  const validatorPdas = validatorEntries.map(
    (v) => PublicKey.findProgramAddressSync([Buffer.from('validator'), v.toBuffer()], programId)[0],
  );

  const addresses = [
    programId,
    bridgeConfig,
    vault,
    SystemProgram.programId,
    ED25519_PROGRAM,
    INSTRUCTIONS_SYSVAR,
    ...validatorPdas,
  ];

  console.log('=== unlock lookup table ===');
  console.log('  authority :', authority.publicKey.toBase58());
  console.log('  addresses :', addresses.length);
  for (const a of addresses) console.log('    ', a.toBase58());
  console.log(`\n  saves ~${addresses.length * 31} bytes per unlock transaction`);

  if (!broadcast) {
    console.log('\nDry run. Re-run with --broadcast to create it.');
    return;
  }

  const slot = await conn.getSlot('finalized');
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: authority.publicKey,
    authority: authority.publicKey,
    lookupTable: tableAddress,
    addresses,
  });

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, extendIx],
  }).compileToV0Message());
  tx.sign([authority]);

  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await conn.getLatestBlockhash()).lastValidBlockHeight }, 'confirmed');

  console.log('\n  created :', tableAddress.toBase58());
  console.log('  tx      :', sig);
  console.log('\nAdd to .env, then restart the validators:');
  console.log(`  UNLOCK_LOOKUP_TABLE=${tableAddress.toBase58()}`);
  console.log('\nA table is usable one slot after creation.');
}

main().catch((e) => { console.error('failed:', e); process.exit(1); });
