'use strict';
/**
 * Gateway Test — Send 10 of each token through SOL → DCC bridge
 *
 * Step 1: Deposit native SOL on Solana devnet (what the wallet can afford)
 * Step 2: Mint SOL.DCC + all 16 SPL tokens on DCC mainnet
 *         to the specified recipient address.
 *
 * The validator/admin key signs the DCC mint transactions.
 *
 * Uses nonce=1 address (v2 deployment — no 'w' prefix tokens).
 */
const { createHash } = require('crypto');
const {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  invokeScript,
  libs,
} = require('@decentralchain/decentralchain-transactions');
const fs = require('fs');
require('dotenv').config();

const { privateKey, publicKey, address, seedWithNonce } = libs.crypto;

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Solana devnet
const SOL_RPC      = 'https://api.devnet.solana.com';
const PROGRAM_ID   = new PublicKey('9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');
const DEPOSIT_DISC = Buffer.from([242,35,198,137,82,225,242,182]);

// DCC mainnet
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
};

const DCC_NODE      = process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io';
const DCC_CHAIN     = process.env.DCC_CHAIN_ID_CHAR || '?';
const API_KEY       = required('DCC_API_KEY');
const BASE_SEED     = required('DCC_VALIDATOR_SEED');
const BASE_NONCE    = parseInt(process.env.DCC_VALIDATOR_NONCE || '1', 10);

// Derive deployer/validator keys — nonce 1 = v2 deployment (no w prefix)
const SEED_WITH_NONCE = seedWithNonce(BASE_SEED, BASE_NONCE);
const DEPLOYER_PUBKEY = publicKey(SEED_WITH_NONCE);
const DEPLOYER_ADDR   = address(SEED_WITH_NONCE, DCC_CHAIN);
const SIGNER          = { privateKey: privateKey(SEED_WITH_NONCE) };

const BRIDGE_ADDR     = DEPLOYER_ADDR;  // bridge contract = deployer (nonce 1)
// SOL_ASSET_ID is read dynamically from on-chain state after deployment
let SOL_ASSET_ID      = process.env.SOL_ASSET_ID || '';

// Target DCC recipient
const DCC_RECIPIENT   = '3Da7xwRRtXfkA46jaKTYb75Usd2ZNWdY6HX';

// Token registry — symbol, splMint, solDecimals, amount to send (10 human units)
const TOKENS = [
  // Native SOL (handled by mint() not mintToken())
  { symbol: 'SOL',     splMint: 'So11111111111111111111111111111111111111112', solDecimals: 9,  isNative: true },
  // SPL tokens (handled by mintToken())
  { symbol: 'USDC',    splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', solDecimals: 6 },
  { symbol: 'USDT',    splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  solDecimals: 6 },
  { symbol: 'PYUSD',   splMint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', solDecimals: 6 },
  { symbol: 'DAI',     splMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', solDecimals: 8 },
  { symbol: 'BTC',     splMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', solDecimals: 8 },
  { symbol: 'cbBTC',   splMint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',   solDecimals: 8 },
  { symbol: 'tBTC',    splMint: '6DNSN2BJsaPFdBAy8hkkkJ9QK64kAr7MRZGP9mLqPzQq', solDecimals: 8 },
  { symbol: 'ETH',     splMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', solDecimals: 8 },
  { symbol: 'JitoSOL', splMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', solDecimals: 9 },
  { symbol: 'BONK',    splMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', solDecimals: 5 },
  { symbol: 'PUMP',    splMint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',  solDecimals: 6 },
  { symbol: 'JUP',     splMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  solDecimals: 6 },
  { symbol: 'RAY',     splMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', solDecimals: 6 },
  { symbol: 'PYTH',    splMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', solDecimals: 6 },
  { symbol: 'RNDR',    splMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  solDecimals: 8 },
  { symbol: 'PENGU',   splMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', solDecimals: 6 },
];

const HUMAN_AMOUNT = 10;  // 10 of each token

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dccGet(path) {
  const r = await fetch(`${DCC_NODE}${path}`);
  return r.json();
}

async function dccBroadcast(tx) {
  const r = await fetch(`${DCC_NODE}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC rejected: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function waitDccTx(txId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`DCC tx ${txId} not confirmed`);
}

function makeTransferId(symbol, index) {
  return createHash('sha256')
    .update(`gateway-test-mainnet-${symbol}-${index}-${Date.now()}`)
    .digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// STEP 1: SOLANA DEPOSIT (native SOL only)
// ═══════════════════════════════════════════════════════════════

async function depositSolOnDevnet() {
  let wallet;
  try {
    wallet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/test-wallet.json', 'utf8')))
    );
  } catch {
    console.log('  No test wallet found at /tmp/test-wallet.json — skipping Solana deposit');
    return null;
  }

  const connection = new Connection(SOL_RPC, 'confirmed');
  const balance = await connection.getBalance(wallet.publicKey);
  const solBal = balance / 1e9;
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${solBal.toFixed(6)} SOL`);

  // Deposit 0.1 SOL (we don't have 10 SOL on devnet)
  const depositLamports = 100_000_000; // 0.1 SOL
  if (balance < depositLamports + 10_000_000) {
    console.log('  Insufficient SOL for deposit — skipping Solana deposit');
    return null;
  }

  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);
  const [vault]        = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID);
  const [userState]    = PublicKey.findProgramAddressSync([Buffer.from('user_state'), wallet.publicKey.toBuffer()], PROGRAM_ID);

  // Get nonce
  let nonce = 0n;
  const usInfo = await connection.getAccountInfo(userState);
  if (usInfo) {
    nonce = usInfo.data.readBigUInt64LE(40);
  }

  // Compute transfer_id
  const tidBuf = Buffer.alloc(40);
  wallet.publicKey.toBuffer().copy(tidBuf, 0);
  tidBuf.writeBigUInt64LE(nonce, 32);
  const transferId = createHash('sha256').update(tidBuf).digest();

  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), transferId], PROGRAM_ID
  );

  // Build deposit instruction
  const rBytes = Buffer.alloc(32);
  Buffer.from(DCC_RECIPIENT).copy(rBytes, 0, 0, Math.min(DCC_RECIPIENT.length, 32));

  const dp = Buffer.alloc(72);
  rBytes.copy(dp, 0);
  dp.writeBigUInt64LE(BigInt(depositLamports), 32);
  transferId.copy(dp, 40);

  const dix = new TransactionInstruction({
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

  const tx = new Transaction().add(dix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
    maxRetries: 5,
  });

  console.log(`  ✅ Deposited 0.1 SOL on Solana devnet`);
  console.log(`  Tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const txInfo = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return {
    transferIdHex: transferId.toString('hex'),
    solSlot: txInfo?.slot || 0,
    amount: depositLamports,
  };
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: DCC MINTING — mint wrapped tokens for all 17 tokens
// ═══════════════════════════════════════════════════════════════

async function mintNativeSol(transferIdHex, amount, solSlot) {
  const validatorPubkeyBytes = Buffer.from(libs.crypto.base58Decode(DEPLOYER_PUBKEY));
  const solMint = 'So11111111111111111111111111111111111111112';

  // Real ed25519 signature over the legacy canonical message
  const legacyMsg = `SOL_DCC_BRIDGE_V1|MINT|${transferIdHex}|${DCC_RECIPIENT}|${amount}|${solSlot}|${DCC_CHAIN_ID_INT}`;
  const sigBase58 = signBytes({ privateKey: privateKey(SEED_WITH_NONCE) }, Buffer.from(legacyMsg, 'utf8'));
  const sigBytes  = Buffer.from(libs.crypto.base58Decode(sigBase58));

  const mintTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: {
        function: 'mint',
        args: [
          { type: 'string',  value: transferIdHex },
          { type: 'string',  value: DCC_RECIPIENT },
          { type: 'integer', value: amount },
          { type: 'integer', value: solSlot },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + sigBytes.toString('base64') }] },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + validatorPubkeyBytes.toString('base64') }] },
        ],
      },
      payment: [],
      chainId: DCC_CHAIN,
      fee: 5000000,
      senderPublicKey: DEPLOYER_PUBKEY,
      version: 1,
    },
    SIGNER
  );

  const resp = await dccBroadcast(mintTx);
  process.stdout.write('    Confirming');
  await waitDccTx(resp.id);
  console.log(' ✅');
  return resp.id;
}

async function mintSplToken(transferIdHex, amount, solSlot, splMint) {
  const validatorPubkeyBytes = Buffer.from(libs.crypto.base58Decode(DEPLOYER_PUBKEY));

  // Real ed25519 signature over the canonical mint message
  const canonicalMsg = `SOL_DCC_BRIDGE_V2|MINT|${transferIdHex}|${DCC_RECIPIENT}|${amount}|${solSlot}|${splMint}|${DCC_CHAIN_ID_INT}`;
  const sigBase58 = signBytes({ privateKey: privateKey(SEED_WITH_NONCE) }, Buffer.from(canonicalMsg, 'utf8'));
  const sigBytes  = Buffer.from(libs.crypto.base58Decode(sigBase58));

  const mintTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: {
        function: 'mintToken',
        args: [
          { type: 'string',  value: transferIdHex },
          { type: 'string',  value: DCC_RECIPIENT },
          { type: 'integer', value: amount },
          { type: 'integer', value: solSlot },
          { type: 'string',  value: splMint },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + sigBytes.toString('base64') }] },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + validatorPubkeyBytes.toString('base64') }] },
        ],
      },
      payment: [],
      chainId: DCC_CHAIN,
      fee: 5000000,
      senderPublicKey: DEPLOYER_PUBKEY,
      version: 1,
    },
    SIGNER
  );

  const resp = await dccBroadcast(mintTx);
  process.stdout.write('    Confirming');
  await waitDccTx(resp.id);
  console.log(' ✅');
  return resp.id;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SOL → DCC Gateway Test — 10 of each token');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();
  console.log('Bridge contract: ', BRIDGE_ADDR);
  console.log('DCC recipient:   ', DCC_RECIPIENT);
  console.log('Tokens:           17 (SOL + 16 SPL)');
  console.log();

  // Verify DCC chain is alive
  const dccH = await dccGet('/blocks/height');
  console.log('DCC mainnet height:', dccH.height);
  console.log();

  // Auto-resolve SOL asset ID from on-chain contract state
  if (!SOL_ASSET_ID) {
    const solEntry = await dccGet(`/addresses/data/${BRIDGE_ADDR}/sol_asset_id`).catch(() => null);
    if (solEntry?.value) {
      SOL_ASSET_ID = solEntry.value;
      console.log('SOL asset ID (on-chain): ', SOL_ASSET_ID);
    } else {
      console.log('⚠️  Could not resolve SOL asset ID from on-chain state');
    }
  }

  console.log();

  // ── STEP 1: Solana Deposit ──
  console.log('═══ STEP 1: Solana Deposit (native SOL on devnet) ═══');
  let solDepositInfo;
  try {
    solDepositInfo = await depositSolOnDevnet();
  } catch (err) {
    console.log('  ⚠️  Solana deposit failed:', err.message);
    solDepositInfo = null;
  }
  console.log();

  // ── STEP 2: DCC Minting ──
  console.log('═══ STEP 2: DCC Mainnet Minting — 10 of each token ═══');
  console.log();

  const results = [];
  const solSlot = solDepositInfo?.solSlot || 999999;

  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    const amount = HUMAN_AMOUNT * (10 ** token.solDecimals); // 10 units in Solana smallest
    const transferIdHex = (i === 0 && solDepositInfo)
      ? solDepositInfo.transferIdHex
      : makeTransferId(token.symbol, i);

    console.log(`  [${i + 1}/${TOKENS.length}] ${token.symbol}`);
    console.log(`    Amount: ${HUMAN_AMOUNT} ${token.symbol} (${amount} smallest units)`);
    console.log(`    Transfer ID: ${transferIdHex.slice(0, 16)}...`);

    try {
      let txId;
      if (token.isNative) {
        // For native SOL, use the amount from actual deposit if available,
        // otherwise use the full 10 SOL equivalent
        const mintAmount = (solDepositInfo && i === 0) ? solDepositInfo.amount : amount;
        txId = await mintNativeSol(transferIdHex, mintAmount, solSlot);
      } else {
        txId = await mintSplToken(transferIdHex, amount, solSlot, token.splMint);
      }
      results.push({ symbol: token.symbol, status: '✅', txId, amount });
    } catch (err) {
      console.log(`    ❌ Failed: ${err.message}`);
      results.push({ symbol: token.symbol, status: '❌', error: err.message });
    }
    console.log();
  }

  // ── STEP 3: Verify balances ──
  console.log('═══ STEP 3: Verifying DCC Balances ═══');
  console.log();

  // Get all asset balances for the recipient
  try {
    const balances = await dccGet(`/assets/balance/${DCC_RECIPIENT}`);
    if (balances.balances && balances.balances.length > 0) {
      console.log(`  Token balances for ${DCC_RECIPIENT}:`);
      for (const b of balances.balances) {
        if (b.balance > 0) {
          const assetName = b.issueTransaction?.name || b.assetId?.slice(0, 12);
          console.log(`    ${assetName}: ${b.balance}`);
        }
      }
    }
  } catch (err) {
    console.log('  Could not fetch balances:', err.message);
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  GATEWAY TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();

  const pad = (s, n) => s.padEnd(n);
  console.log(`  ${pad('Token', 12)} ${pad('Status', 8)} TX ID`);
  console.log(`  ${'-'.repeat(70)}`);
  for (const r of results) {
    const txPart = r.txId ? r.txId.slice(0, 20) + '...' : (r.error || '').slice(0, 30);
    console.log(`  ${pad(r.symbol, 12)} ${pad(r.status, 8)} ${txPart}`);
  }

  const ok = results.filter(r => r.status === '✅').length;
  const fail = results.filter(r => r.status === '❌').length;
  console.log();
  console.log(`  Success: ${ok}/${results.length}   Failed: ${fail}`);
  console.log(`  Recipient: ${DCC_RECIPIENT}`);
  console.log(`  Explorer: https://decentralscan.com/address/${DCC_RECIPIENT}`);
  console.log();
}

main().catch(e => { console.error('\n❌ ERROR:', e.message || e); process.exit(1); });
