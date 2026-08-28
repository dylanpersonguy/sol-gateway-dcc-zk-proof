#!/usr/bin/env ts-node

/**
 * settle-stuck-deposits.ts
 *
 * Reconciles Solana deposit records against the DCC bridge contract and reports
 * — or, with --broadcast, settles — deposits that locked funds but never minted.
 *
 * DRY RUN BY DEFAULT. Nothing is broadcast unless --broadcast is passed. Every
 * mint is checked against isTransferProcessed on-chain first, so re-running is
 * safe and cannot double-mint.
 *
 * The mint takes exactly getMinValidators() signatures from keys registered on
 * the bridge contract. It deliberately does NOT synthesise extra signatures
 * from sibling keys of one seed: that presents a single signer as several,
 * which is what the contract's duplicate-pubkey check exists to stop.
 *
 * Usage:
 *   ts-node scripts/settle-stuck-deposits.ts            # report only
 *   ts-node scripts/settle-stuck-deposits.ts --broadcast # actually mint
 */

import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { calculateDepositFee } from '../validator/src/utils/fee-calculator';
import { loadConfig } from '../validator/src/config';
import {
  signBytes as dccSignBytes,
  publicKey as dccPublicKey,
  base58Decode,
} from '@decentralchain/ts-lib-crypto';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEPOSIT_RECORD_LEN = 206; // deployed layout: event_index is u32
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out || '1';
}

interface DepositRecord {
  transferId: string;
  sender: string;
  recipient: string;
  amount: bigint;
  slot: bigint;
  assetId: string;
  processedOnSolana: boolean;
}

function decodeDeposit(data: Buffer): DepositRecord {
  let o = 8;
  const transferId = Buffer.from(data.subarray(o, o + 32)).toString('hex'); o += 32;
  o += 32; // message_id
  const sender = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
  const rc = data.subarray(o, o + 32); o += 32;
  const amount = data.readBigUInt64LE(o); o += 8;
  o += 8;  // nonce
  const slot = data.readBigUInt64LE(o); o += 8;
  o += 4;  // event_index (u32 on the deployed program)
  o += 8;  // timestamp
  const assetId = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
  const processedOnSolana = data[o] !== 0;

  let last = rc.length - 1;
  while (last > 0 && rc[last] === 0) last--;
  return {
    transferId, sender,
    recipient: b58encode(rc.subarray(0, last + 1)),
    amount, slot, assetId, processedOnSolana,
  };
}

async function dccValue(node: string, contract: string, key: string): Promise<any> {
  try {
    const { data } = await axios.get(
      `${node}/addresses/data/${contract}/${encodeURIComponent(key)}`,
      { timeout: 20_000 },
    );
    return data?.value;
  } catch { return undefined; }
}

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  // Ask the node to run the transaction without submitting it. Proves the call
  // would succeed — signatures, whitelist, limits, the lot — without spending.
  const validateOnly = process.argv.includes('--validate');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  const rpc = process.env.SOLANA_RPC_URL!;
  const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID!);
  const node = process.env.DCC_NODE_URL!;
  const contract = process.env.DCC_BRIDGE_CONTRACT!;
  const seed = process.env.DCC_SIGNING_SEED || process.env.DCC_VALIDATOR_SEED!;
  const chainId = parseInt(process.env.DCC_CHAIN_ID || '63', 10);

  console.log(broadcast ? '=== SETTLE (BROADCASTING) ===' : validateOnly ? '=== SETTLE (validate against node — nothing is sent) ===' : '=== SETTLE (dry run — nothing is sent) ===');

  // Only keys registered on the contract can produce an accepted signature.
  const signerPub = dccPublicKey(seed);
  const active = await dccValue(node, contract, `validator_active_${signerPub}`);
  const minValidators = Number(await dccValue(node, contract, 'min_validators') ?? 1);
  console.log(`signing key       : ${signerPub}`);
  console.log(`registered/active : ${active === true}`);
  console.log(`min_validators    : ${minValidators}`);

  if (active !== true) {
    console.error('\nThis key is not an active validator on the bridge contract, so every');
    console.error('mint would throw "Validator not active". Register it first.');
    process.exit(1);
  }
  if (minValidators > 1) {
    console.error(`\nThe contract requires ${minValidators} signatures and this tool holds one key.`);
    console.error('Collect the other signatures from their own holders — do not derive them.');
    process.exit(1);
  }

  // Same config the validator uses, so the fee matches exactly.
  const validatorConfig = loadConfig();

  const conn = new Connection(rpc, 'confirmed');
  const accounts = (await conn.getProgramAccounts(programId))
    .filter((a) => a.account.data.length === DEPOSIT_RECORD_LEN);

  const deposits = accounts.map((a) => decodeDeposit(a.account.data))
    .sort((a, b) => Number(a.slot - b.slot));

  console.log(`\ndeposit records on Solana: ${deposits.length}`);

  let settled = 0, alreadyDone = 0, skipped = 0, failed = 0;

  for (const d of deposits) {
    const isNative = d.assetId === NATIVE_SOL_MINT;
    const label = `${d.transferId.slice(0, 12)}… ${d.amount} ${isNative ? 'lamports' : d.assetId.slice(0, 8) + '…'} -> ${d.recipient}`;

    if (!isNative) {
      // USDC/USDT mint through the DUSD contract, not this one.
      console.log(`  SKIP  ${label}  (non-native asset — settles via the DUSD contract)`);
      skipped++;
      continue;
    }

    const done = await dccValue(node, contract, `processed_${d.transferId}`);
    if (done === true) { console.log(`  DONE  ${label}`); alreadyDone++; continue; }

    // The validator signs over the NET amount — consensus runs on a
    // fee-adjusted copy of the event (validator/src/main.ts). Minting the gross
    // amount would issue more wSOL than the vault backs, so use the same
    // calculator rather than restating the arithmetic here.
    const fee = calculateDepositFee(d.amount, validatorConfig);
    const netAmount = fee.netAmountLamports;
    if (netAmount <= 0n) {
      console.log(`  SKIP  ${label}  (fee exceeds deposit)`);
      skipped++;
      continue;
    }

    const message = `SOL_DCC_BRIDGE_V1|MINT|${d.transferId}|${d.recipient}|${netAmount}|${d.slot}|${chainId}`;

    if (!broadcast && !validateOnly) {
      console.log(`  MINT  ${label}  net=${netAmount} (fee ${fee.feeLamports})`);
      settled++;
      continue;
    }

    if (settled >= limit) { console.log(`  STOP  reached --limit ${limit}`); break; }

    try {
      const sig = dccSignBytes(seed, new Uint8Array(Buffer.from(message, 'utf8'))) as unknown as string;
      const { invokeScript, broadcast: send } = await import('@decentralchain/decentralchain-transactions');
      const tx = invokeScript({
        dApp: contract,
        chainId: process.env.DCC_CHAIN_ID_CHAR || '?',
        call: {
          function: 'mint',
          args: [
            { type: 'string',  value: d.transferId },
            { type: 'string',  value: d.recipient },
            { type: 'integer', value: Number(netAmount) },
            { type: 'integer', value: Number(d.slot) },
            { type: 'list',    value: [{ type: 'binary', value: 'base64:' + Buffer.from(base58Decode(sig)).toString('base64') }] },
            { type: 'list',    value: [{ type: 'binary', value: 'base64:' + Buffer.from(base58Decode(signerPub)).toString('base64') }] },
          ],
        },
        payment: [],
        fee: 900000,
      }, seed);
      if (validateOnly) {
        const { data } = await axios.post(`${node}/debug/validate`, tx, {
          timeout: 30_000,
          headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.DCC_API_KEY ?? '' },
        });
        if (data?.valid) {
          console.log(`  VALID ${label}  net=${netAmount}`);
          settled++;
        } else {
          console.error(`  INVALID ${label}\n        ${data?.error ?? JSON.stringify(data).slice(0, 300)}`);
          failed++;
        }
      } else {
        const res: any = await send(tx, node);
        console.log(`  SENT  ${label}  tx=${res.id}`);
        settled++;
      }
    } catch (err: any) {
      console.error(`  FAIL  ${label}\n        ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log(`\n${broadcast ? 'settled' : 'would settle'}: ${settled}   already processed: ${alreadyDone}   skipped: ${skipped}   failed: ${failed}`);
  if (!broadcast && settled > 0) {
    console.log('\nRe-run with --broadcast to send these mints.');
  }
}

main().catch((e) => { console.error('settle failed:', e); process.exit(1); });
