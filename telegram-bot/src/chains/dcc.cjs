'use strict';
/**
 * DecentralChain API helpers — balance, token registry, broadcast, monitor
 */
const { invokeScript, transfer, libs } = require('@decentralchain/decentralchain-transactions');
const { privateKey, publicKey, address, seedWithNonce, base58Decode, signBytes } = libs.crypto;

// DCC chain ID (integer constant used in canonical mint message)
const DCC_CHAIN_ID_INT = 2;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Low-level fetch wrappers ───────────────────────────────────
async function dccGet(nodeUrl, path) {
  const r = await fetch(`${nodeUrl}${path}`);
  if (!r.ok) throw new Error(`DCC GET ${path} → ${r.status}`);
  return r.json();
}

async function dccPost(nodeUrl, path, body, apiKey = '') {
  const r = await fetch(`${nodeUrl}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC ${path}: ${d.message || JSON.stringify(d)}`);
  return d;
}

// ── Chain info ─────────────────────────────────────────────────
async function getHeight(nodeUrl) {
  const d = await dccGet(nodeUrl, '/blocks/height');
  return d.height;
}

// ── Balances ──────────────────────────────────────────────────
async function getDccBalance(nodeUrl, address) {
  const d = await dccGet(nodeUrl, `/addresses/balance/${address}`);
  return d.balance || 0;    // in Decens (10^-8 DCC)
}

async function getAssetBalance(nodeUrl, address, assetId) {
  try {
    const d = await dccGet(nodeUrl, `/assets/balance/${address}/${assetId}`);
    return d.balance || 0;
  } catch {
    return 0;
  }
}

async function getAllAssetBalances(nodeUrl, address) {
  try {
    const d = await dccGet(nodeUrl, `/assets/balance/${address}`);
    return d.balances || [];
  } catch {
    return [];
  }
}

// ── Data entries ──────────────────────────────────────────────
async function getDataEntry(nodeUrl, contractAddress, key) {
  try {
    return await dccGet(nodeUrl, `/addresses/data/${contractAddress}/${encodeURIComponent(key)}`);
  } catch {
    return null;
  }
}

async function getTokenAssetId(nodeUrl, bridgeAddress, splMint) {
  const entry = await getDataEntry(nodeUrl, bridgeAddress, `token_${splMint}_asset_id`);
  return entry?.value || null;
}

async function getBridgeTokenList(nodeUrl, bridgeAddress) {
  try {
    const all = await dccGet(nodeUrl, `/addresses/data/${bridgeAddress}`);
    const tokens = [];
    for (const e of all) {
      const m = e.key?.match(/^token_(.+)_asset_id$/);
      if (m) {
        const splMint = m[1];
        const nameEntry  = all.find(x => x.key === `token_${splMint}_name`);
        const solDecEntry = all.find(x => x.key === `token_${splMint}_sol_decimals`);
        const dccDecEntry = all.find(x => x.key === `token_${splMint}_dcc_decimals`);
        const enabledEntry = all.find(x => x.key === `token_${splMint}_enabled`);
        tokens.push({
          splMint,
          dccAssetId: e.value,
          symbol:     nameEntry?.value || splMint.slice(0, 6),
          solDecimals: solDecEntry?.value ?? 6,
          dccDecimals: dccDecEntry?.value ?? 6,
          enabled:     enabledEntry?.value !== false,
        });
      }
    }
    return tokens;
  } catch {
    return [];
  }
}

// ── Tx broadcast + confirm ────────────────────────────────────
async function broadcast(nodeUrl, tx, apiKey = '') {
  return dccPost(nodeUrl, '/transactions/broadcast', tx, apiKey);
}

async function waitForTx(nodeUrl, txId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(nodeUrl, `/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    await sleep(3000);
  }
  throw new Error(`DCC tx ${txId} not confirmed after ${attempts * 3}s`);
}

// ── Validator mintToken call ──────────────────────────────────
async function validatorMintToken({
  nodeUrl, apiKey, bridgeAddress, chainIdChar,
  validatorSeedStr, validatorPubKey,
  transferIdHex, dccRecipient, amountUnits, solSlot, splMint,
}) {
  const pk     = privateKey(validatorSeedStr);
  const signer = { privateKey: pk };
  const validatorPKBytes = Buffer.from(base58Decode(validatorPubKey));

  // ── Sign the canonical mint message ─────────────────────────
  // RIDE contract: constructMintMessage produces:
  //   "SOL_DCC_BRIDGE_V2|MINT|{transferId}|{recipient}|{amount}|{solSlot}|{splMint}|{chainId}"
  const canonicalMsg =
    `SOL_DCC_BRIDGE_V2|MINT|${transferIdHex}|${dccRecipient}|${amountUnits}|${solSlot}|${splMint}|${DCC_CHAIN_ID_INT}`;
  const msgBytes  = Buffer.from(canonicalMsg, 'utf8');
  const sigBase58 = signBytes({ privateKey: pk }, msgBytes);
  const sigBytes  = Buffer.from(base58Decode(sigBase58));

  const tx = invokeScript(
    {
      dApp:  bridgeAddress,
      call: {
        function: 'mintToken',
        args: [
          { type: 'string',  value: transferIdHex },
          { type: 'string',  value: dccRecipient },
          { type: 'integer', value: amountUnits },
          { type: 'integer', value: solSlot || 0 },
          { type: 'string',  value: splMint },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + sigBytes.toString('base64') }] },
          { type: 'list', value: [{ type: 'binary', value: 'base64:' + validatorPKBytes.toString('base64') }] },
        ],
      },
      payment: [],
      chainId: chainIdChar,
      fee: 5000000,
      senderPublicKey: validatorPubKey,
      version: 1,
    },
    signer
  );

  const resp = await broadcast(nodeUrl, tx, apiKey);
  return resp.id;
}

// ── DCC burnToken scan ────────────────────────────────────────
/**
 * Scan DCC data entries for burn records submitted by a user's DCC address.
 * The bridge stores burn records as: burn_{burnId}  = "pending" | "unlocked"
 */
async function scanBurnRecords(nodeUrl, bridgeAddress, sinceHeight = 0) {
  try {
    const allTx = await dccGet(
      nodeUrl,
      `/transactions/address/${bridgeAddress}/limit/50`
    );
    const txList = allTx[0] || [];
    const burns = [];

    for (const tx of txList) {
      if (tx.height <= sinceHeight) continue;
      if (tx.type !== 16) continue;  // InvokeScript
      if (tx.dApp !== bridgeAddress) continue;
      if (tx.call?.function !== 'burnToken') continue;

      burns.push({
        dccTxId:    tx.id,
        sender:     tx.sender,
        solRecipient: tx.call.args?.[0]?.value,
        splMint:    tx.call.args?.[1]?.value,
        amountUnits: tx.payment?.[0]?.amount || 0,
        assetId:    tx.payment?.[0]?.assetId,
        height:     tx.height,
        timestamp:  tx.timestamp,
      });
    }

    return burns;
  } catch {
    return [];
  }
}

// ── Validator unlock call (for DCC → SOL) ─────────────────────
async function validatorUnlock({
  nodeUrl, apiKey, bridgeAddress, chainIdChar,
  validatorSeedStr, validatorPubKey,
  burnTxId, solRecipient, amountUnits, splMint,
}) {
  // The Solana unlock instruction would be called here.
  // Delegated to bridge/relay.cjs for full implementation.
  throw new Error('unlock not yet implemented in dcc.cjs — see relay.cjs');
}

// ── Get validator address from seed ───────────────────────────
function getValidatorInfo(seedStr) {
  const pk   = publicKey(seedStr);
  const addr = address(seedStr, '?');
  return { publicKey: pk, address: addr };
}

module.exports = {
  getHeight, getDccBalance, getAssetBalance, getAllAssetBalances,
  getDataEntry, getTokenAssetId, getBridgeTokenList,
  broadcast, waitForTx,
  validatorMintToken, scanBurnRecords, validatorUnlock,
  getValidatorInfo,
};
