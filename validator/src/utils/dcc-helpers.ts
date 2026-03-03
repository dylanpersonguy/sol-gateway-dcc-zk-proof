// ═══════════════════════════════════════════════════════════════
// DCC HELPERS — Shared utilities for DecentralChain interaction
// ═══════════════════════════════════════════════════════════════
//
// Uses @decentralchain/decentralchain-transactions for:
// - Transaction signing (invokeScript)
// - Broadcasting
// - Node interaction (balance, accountData, height)
// - Address validation

import {
  invokeScript,
  broadcast,
  nodeInteraction,
  waitForTx,
  libs,
} from '@decentralchain/decentralchain-transactions';

// Re-export for convenience
export { nodeInteraction, waitForTx, libs };

// DCC chain IDs
export const DCC_MAINNET_CHAIN_ID = '?';  // 63 — produces 3D... addresses
export const DCC_TESTNET_CHAIN_ID = 'T';  // 84

/**
 * Validate a DCC address format (base58, starts with 3, 35 chars)
 */
export function isValidDccAddress(address: string): boolean {
  if (!address || address.length < 26 || address.length > 36) return false;
  // DCC addresses start with '3' (like Waves)
  if (!address.startsWith('3D')) return false;
  // Check base58 characters only
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  return base58Regex.test(address);
}

/**
 * Get the current blockchain height from a DCC node
 */
export async function getDccHeight(nodeUrl: string): Promise<number> {
  const height = await nodeInteraction.currentHeight(nodeUrl);
  return height;
}

/**
 * Get account data entries from DCC node
 */
export async function getDccAccountData(
  address: string,
  nodeUrl: string,
): Promise<Record<string, any>> {
  const data = await nodeInteraction.accountData(address, nodeUrl);
  return data;
}

/**
 * Get a specific data entry from a DCC account
 */
export async function getDccAccountDataByKey(
  address: string,
  key: string,
  nodeUrl: string,
): Promise<any> {
  const data = await nodeInteraction.accountDataByKey(key, address, nodeUrl);
  return data;
}

/**
 * Get DCC account balance
 */
export async function getDccBalance(
  address: string,
  nodeUrl: string,
): Promise<number> {
  const balance = await nodeInteraction.balance(address, nodeUrl);
  return balance as number;
}

/**
 * Get asset balance for an account
 */
export async function getDccAssetBalance(
  assetId: string,
  address: string,
  nodeUrl: string,
): Promise<number> {
  const balance = await nodeInteraction.assetBalance(assetId, address, nodeUrl);
  return balance as number;
}

/**
 * Build, sign, and broadcast a mint invocation to the DCC bridge controller.
 *
 * @param params.dApp - Bridge controller address
 * @param params.transferId - Unique transfer ID (hex string)
 * @param params.recipient - DCC recipient address
 * @param params.amount - Amount in smallest units (lamports-equivalent)
 * @param params.solSlot - Solana slot of the deposit
 * @param params.signatures - Validator signatures (base64)
 * @param params.pubkeys - Validator public keys (base64)
 * @param params.chainId - DCC chain ID character ('?' for mainnet)
 * @param params.nodeUrl - DCC node URL
 * @param params.seed - Validator's DCC seed phrase for signing
 */
export async function signAndBroadcastMint(params: {
  dApp: string;
  transferId: string;
  recipient: string;
  amount: number;
  solSlot: number;
  signatures: string[];
  pubkeys: string[];
  chainId: string;
  nodeUrl: string;
  seed: string;
}): Promise<{ id: string }> {
  // Build the invokeScript transaction matching the RIDE contract's mint function:
  //   func mint(transferId: String, recipient: String, amount: Int, solSlot: Int,
  //             signatures: List[ByteVector], pubkeys: List[ByteVector])
  const signedTx = invokeScript(
    {
      dApp: params.dApp,
      call: {
        function: 'mint',
        args: [
          { type: 'string', value: params.transferId },
          { type: 'string', value: params.recipient },
          { type: 'integer', value: params.amount },
          { type: 'integer', value: params.solSlot },
          {
            type: 'list',
            value: params.signatures.map((sig) => ({
              type: 'binary',
              value: `base64:${sig}`,
            })),
          },
          {
            type: 'list',
            value: params.pubkeys.map((pk) => ({
              type: 'binary',
              value: `base64:${pk}`,
            })),
          },
        ],
      },
      payment: [],
      fee: 500000, // 0.005 DCC
      chainId: params.chainId,
    },
    params.seed,
  );

  // Broadcast the signed transaction
  const result = await broadcast(signedTx as any, params.nodeUrl);
  return { id: result.id };
}

/**
 * Build a burn instruction (unsigned) for client-side signing.
 * The client will sign this with their DCC wallet.
 *
 * @param params.dApp - Bridge controller address
 * @param params.solRecipient - Solana address to receive unlocked SOL
 * @param params.wsolAssetId - wSOL.DCC asset ID
 * @param params.amount - Amount in smallest units
 * @param params.chainId - DCC chain ID character
 */
export function buildBurnInstruction(params: {
  dApp: string;
  solRecipient: string;
  wsolAssetId: string;
  amount: number;
  chainId: string;
}) {
  // This returns the unsigned transaction params that the client
  // will sign with their DCC wallet (e.g., via @decentralchain/signer)
  return {
    type: 16, // InvokeScript
    dApp: params.dApp,
    call: {
      function: 'burn',
      args: [{ type: 'string', value: params.solRecipient }],
    },
    payment: [
      {
        assetId: params.wsolAssetId,
        amount: params.amount,
      },
    ],
    fee: 500000, // 0.005 DCC
    chainId: params.chainId,
  };
}

/**
 * Get bridge stats from the DCC contract's data storage
 */
export async function getBridgeStats(
  contractAddress: string,
  nodeUrl: string,
): Promise<{
  totalMinted: number;
  totalBurned: number;
  outstanding: number;
  validatorCount: number;
  paused: boolean;
  dailyMinted: number;
}> {
  const data = await nodeInteraction.accountData(contractAddress, nodeUrl);
  return {
    totalMinted: (data.total_minted?.value as number) ?? 0,
    totalBurned: (data.total_burned?.value as number) ?? 0,
    outstanding:
      ((data.total_minted?.value as number) ?? 0) -
      ((data.total_burned?.value as number) ?? 0),
    validatorCount: (data.validator_count?.value as number) ?? 0,
    paused: (data.paused?.value as boolean) ?? false,
    dailyMinted: (data.daily_minted?.value as number) ?? 0,
  };
}

/**
 * Check if a transfer has been processed on DCC
 */
export async function isTransferProcessed(
  contractAddress: string,
  transferId: string,
  nodeUrl: string,
): Promise<boolean> {
  try {
    const entry = await nodeInteraction.accountDataByKey(
      `processed_${transferId}`,
      contractAddress,
      nodeUrl,
    );
    return entry?.value === true;
  } catch {
    return false;
  }
}

/**
 * Get burn record from DCC contract
 */
export async function getBurnRecord(
  contractAddress: string,
  burnId: string,
  nodeUrl: string,
): Promise<{
  sender: string;
  solRecipient: string;
  amount: number;
  height: number;
  timestamp: number;
} | null> {
  try {
    const entry = await nodeInteraction.accountDataByKey(
      `burn_${burnId}`,
      contractAddress,
      nodeUrl,
    );
    if (!entry || typeof entry.value !== 'string') return null;

    const parts = (entry.value as string).split('|');
    if (parts.length < 5) return null;

    return {
      sender: parts[0],
      solRecipient: parts[1],
      amount: parseInt(parts[2]),
      height: parseInt(parts[3]),
      timestamp: parseInt(parts[4]),
    };
  } catch {
    return null;
  }
}

/**
 * Derive DCC address from seed phrase
 */
export function getAddressFromSeed(seed: string, chainId: string): string {
  return libs.crypto.address(seed, chainId);
}

/**
 * Get public key from seed phrase
 */
export function getPublicKeyFromSeed(seed: string): string {
  return libs.crypto.keyPair(seed).publicKey;
}
