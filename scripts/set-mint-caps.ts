#!/usr/bin/env ts-node

/**
 * set-mint-caps.ts
 *
 * Brings the DCC mint caps in line with what the Solana side will actually
 * lock.
 *
 * min_validators on the bridge contract is 1 and cannot be raised: it is
 * written only by initialize(), which refuses to re-run, and the @Verifier
 * blocks DataTransactions outright. Changing it needs a contract upgrade.
 *
 * Until then a single key authorises every mint, and that key's seed sits in
 * .env. What can be reduced today is how much that key can mint, and the caps
 * are far larger than any legitimate deposit:
 *
 *   Solana max_deposit        10 SOL      DCC max_single_mint  1000 SOL
 *   Solana max_daily_outflow  50 SOL      DCC max_daily_mint  10000 SOL
 *
 * A mint above the Solana deposit cap cannot correspond to a real deposit, so
 * the DCC caps are set to match. That leaves legitimate traffic untouched and
 * cuts the worst case of a compromised key by 100x per transaction.
 *
 * Usage:
 *   ts-node scripts/set-mint-caps.ts                     # show current vs proposed
 *   ts-node scripts/set-mint-caps.ts --broadcast
 *   ts-node scripts/set-mint-caps.ts --single 10 --daily 50 --broadcast
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const WSOL_DECIMALS = 8;

async function dataValue(node: string, contract: string, key: string): Promise<number | undefined> {
  try {
    const { data } = await axios.get(`${node}/addresses/data/${contract}/${key}`, { timeout: 20000 });
    return data?.value;
  } catch { return undefined; }
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  const node = process.env.DCC_NODE_URL!;
  const contract = process.env.DCC_BRIDGE_CONTRACT!;
  const chainId = process.env.DCC_CHAIN_ID_CHAR || '?';

  // The admin is the contract account itself, so its seed signs these calls.
  // Prefer the environment: the admin seed can upgrade the contract and rewrite
  // the validator set, so it should not be sitting in the repo. Load it with
  // `source ./scripts/secrets.sh`. A file path is still accepted for setups
  // that mount secrets rather than inject them.
  const adminSeed = (process.env.DCC_ADMIN_SEED
    || (process.env.DCC_ADMIN_SEED_PATH
        ? fs.readFileSync(process.env.DCC_ADMIN_SEED_PATH, 'utf-8')
        : '')).trim();

  if (!adminSeed) {
    console.error('No admin seed. Set DCC_ADMIN_SEED (see scripts/secrets.sh)');
    console.error('or point DCC_ADMIN_SEED_PATH at a file containing it.');
    process.exit(1);
  }

  const toUnits = (sol: number) => Math.round(sol * 10 ** WSOL_DECIMALS);
  const toSol = (units: number) => units / 10 ** WSOL_DECIMALS;

  const singleSol = Number(arg('--single') ?? 10);
  const dailySol = Number(arg('--daily') ?? 50);

  const currentSingle = await dataValue(node, contract, 'max_single_mint');
  const currentDaily = await dataValue(node, contract, 'max_daily_mint');
  const minValidators = await dataValue(node, contract, 'min_validators');

  console.log(broadcast ? '=== SET MINT CAPS (BROADCASTING) ===' : '=== SET MINT CAPS (dry run) ===');
  console.log(`  contract        : ${contract}`);
  console.log(`  min_validators  : ${minValidators}  ${minValidators === 1 ? '(one key authorises every mint)' : ''}`);
  console.log();
  console.log(`  max_single_mint : ${toSol(currentSingle ?? 0)} SOL  ->  ${singleSol} SOL`);
  console.log(`  max_daily_mint  : ${toSol(currentDaily ?? 0)} SOL  ->  ${dailySol} SOL`);

  if (currentSingle !== undefined && toUnits(singleSol) > currentSingle) {
    console.error('\nRefusing to RAISE max_single_mint. This tool only lowers exposure.');
    process.exit(1);
  }
  if (currentDaily !== undefined && toUnits(dailySol) > currentDaily) {
    console.error('\nRefusing to RAISE max_daily_mint. This tool only lowers exposure.');
    process.exit(1);
  }

  if (!broadcast) {
    console.log('\nDry run. Re-run with --broadcast to apply.');
    return;
  }

  const { invokeScript, broadcast: send } = await import('@decentralchain/decentralchain-transactions');

  for (const [fn, value] of [
    ['updateMaxSingleMint', toUnits(singleSol)],
    ['updateMaxDailyMint', toUnits(dailySol)],
  ] as [string, number][]) {
    const tx = invokeScript({
      dApp: contract,
      chainId,
      call: { function: fn, args: [{ type: 'integer', value }] },
      payment: [],
      fee: 900000,
    }, adminSeed);
    const res: any = await send(tx, node);
    console.log(`  ${fn}(${value}) -> ${res.id}`);
  }

  console.log('\nCaps lowered. This limits the damage a single key can do; it does');
  console.log('not make the bridge multi-signature. Raising min_validators still');
  console.log('requires a contract upgrade.');
}

main().catch((e) => { console.error('failed:', e?.message ?? e); process.exit(1); });
