// ═══════════════════════════════════════════════════════════════
// DCC HELPERS — API-side utilities for DecentralChain interaction
// ═══════════════════════════════════════════════════════════════

import {
  nodeInteraction,
  waitForTx,
  libs,
} from '@decentralchain/decentralchain-transactions';

export { nodeInteraction, waitForTx, libs };

export const DCC_MAINNET_CHAIN_ID = '?';  // 63 — produces 3D... addresses
export const DCC_TESTNET_CHAIN_ID = 'T';

// ── Config loaded from env ──
export function getDccConfig() {
  return {
    nodeUrl: process.env.DCC_NODE_URL || 'https://mainnet-node.decentralchain.io',
    bridgeContract: process.env.DCC_BRIDGE_CONTRACT || '',
    wsolAssetId: process.env.SOL_ASSET_ID || process.env.WSOL_ASSET_ID || '',
    chainIdChar: process.env.DCC_CHAIN_ID_CHAR || '?',
  };
}

/**
 * Validate a DCC address format
 */
export function isValidDccAddress(address: string): boolean {
  if (!address || address.length < 26 || address.length > 36) return false;
  if (!address.startsWith('3D')) return false;
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  return base58Regex.test(address);
}

/**
 * Get the current blockchain height from a DCC node
 */
export async function getDccHeight(nodeUrl: string): Promise<number> {
  return nodeInteraction.currentHeight(nodeUrl);
}

/**
 * Get account data entries from DCC node
 */
export async function getDccAccountData(
  address: string,
  nodeUrl: string,
): Promise<Record<string, any>> {
  return nodeInteraction.accountData(address, nodeUrl);
}

/**
 * Get a specific data entry from a DCC account
 */
export async function getDccAccountDataByKey(
  address: string,
  key: string,
  nodeUrl: string,
): Promise<any> {
  return nodeInteraction.accountDataByKey(key, address, nodeUrl);
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
  splMint: string;
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
    if (parts.length < 6) return null;
    return {
      sender: parts[0],
      solRecipient: parts[1],
      splMint: parts[2],
      amount: parseInt(parts[3]),
      height: parseInt(parts[4]),
      timestamp: parseInt(parts[5]),
    };
  } catch {
    return null;
  }
}

/**
 * Build a burn instruction (unsigned) for client-side signing.
 */
export function buildBurnInstruction(params: {
  dApp: string;
  solRecipient: string;
  wsolAssetId: string;
  amount: number;
  chainId: string;
}) {
  return {
    type: 16,
    dApp: params.dApp,
    call: {
      function: 'burn',
      args: [{ type: 'string' as const, value: params.solRecipient }],
    },
    payment: [
      {
        assetId: params.wsolAssetId,
        amount: params.amount,
      },
    ],
    fee: 500000,
    chainId: params.chainId,
  };
}
