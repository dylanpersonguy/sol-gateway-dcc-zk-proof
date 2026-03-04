/**
 * Bridgeable token definitions for the frontend.
 * Logo URLs sourced from the Solana Token List CDN and CoinGecko.
 */

export interface BridgeToken {
  /** SPL mint address on Solana */
  splMint: string;
  /** Display symbol on Solana side (e.g. "SOL", "USDC") */
  symbol: string;
  /** Symbol on DCC side (e.g. "SOL", "USDC") */
  wrappedSymbol: string;
  /** Full token name */
  name: string;
  /** Decimals on Solana */
  solDecimals: number;
  /** Decimals on DCC */
  dccDecimals: number;
  /** Logo URL */
  logoURI: string;
  /** Category for grouping in the UI */
  category: 'native' | 'stablecoin' | 'btc' | 'eth' | 'ecosystem' | 'meme';
}

const TOKEN_LIST_CDN =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';

export const BRIDGE_TOKENS: BridgeToken[] = [
  // ── Native ──
  {
    splMint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    wrappedSymbol: 'SOL',
    name: 'Solana',
    solDecimals: 9,
    dccDecimals: 8,
    logoURI: `${TOKEN_LIST_CDN}/So11111111111111111111111111111111111111112/logo.png`,
    category: 'native',
  },

  // ── Stablecoins ──
  {
    splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    wrappedSymbol: 'USDC',
    name: 'USD Coin',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: `${TOKEN_LIST_CDN}/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png`,
    category: 'stablecoin',
  },
  {
    splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    wrappedSymbol: 'USDT',
    name: 'Tether USD',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: `${TOKEN_LIST_CDN}/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg`,
    category: 'stablecoin',
  },
  {
    splMint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    symbol: 'PYUSD',
    wrappedSymbol: 'PYUSD',
    name: 'PayPal USD',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/31212/small/PYUSD_Logo_%282%29.png',
    category: 'stablecoin',
  },
  {
    splMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'DAI',
    wrappedSymbol: 'DAI',
    name: 'Dai (Wormhole)',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: `${TOKEN_LIST_CDN}/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/logo.png`,
    category: 'stablecoin',
  },

  // ── BTC variants ──
  {
    splMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    symbol: 'BTC',
    wrappedSymbol: 'BTC',
    name: 'Bitcoin (Wormhole)',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: `${TOKEN_LIST_CDN}/3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh/logo.png`,
    category: 'btc',
  },
  {
    splMint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
    symbol: 'cbBTC',
    wrappedSymbol: 'cbBTC',
    name: 'Coinbase BTC',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: 'https://assets.coingecko.com/coins/images/40143/small/cbbtc.webp',
    category: 'btc',
  },
  {
    splMint: '6DNSN2BJsaPFdBAy8hkkkJ9QK64kAr7MRZGP9mLqPzQq',
    symbol: 'tBTC',
    wrappedSymbol: 'tBTC',
    name: 'Threshold BTC',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: 'https://assets.coingecko.com/coins/images/11224/small/0x18084fba666a33d37592fa2633fd49a74dd93a88.png',
    category: 'btc',
  },

  // ── ETH ──
  {
    splMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    symbol: 'ETH',
    wrappedSymbol: 'ETH',
    name: 'Ether (Wormhole)',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: `${TOKEN_LIST_CDN}/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs/logo.png`,
    category: 'eth',
  },

  // ── SOL ecosystem ──
  {
    splMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'JitoSOL',
    wrappedSymbol: 'JitoSOL',
    name: 'Jito Staked SOL',
    solDecimals: 9,
    dccDecimals: 8,
    logoURI: 'https://assets.coingecko.com/coins/images/28046/small/JitoSOL-200.png',
    category: 'ecosystem',
  },
  {
    splMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    wrappedSymbol: 'JUP',
    name: 'Jupiter',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/34188/small/jup.png',
    category: 'ecosystem',
  },
  {
    splMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'RAY',
    wrappedSymbol: 'RAY',
    name: 'Raydium',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: `${TOKEN_LIST_CDN}/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png`,
    category: 'ecosystem',
  },
  {
    splMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    symbol: 'PYTH',
    wrappedSymbol: 'PYTH',
    name: 'Pyth Network',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/31924/small/pyth.png',
    category: 'ecosystem',
  },
  {
    splMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    symbol: 'RNDR',
    wrappedSymbol: 'RNDR',
    name: 'Render Token',
    solDecimals: 8,
    dccDecimals: 8,
    logoURI: 'https://assets.coingecko.com/coins/images/11636/small/rndr.png',
    category: 'ecosystem',
  },

  // ── Memecoins ──
  {
    splMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    wrappedSymbol: 'BONK',
    name: 'Bonk',
    solDecimals: 5,
    dccDecimals: 5,
    logoURI: 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg',
    category: 'meme',
  },
  {
    splMint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
    symbol: 'PUMP',
    wrappedSymbol: 'PUMP',
    name: 'Pump.fun',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/47084/small/pump.jpg',
    category: 'meme',
  },
  {
    splMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
    symbol: 'PENGU',
    wrappedSymbol: 'PENGU',
    name: 'Pudgy Penguins',
    solDecimals: 6,
    dccDecimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/44471/small/pudgy.jpg',
    category: 'meme',
  },
];

/** Look up a token by its SPL mint address */
export function getTokenByMint(mint: string): BridgeToken | undefined {
  return BRIDGE_TOKENS.find((t) => t.splMint === mint);
}

/** The default token (SOL) */
export const DEFAULT_TOKEN = BRIDGE_TOKENS[0];

/** Category labels for grouping */
export const CATEGORY_LABELS: Record<BridgeToken['category'], string> = {
  native: 'Native',
  stablecoin: 'Stablecoins',
  btc: 'Bitcoin',
  eth: 'Ethereum',
  ecosystem: 'Ecosystem',
  meme: 'Meme',
};
