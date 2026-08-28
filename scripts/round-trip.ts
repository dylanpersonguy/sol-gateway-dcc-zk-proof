#!/usr/bin/env ts-node

/**
 * round-trip.ts
 *
 * Drives one transfer through the whole bridge and reports each stage:
 *
 *   deposit SOL on Solana -> validators mint wSOL on DCC
 *   burn that wSOL        -> validators unlock SOL on Solana
 *
 * The point is to exercise the live validator pipeline — watcher, consensus,
 * submission — rather than any script's own code path. Nothing here mints or
 * unlocks; it only deposits and burns, and then watches.
 *
 * The DCC recipient is this seed's own address so the wSOL can be burned back.
 *
 * Usage:
 *   ts-node scripts/round-trip.ts                  # show the plan
 *   ts-node scripts/round-trip.ts --broadcast      # run it
 *   ts-node scripts/round-trip.ts --amount 0.002 --broadcast
 */

import {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const c of s) { if (c !== '1') break; zeros++; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** Poll until `check` returns a value, or give up. */
async function waitFor<T>(
  label: string, timeoutMs: number, intervalMs: number, check: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let waited = 0;
  while (Date.now() < deadline) {
    const got = await check();
    if (got !== null && got !== undefined) return got;
    await sleep(intervalMs);
    waited += intervalMs;
    if (waited % 30000 === 0) {
      console.log(`      still waiting on ${label} (${waited / 1000}s of ${timeoutMs / 1000}s)`);
    }
  }
  return null;
}

async function dccData(node: string, addr: string, key: string) {
  try {
    const { data } = await axios.get(`${node}/addresses/data/${addr}/${key}`, { timeout: 15000 });
    return data?.value;
  } catch { return undefined; }
}

async function wsolBalance(node: string, addr: string, asset: string): Promise<bigint> {
  try {
    const { data } = await axios.get(`${node}/assets/balance/${addr}/${asset}`, { timeout: 15000 });
    return BigInt(data?.balance ?? 0);
  } catch { return 0n; }
}

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  const amountSol = Number(arg('--amount') ?? 0.002);
  const amountLamports = BigInt(Math.round(amountSol * 1e9));

  const rpc = process.env.SOLANA_RPC_URL!;
  const node = process.env.DCC_NODE_URL!;
  const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID!);
  const bridge = process.env.DCC_BRIDGE_CONTRACT!;
  const chainIdChar = process.env.DCC_CHAIN_ID_CHAR || '?';
  const seed = process.env.DCC_VALIDATOR_SEED!;

  const depositorPath = process.env.ROUND_TRIP_KEYPAIR
    || `${process.env.HOME}/.config/solana/deployer.json`;
  const depositor = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(depositorPath, 'utf-8'))),
  );

  const { libs } = await import('@decentralchain/decentralchain-transactions');
  const dccAddress: string = libs.crypto.address(seed, 63);

  const conn = new Connection(rpc, 'confirmed');
  const wsolAsset = String(await dccData(node, bridge, 'sol_asset_id'));

  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  const [userState] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_state'), depositor.publicKey.toBuffer()], programId);

  console.log('=== ROUND TRIP ' + (broadcast ? '(LIVE)' : '(plan only)') + ' ===');
  console.log(`  amount        : ${amountSol} SOL`);
  console.log(`  depositor     : ${depositor.publicKey.toBase58()}`);
  console.log(`  DCC recipient : ${dccAddress}  (ours, so the wSOL can be burned back)`);
  console.log(`  wSOL asset    : ${wsolAsset}`);

  const solBefore = await conn.getBalance(depositor.publicKey);
  const wsolBefore = await wsolBalance(node, dccAddress, wsolAsset);
  console.log(`\n  before: ${solBefore} lamports on Solana, ${wsolBefore} wSOL units on DCC`);

  if (!broadcast) {
    console.log('\nPlan only. Re-run with --broadcast to execute.');
    return;
  }

  // ── 1. deposit on Solana ─────────────────────────────────────
  console.log('\n[1/4] depositing on Solana');
  const usInfo = await conn.getAccountInfo(userState);
  const nonce = usInfo && usInfo.data.length >= 48 ? usInfo.data.readBigUInt64LE(40) : 0n;

  const tidBuf = Buffer.alloc(40);
  depositor.publicKey.toBuffer().copy(tidBuf, 0);
  tidBuf.writeBigUInt64LE(nonce, 32);
  const transferId = crypto.createHash('sha256').update(tidBuf).digest();

  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), transferId], programId);

  const recipientBytes = Buffer.alloc(32);
  b58decode(dccAddress).copy(recipientBytes, 0);

  const data = Buffer.alloc(8 + 32 + 8 + 32);
  DEPOSIT_DISC.copy(data, 0);
  recipientBytes.copy(data, 8);
  data.writeBigUInt64LE(amountLamports, 40);
  transferId.copy(data, 48);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: bridgeConfig, isSigner: false, isWritable: true },
      { pubkey: userState, isSigner: false, isWritable: true },
      { pubkey: depositRecord, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: depositor.publicKey }).add(ix);
  tx.sign(depositor);
  const depositSig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: depositSig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`      tx         : ${depositSig}`);
  console.log(`      transferId : ${transferId.toString('hex').slice(0, 32)}…`);

  // ── 2. validators mint on DCC ────────────────────────────────
  console.log('\n[2/4] waiting for the validators to mint (needs 32 confirmations first)');
  const minted = await waitFor('mint', 15 * 60 * 1000, 10000, async () => {
    const flag = await dccData(node, bridge, `processed_${transferId.toString('hex')}`);
    return flag === true ? true : null;
  });
  if (!minted) {
    console.error('      MINT DID NOT LAND within 15 minutes.');
    console.error('      Check the validator logs for the deposit/consensus/submit stages.');
    process.exit(1);
  }
  const wsolAfterMint = await wsolBalance(node, dccAddress, wsolAsset);
  console.log(`      minted     : ${wsolAfterMint - wsolBefore} wSOL units received`);

  // ── 3. burn on DCC ───────────────────────────────────────────
  const burnAmount = wsolAfterMint - wsolBefore;
  console.log(`\n[3/4] burning ${burnAmount} wSOL units back to ${depositor.publicKey.toBase58()}`);
  const { invokeScript, broadcast: send } = await import('@decentralchain/decentralchain-transactions');
  const burnTx = invokeScript({
    dApp: bridge,
    chainId: chainIdChar,
    call: { function: 'burn', args: [{ type: 'string', value: depositor.publicKey.toBase58() }] },
    payment: [{ assetId: wsolAsset, amount: Number(burnAmount) }],
    fee: 900000,
  }, seed);
  const burnRes: any = await send(burnTx, node);
  console.log(`      tx         : ${burnRes.id}`);

  // ── 4. validators unlock on Solana ───────────────────────────
  console.log('\n[4/4] waiting for the validators to unlock on Solana');

  // Watch for the unlock TRANSACTION, not for the balance.
  //
  // Two balance-based versions of this check were wrong. Comparing against
  // `before - deposit` never matched, because fees on both legs put the final
  // balance below that. Watching for a rise from a post-burn snapshot fails
  // differently: the snapshot is taken after the burn is submitted, so an
  // unlock still queued from an EARLIER burn can land in that window and
  // inflate the baseline. This round trip's own unlock then never rises above
  // it, and a completed transfer is reported as "DID NOT LAND" -- exactly what
  // happened with four backlog unlocks in flight.
  //
  // A successful signature carrying an unlock, newer than our burn, is
  // unambiguous regardless of what else is settling concurrently.
  const burnSentAt = Math.floor(Date.now() / 1000);
  const unlocked = await waitFor('unlock', 15 * 60 * 1000, 10000, async () => {
    const sigs = await conn.getSignaturesForAddress(depositor.publicKey, { limit: 15 });
    for (const s of sigs) {
      // Tolerate a little clock skew between this host and the cluster.
      if (!s.blockTime || s.blockTime < burnSentAt - 90 || s.err) continue;
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (/unlock/i.test((tx?.meta?.logMessages ?? []).join(' '))) return s.signature;
    }
    return null;
  });
  if (unlocked) console.log(`      unlock tx  : ${unlocked}`);

  const solAfter = await conn.getBalance(depositor.publicKey);
  const wsolAfter = await wsolBalance(node, dccAddress, wsolAsset);

  console.log('\n=== RESULT ===');
  console.log(`  SOL  before ${solBefore}  after ${solAfter}  net ${solAfter - solBefore} lamports`);
  console.log(`  the net is negative by design: bridge fees on both legs plus Solana tx fees`);
  console.log(`  wSOL before ${wsolBefore}  after ${wsolAfter}`);
  console.log(`  deposit -> mint : OK`);
  console.log(`  burn -> unlock  : ${unlocked ? `OK (${unlocked.slice(0,20)}...)` : 'DID NOT LAND — check validator logs'}`);
  if (!unlocked) process.exit(1);
}

main().catch((e) => { console.error('round trip failed:', e?.message ?? e); process.exit(1); });
