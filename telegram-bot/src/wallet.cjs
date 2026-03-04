'use strict';
/**
 * Deterministic custodial wallet derivation
 *
 * Each Telegram user gets a unique Solana keypair and DCC address
 * derived from the MASTER_SECRET + userId.  The same userId always
 * produces the same addresses so wallets survive restarts.
 *
 * Security: MASTER_SECRET must be kept secret. Anyone with it can
 * derive all user private keys.
 */
const { createHmac, createHash } = require('crypto');
const { Keypair }                = require('@solana/web3.js');
const { libs }                   = require('@decentralchain/decentralchain-transactions');
const { privateKey, publicKey, address } = libs.crypto;

/**
 * Derive a deterministic 32-byte seed for a user on a given chain.
 * Uses HMAC-SHA256(masterSecret, "chain:userId")
 */
function deriveBytes(masterSecret, chain, userId) {
  return createHmac('sha256', masterSecret)
    .update(`${chain}:${userId}`)
    .digest();
}

/**
 * Derive a custodial Solana keypair for a user
 * @param {string} masterSecret
 * @param {number|string} userId
 * @returns {{ keypair: Keypair, address: string }}
 */
function deriveSolanaWallet(masterSecret, userId) {
  const seed = deriveBytes(masterSecret, 'solana', String(userId));
  const keypair = Keypair.fromSeed(seed);
  return { keypair, address: keypair.publicKey.toBase58() };
}

/**
 * Derive a custodial DCC wallet for a user
 * @param {string} masterSecret
 * @param {number|string} userId
 * @param {string} chainIdChar  — '?' for mainnet
 * @returns {{ seed: string, publicKey: string, address: string }}
 */
function deriveDccWallet(masterSecret, userId, chainIdChar = '?') {
  // Build a hex string seed deterministically from masterSecret + userId
  const raw = deriveBytes(masterSecret, 'dcc', String(userId));
  // Use the hex of the HMAC as a DCC seed string — DCC libs treat seed as raw string
  const seedStr = raw.toString('hex');
  const pk   = publicKey(seedStr);
  const addr = address(seedStr, chainIdChar);
  const sk   = privateKey(seedStr);
  return { seed: seedStr, publicKey: pk, address: addr, privateKey: sk };
}

/**
 * Get signer object for DCC transactions
 * @param {string} seedStr
 * @returns {{ privateKey: string }}
 */
function dccSigner(seedStr) {
  return { privateKey: privateKey(seedStr) };
}

// ── Optional Vault / KMS adapter ──────────────────────────────
// Set VAULT_PROVIDER=aws-kms|hashicorp|none (default: none)
// When a vault provider is configured, MASTER_SECRET is fetched
// from the vault at startup instead of being read from env.
//
// Usage:  const secret = await getMasterSecret();

let _cachedSecret = null;

async function getMasterSecret() {
  if (_cachedSecret) return _cachedSecret;

  const provider = process.env.VAULT_PROVIDER || 'none';

  switch (provider) {
    case 'aws-kms': {
      // AWS Secrets Manager integration
      const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const resp = await client.send(new GetSecretValueCommand({
        SecretId: process.env.VAULT_SECRET_NAME || 'sol-gateway/master-secret',
      }));
      _cachedSecret = resp.SecretString;
      break;
    }
    case 'hashicorp': {
      // HashiCorp Vault integration
      const https = require('https');
      const http  = require('http');
      const vaultAddr = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
      const vaultPath = process.env.VAULT_SECRET_PATH || 'secret/data/sol-gateway';
      const proto = vaultAddr.startsWith('https') ? https : http;
      const resp = await new Promise((resolve, reject) => {
        const req = proto.get(`${vaultAddr}/v1/${vaultPath}`, {
          headers: { 'X-Vault-Token': process.env.VAULT_TOKEN },
        }, (res) => {
          let body = '';
          res.on('data', (d) => body += d);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
      });
      _cachedSecret = resp.data?.data?.master_secret;
      if (!_cachedSecret) throw new Error('master_secret not found in Vault');
      break;
    }
    default:
      // Use environment variable directly
      _cachedSecret = process.env.MASTER_SECRET;
      break;
  }

  if (!_cachedSecret) throw new Error('MASTER_SECRET not available from vault or env');
  return _cachedSecret;
}

module.exports = { deriveSolanaWallet, deriveDccWallet, dccSigner, getMasterSecret };
