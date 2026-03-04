import { libs } from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const seed = required('DCC_VALIDATOR_SEED');
const addr = libs.crypto.address(seed, '?');
const pubkey = libs.crypto.publicKey(seed);

console.log('ADDRESS: ' + addr);
console.log('PUBKEY: ' + pubkey);

const urls = [
  'https://mainnet-node.decentralchain.io',
  'http://mainnet-node.decentralchain.io',
  'https://testnet-node.decentralchain.io',
];

for (const base of urls) {
  try {
    console.log('\nTrying ' + base);
    const r = await fetch(base + '/addresses/balance/' + addr, {
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    console.log('  DCC: ' + JSON.stringify(d));

    const r2 = await fetch(base + '/assets/balance/' + addr, {
      signal: AbortSignal.timeout(10000),
    });
    const d2 = await r2.json();
    if (d2.balances && d2.balances.length > 0) {
      console.log('  Tokens:');
      for (const b of d2.balances) {
        const dec = b.issueTransaction ? b.issueTransaction.decimals : 0;
        const nm = b.issueTransaction ? b.issueTransaction.name : b.assetId;
        console.log('    ' + nm + ': ' + (b.balance / Math.pow(10, dec)));
      }
    } else {
      console.log('  No tokens');
    }
    process.exit(0);
  } catch (e) {
    console.log('  FAIL: ' + e.message);
  }
}
console.log('\nAll nodes unreachable');
process.exit(1);
