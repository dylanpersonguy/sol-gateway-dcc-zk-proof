/**
 * pin-logos.mjs
 *
 * For each bridged token:
 *   1. Look up the DCC asset ID stored on the bridge contract
 *   2. Fetch the logo PNG from CoinGecko (large image)
 *   3. Pin the image to IPFS via Pinata
 *   4. Collect DataTransaction entries: logo_<dccAssetId> = "ipfs://<CID>"
 *   5. Sign & broadcast the DataTransaction from the bridge wallet
 *
 * Usage:
 *   node scripts/pin-logos.mjs
 *
 * Env vars (optional overrides, pulled from .env if present):
 *   PINATA_JWT, DCC_NODE_URL, DCC_BRIDGE_CONTRACT, DCC_BASE_SEED, DCC_NONCE
 */

import { writeFileSync } from 'fs';
import { createRequire }  from 'module';
import dotenv from 'dotenv';

dotenv.config();

const require = createRequire(import.meta.url);
const { TOKEN_REGISTRY: TOKENS } = require('../dcc-contracts/token-registry.cjs');

import {
  data as buildDataTx,
  broadcast,
  libs,
} from '@decentralchain/decentralchain-transactions';

const { address, publicKey, privateKey, seedWithNonce } = libs.crypto;

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

// ── Config ────────────────────────────────────────────────────────────────────
const NODE_URL        = process.env.DCC_NODE_URL        || 'https://mainnet-node.decentralchain.io';
const BRIDGE_CONTRACT = process.env.DCC_BRIDGE_CONTRACT || '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG';
const BASE_SEED       = process.env.DCC_BASE_SEED || process.env.DCC_VALIDATOR_SEED || required('DCC_BASE_SEED');
const BASE_NONCE      = Number(process.env.DCC_NONCE    || 1);
const CHAIN_ID        = '?';   // DCC mainnet (63)
const PINATA_JWT      = required('PINATA_JWT');

// Include SOL (native) which is not in TOKEN_REGISTRY
const ALL_TOKENS = [
  {
    splMint:     'So11111111111111111111111111111111111111112',
    symbol:      'SOL',
    cgId:        'solana',   // CoinGecko coin ID (use direct endpoint, not contract)
  },
  ...TOKENS,
];

// ── CoinGecko coin-ID overrides ───────────────────────────────────────────────
// For tokens where the /coins/solana/contract/{address} endpoint doesn't return
// the right result, we use the CoinGecko coin ID directly.
const CG_ID_OVERRIDES = {
  'So11111111111111111111111111111111111111112':  'solana',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'tether',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'paypal-usd',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dai',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'bitcoin',
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij':  'coinbase-wrapped-btc',
  '6DNSN2BJsaPFdBAy8hkkkJ9QK64kAr7MRZGP9mLqPzQq': 'tbtc',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'weth',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jito-staked-sol',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn':  'pump-fun',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'jupiter-exchange-solana',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'raydium',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': 'pyth-network',
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof':  'render-token',
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': 'pudgy-penguins',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'sol-gateway-dcc/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

/**
 * Fetch the best-quality logo URL for a mint.
 * Strategy:
 *   1. Trust Wallet open asset list (no rate limit, no API key)
 *   2. CoinGecko /coins/{id} endpoint (fallback, with extra delay)
 * Returns: URL string (HTTPS)
 */
async function getLogoUrl(splMint) {
  // 1. Try Trust Wallet asset repo (raw GitHub CDN — no rate limit)
  const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/${splMint}/logo.png`;
  try {
    const r = await fetch(twUrl, { method: 'HEAD' });
    if (r.ok) return twUrl;
  } catch {}

  // 2. Fallback: CoinGecko coin-ID endpoint
  const cgId = CG_ID_OVERRIDES[splMint];
  if (!cgId) throw new Error('No CoinGecko ID mapping and Trust Wallet miss');

  await sleep(12000); // respect CoinGecko free-tier rate limit (~5 req/min safe)
  const data = await apiGet(
    `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`
  );
  const img = data?.image?.large || data?.image?.small || data?.image?.thumb;
  if (!img || img.includes('missing_large')) throw new Error('No image on CoinGecko');
  return img;
}

/**
 * Download an image URL and return { buffer, ext }
 */
async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download image: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get('content-type') || 'image/png';
  const ext = contentType.includes('svg') ? 'svg' : contentType.includes('webp') ? 'webp' : 'png';
  return { buffer: buf, ext, contentType };
}

/**
 * Pin a buffer to Pinata IPFS and return the IPFS CID.
 */
async function pinToPinata(buffer, filename, name) {
  const form = new FormData();
  const blob = new Blob([buffer]);
  form.append('file', blob, filename);
  form.append('pinataMetadata', JSON.stringify({ name }));
  form.append('pinataOptions',  JSON.stringify({ cidVersion: 1 }));

  const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method:  'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body:    form,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Pinata error ${r.status}: ${txt}`);
  }
  const json = await r.json();
  return json.IpfsHash;  // CIDv1
}

/**
 * Query the DCC bridge contract data entry to get the on-chain DCC asset ID
 * for a given SPL mint. Key format: token_{splMint}_asset_id
 */
async function getDccAssetId(splMint) {
  const key = `token_${splMint}_asset_id`;
  const url = `${NODE_URL}/addresses/data/${BRIDGE_CONTRACT}/${encodeURIComponent(key)}`;
  const data = await apiGet(url);
  if (!data?.value) throw new Error(`No DCC asset ID on chain for mint ${splMint} (key: ${key})`);
  return data.value;
}

/**
 * Get SOL DCC asset ID (stored under key "sol_asset_id")
 */
async function getSolDccAssetId() {
  const url = `${NODE_URL}/addresses/data/${BRIDGE_CONTRACT}/sol_asset_id`;
  const data = await apiGet(url);
  if (!data?.value) throw new Error('No sol_asset_id on bridge contract');
  return data.value;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' SOL-Gateway DCC — Logo Oracle Pinning Script');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Bridge contract : ${BRIDGE_CONTRACT}`);
  console.log(`DCC node        : ${NODE_URL}`);
  console.log();

  // Derive signer wallet (bridge wallet, nonce 1)
  const seed   = seedWithNonce(BASE_SEED, BASE_NONCE);
  const pubKey = publicKey(seed);
  const privKey = privateKey(seed);
  const signerAddr = address(seed, CHAIN_ID);
  console.log(`Signing wallet  : ${signerAddr}\n`);

  // ── Load previous results for resume support ──────────────────────────────
  const outPath = new URL('../logo-oracle-results.json', import.meta.url).pathname;
  let prevPinned = [];
  try {
    const { readFileSync } = await import('fs');
    prevPinned = JSON.parse(readFileSync(outPath, 'utf8')).filter(r => r.status === 'pinned');
    console.log(`Resuming: ${prevPinned.length} already pinned from previous run\n`);
  } catch {}
  const prevMap = new Map(prevPinned.map(r => [r.splMint, r]));

  const dataEntries = [];
  const results = [];

  // Pre-populate from previous run
  for (const prev of prevPinned) {
    dataEntries.push({ key: `logo_${prev.dccAssetId}`, type: 'string', value: prev.ipfsUrl });
    results.push(prev);
  }

  for (const token of ALL_TOKENS) {
    const { splMint, symbol } = token;

    // Skip already pinned
    if (prevMap.has(splMint)) {
      console.log(`── ${symbol.padEnd(8)} ✅ already pinned (skipping)`);
      continue;
    }

    console.log(`── ${symbol.padEnd(8)} (${splMint.slice(0,8)}...)`);
    // 1. Get DCC asset ID
    let dccAssetId;
    try {
      if (symbol === 'SOL') {
        dccAssetId = await getSolDccAssetId();
      } else {
        dccAssetId = await getDccAssetId(splMint);
      }
      console.log(`   DCC asset ID : ${dccAssetId}`);
    } catch (e) {
      console.warn(`   ⚠ Skipping ${symbol}: ${e.message}`);
      results.push({ symbol, splMint, status: 'skipped', reason: e.message });
      continue;
    }

    // 2. Fetch logo URL (Trust Wallet → CoinGecko fallback)
    let logoUrl;
    try {
      logoUrl = await getLogoUrl(splMint);
      console.log(`   Logo URL     : ${logoUrl.slice(0, 70)}`);
    } catch (e) {
      console.warn(`   ⚠ Skipping ${symbol}: CoinGecko error — ${e.message}`);
      results.push({ symbol, splMint, dccAssetId, status: 'skipped', reason: e.message });
      continue;
    }

    // 3. Download image
    let imageData;
    try {
      imageData = await downloadImage(logoUrl);
      console.log(`   Downloaded   : ${imageData.buffer.length} bytes (.${imageData.ext})`);
    } catch (e) {
      console.warn(`   ⚠ Skipping ${symbol}: download error — ${e.message}`);
      results.push({ symbol, splMint, dccAssetId, status: 'skipped', reason: e.message });
      await sleep(1500);
      continue;
    }

    // 4. Pin to Pinata
    let cid;
    try {
      const filename = `${symbol.toLowerCase()}-logo.${imageData.ext}`;
      cid = await pinToPinata(imageData.buffer, filename, `sol-gateway-dcc/${symbol} logo`);
      console.log(`   IPFS CID     : ${cid}`);
    } catch (e) {
      console.warn(`   ⚠ Skipping ${symbol}: Pinata error — ${e.message}`);
      results.push({ symbol, splMint, dccAssetId, status: 'skipped', reason: e.message });
      await sleep(1500);
      continue;
    }

    // 5. Queue data entry
    const ipfsUrl = `ipfs://${cid}`;
    dataEntries.push({ key: `logo_${dccAssetId}`, type: 'string', value: ipfsUrl });
    results.push({ symbol, splMint, dccAssetId, cid, ipfsUrl, status: 'pinned' });
    console.log(`   ✅ Queued    : logo_${dccAssetId.slice(0,12)}... = ${ipfsUrl}\n`);

    // Small delay to avoid hammering Pinata / GitHub CDN
    await sleep(1000);
  }

  // ── Summary ──
  console.log('\n═══════════════ RESULTS ═══════════════');
  console.log(`Pinned  : ${results.filter(r => r.status === 'pinned').length}`);
  console.log(`Skipped : ${results.filter(r => r.status === 'skipped').length}`);

  if (!dataEntries.length) {
    console.error('\n❌ No entries to write — aborting DataTransaction.');
    process.exit(1);
  }

  // Save results JSON for reference
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved results → ${outPath}`);

  // ── Build & broadcast DataTransaction ────────────────────────────────────
  console.log('\n═══════════ Broadcasting DataTransaction ═══════════');
  console.log(`Entries: ${dataEntries.length}`);

  const tx = buildDataTx(
    {
      data:      dataEntries,
      version:   1,           // avoid protobuf path (dccProto not loaded)
      chainId:   CHAIN_ID,
      fee:       100000 * Math.max(1, Math.ceil(dataEntries.length / 5)),
      timestamp: Date.now(),
    },
    { privateKey: privKey }
  );

  console.log(`Tx ID   : ${tx.id}`);
  console.log(`Fee     : ${tx.fee / 1e8} DCC`);

  let broadcastResult;
  try {
    broadcastResult = await broadcast(tx, NODE_URL);
    console.log(`\n✅ DataTransaction broadcast!`);
    console.log(`   TX ID : ${broadcastResult.id}`);
    console.log(`   View  : https://decentralscan.com/tx/${broadcastResult.id}`);
  } catch (e) {
    console.error('\n❌ Broadcast failed:', e.message);
    console.log('\nRaw tx (save this for manual broadcast):');
    console.log(JSON.stringify(tx, null, 2));
    process.exit(1);
  }

  // ── Print DEX integration note ─────────────────────────────────────────────
  console.log('\n═══════════ DEX Integration ═══════════');
  console.log('The logo oracle address (DataTransaction sender):');
  console.log(`  ${signerAddr}`);
  console.log('\nTo tell the DCC DEX to read logos from this oracle, the');
  console.log('DEX frontend config must include this address as a trusted oracle.');
  console.log('Key format: logo_<dccAssetId>  →  ipfs://<CIDv1>');
  console.log('\nAll logos are also accessible via IPFS gateway:');
  for (const r of results.filter(x => x.status === 'pinned')) {
    console.log(`  ${r.symbol.padEnd(8)}: https://gateway.pinata.cloud/ipfs/${r.cid}`);
  }
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e);
  process.exit(1);
});
