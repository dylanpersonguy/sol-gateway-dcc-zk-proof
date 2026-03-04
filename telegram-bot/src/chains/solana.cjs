'use strict';
/**
 * Solana chain helpers — balance checks, SPL token operations, monitoring
 */
const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  getAccount, getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const { createHash } = require('crypto');

// Known SPL token registry (subset — for the Telegram UI)
const KNOWN_TOKENS = {
  SOL:     { symbol: 'SOL',   mint: 'So11111111111111111111111111111111111111112', decimals: 9, isNative: true  },
  USDC:    { symbol: 'USDC',  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT:    { symbol: 'USDT',  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  PYUSD:   { symbol: 'PYUSD', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6 },
  JUP:     { symbol: 'JUP',   mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  BONK:    { symbol: 'BONK',  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
};

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Create a Connection instance
 */
function makeConnection(rpcUrl) {
  return new Connection(rpcUrl, { commitment: 'confirmed' });
}

/**
 * Get SOL balance in lamports
 */
async function getSolBalance(connection, pubkeyOrStr) {
  const pk = typeof pubkeyOrStr === 'string' ? new PublicKey(pubkeyOrStr) : pubkeyOrStr;
  return connection.getBalance(pk);
}

/**
 * Get SPL token balance in smallest units
 * Returns 0 if the ATA doesn't exist
 */
async function getSplBalance(connection, mintStr, ownerStr) {
  try {
    const mint  = new PublicKey(mintStr);
    const owner = new PublicKey(ownerStr);
    const ata   = getAssociatedTokenAddressSync(mint, owner);
    const acct  = await getAccount(connection, ata);
    return BigInt(acct.amount);
  } catch {
    return 0n;
  }
}

/**
 * Get all token balances for an address (SOL + known SPL tokens)
 * Returns: [{ symbol, balance, units, decimals, mint }]
 */
async function getAllBalances(connection, ownerStr) {
  const result = [];

  // SOL balance
  const lamports = await getSolBalance(connection, ownerStr);
  result.push({
    symbol: 'SOL', balance: lamports / 1e9, units: lamports,
    decimals: 9, mint: NATIVE_SOL_MINT, isNative: true,
  });

  // SPL tokens in parallel
  const splEntries = Object.values(KNOWN_TOKENS).filter(t => !t.isNative);
  await Promise.all(splEntries.map(async (t) => {
    const units = await getSplBalance(connection, t.mint, ownerStr);
    result.push({
      symbol: t.symbol, balance: Number(units) / 10 ** t.decimals,
      units: Number(units), decimals: t.decimals, mint: t.mint,
    });
  }));

  return result.filter(t => t.units > 0 || t.isNative);
}

/**
 * Scan recent signatures for incoming SPL token transfers to a given address.
 * Returns parsed transfer events: [{ mint, amountUnits, fromAddress, sig, slot }]
 */
async function scanIncomingSpl(connection, ownerStr, sinceSlot = 0) {
  const owner = new PublicKey(ownerStr);
  const transfers = [];

  const sigs = await connection.getSignaturesForAddress(owner, { limit: 50 });
  for (const sigInfo of sigs) {
    if (sigInfo.slot <= sinceSlot) continue;
    try {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.postTokenBalances) continue;

      const { preTokenBalances, postTokenBalances } = tx.meta;
      for (const post of postTokenBalances) {
        if (post.owner !== ownerStr) continue;
        const pre = preTokenBalances.find(
          p => p.accountIndex === post.accountIndex
        );
        const preAmt  = BigInt(pre?.uiTokenAmount?.amount || '0');
        const postAmt = BigInt(post.uiTokenAmount.amount);
        const delta   = postAmt - preAmt;
        if (delta > 0n) {
          transfers.push({
            mint:        post.mint,
            amountUnits: Number(delta),
            fromAddress: tx.transaction.message.accountKeys[0].pubkey.toBase58(),
            sig:         sigInfo.signature,
            slot:        sigInfo.slot,
          });
        }
      }
    } catch {
      // Skip malformed txs
    }
  }

  return transfers;
}

/**
 * Scan recent signatures for incoming SOL transfers to a given address.
 * Returns [{ amountLamports, fromAddress, sig, slot }]
 */
async function scanIncomingSol(connection, ownerStr, sinceSlot = 0) {
  const owner = new PublicKey(ownerStr);
  const transfers = [];

  const sigs = await connection.getSignaturesForAddress(owner, { limit: 50 });
  for (const sigInfo of sigs) {
    if (sigInfo.slot <= sinceSlot) continue;
    try {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;

      const acctKeys = tx.transaction.message.accountKeys;
      const ownerIdx = acctKeys.findIndex(k => k.pubkey.toBase58() === ownerStr);
      if (ownerIdx < 0) continue;

      const preLamports  = tx.meta.preBalances[ownerIdx];
      const postLamports = tx.meta.postBalances[ownerIdx];
      const delta = postLamports - preLamports;
      if (delta > 0) {
        transfers.push({
          amountLamports: delta,
          fromAddress: acctKeys[0].pubkey.toBase58(),
          sig:   sigInfo.signature,
          slot:  sigInfo.slot,
        });
      }
    } catch {
      // skip
    }
  }

  return transfers;
}

/**
 * Send SOL from a keypair to a destination
 */
async function sendSol(connection, fromKeypair, toAddress, lamports) {
  const { SystemProgram: SP } = require('@solana/web3.js');
  const ix = SP.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey:   new PublicKey(toAddress),
    lamports,
  });
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromKeypair.publicKey;
  return sendAndConfirmTransaction(connection, tx, [fromKeypair], { commitment: 'confirmed' });
}

module.exports = {
  makeConnection, getSolBalance, getSplBalance, getAllBalances,
  scanIncomingSpl, scanIncomingSol, sendSol,
  KNOWN_TOKENS, NATIVE_SOL_MINT,
};
