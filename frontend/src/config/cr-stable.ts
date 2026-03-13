/**
 * CR Stable configuration — a stablecoin backed 1:1 by USDT/USDC/SOL on Solana.
 * Minted on DCC chain via the bridge gateway.
 */

export interface MintableToken {
  /** SPL mint address on Solana */
  splMint: string;
  /** Display symbol */
  symbol: string;
  /** Full name */
  name: string;
  /** Decimals on Solana */
  decimals: number;
  /** Logo URL */
  logoURI: string;
  /** Whether this token requires a DEX swap before minting */
  requiresSwap: boolean;
}

const TOKEN_LIST_CDN =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';

/** Tokens accepted for minting CR Stable */
export const MINT_SOURCE_TOKENS: MintableToken[] = [
  {
    splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoURI: `${TOKEN_LIST_CDN}/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png`,
    requiresSwap: false,
  },
  {
    splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    logoURI: `${TOKEN_LIST_CDN}/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg`,
    requiresSwap: false,
  },
  {
    splMint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    logoURI: `${TOKEN_LIST_CDN}/So11111111111111111111111111111111111111112/logo.png`,
    requiresSwap: true,
  },
];

/** CR Stable token details on DCC chain */
export const CR_STABLE = {
  symbol: 'CRS',
  name: 'CR Stable',
  fullName: 'Stable CR Coin',
  decimals: 6,
  /** DCC asset ID — will be set after token issuance on DCC */
  dccAssetId: '',
  description: 'A stablecoin backed 1:1 by USDT/USDC reserves locked on Solana, bridged via the ZK-verified gateway.',
} as const;

/** Mint fee: 0.1% */
export const CR_MINT_FEE_RATE = 0.001;
export const CR_MINT_FEE_DISPLAY = '0.10%';

/** Redeem fee: 0.1% */
export const CR_REDEEM_FEE_RATE = 0.001;
export const CR_REDEEM_FEE_DISPLAY = '0.10%';

/** Minimum mint amount in USD */
export const CR_MINT_MINIMUM = 1;

export function getMintSourceBySymbol(symbol: string): MintableToken | undefined {
  return MINT_SOURCE_TOKENS.find((t) => t.symbol === symbol);
}

export function getMintSourceByMint(mint: string): MintableToken | undefined {
  return MINT_SOURCE_TOKENS.find((t) => t.splMint === mint);
}
