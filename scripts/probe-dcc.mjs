import { libs } from '@decentralchain/decentralchain-transactions';

const seed = '***REDACTED_SEED_PHRASE***';

// Try testnet node - get its chain info first
const testnet = 'https://testnet-node.decentralchain.io';

try {
  // Get node version/info
  const r1 = await fetch(testnet + '/node/version', { signal: AbortSignal.timeout(10000) });
  console.log('Node version: ' + JSON.stringify(await r1.json()));
} catch(e) { console.log('version fail: ' + e.message); }

try {
  const r2 = await fetch(testnet + '/addresses', { signal: AbortSignal.timeout(10000) });
  console.log('Node addresses: ' + JSON.stringify(await r2.json()));
} catch(e) { console.log('addresses fail: ' + e.message); }

try {
  const r3 = await fetch(testnet + '/blocks/last', { signal: AbortSignal.timeout(10000) });
  const block = await r3.json();
  console.log('Last block generator: ' + block.generator);
  console.log('Last block height: ' + block.height);
  // The generator address prefix tells us the chain ID
  if (block.generator) {
    console.log('Generator prefix: ' + block.generator.substring(0, 3));
  }
} catch(e) { console.log('blocks fail: ' + e.message); }

// Generate address with various chain IDs and show prefix
console.log('\nAddress with different chain IDs:');
for (const ch of ['?', 'D', 'L', 'T', 'W', 'R', 'S']) {
  const addr = libs.crypto.address(seed, ch);
  console.log('  chainId=' + ch + ' (' + ch.charCodeAt(0) + '): ' + addr);
}
