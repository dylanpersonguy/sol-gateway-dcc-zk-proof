/**
 * Token Registry — SPL tokens supported by the SOL↔DCC bridge
 *
 * Each entry maps a Solana SPL token to its bridge configuration.
 * - splMint:     Solana SPL token mint address (base58)
 * - symbol:      Short ticker used as DCC wrapped asset name (e.g. "wUSDC")
 * - name:        Full display name
 * - description: Stored in the DCC Issue() transaction
 * - solDecimals: Decimal places on Solana
 * - dccDecimals: Decimal places on DCC (max 8)
 *
 * Native SOL (So11111111111111111111111111111111111111112) is auto-registered
 * during initialize() as "Wrapped SOL" — do NOT include here.
 *
 * All mint addresses verified via Solscan / CoinGecko.
 * Tokens without Solana SPL versions (ZEC, WBNB, USD1) are excluded.
 */

const TOKEN_REGISTRY = [
  // ── Stablecoins ──
  {
    splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'wUSDC',
    name: 'Wrapped USDC',
    description: 'Wrapped USDC (SPL) bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'wUSDT',
    name: 'Wrapped USDT',
    description: 'Wrapped USDT (SPL) bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    symbol: 'wPYUSD',
    name: 'Wrapped PYUSD',
    description: 'Wrapped PayPal USD (SPL) bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'wDAI',
    name: 'Wrapped DAI',
    description: 'Wrapped DAI (Wormhole) bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── BTC variants ──
  {
    splMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    symbol: 'wBTC',
    name: 'Wrapped BTC',
    description: 'Wrapped Bitcoin (Wormhole/Portal) bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    // Verified on Solscan: Coinbase Wrapped BTC (cbBTC), 8 decimals
    splMint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
    symbol: 'wcbBTC',
    name: 'Wrapped cbBTC',
    description: 'Wrapped Coinbase BTC bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    splMint: '6DNSN2BJsaPFdBAy8hkkkJ9QK64kAr7MRZGP9mLqPzQq',
    symbol: 'wtBTC',
    name: 'Wrapped tBTC',
    description: 'Wrapped Threshold BTC bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── ETH ──
  {
    splMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    symbol: 'wETH',
    name: 'Wrapped ETH',
    description: 'Wrapped Ether (Wormhole/Portal) bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── SOL ecosystem ──
  {
    splMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'wJitoSOL',
    name: 'Wrapped JitoSOL',
    description: 'Wrapped JitoSOL (liquid staking) bridged from Solana via sol-gateway-dcc',
    solDecimals: 9,
    dccDecimals: 8,
  },

  // ── Memecoins & ecosystem tokens ──
  {
    // Verified on Solscan: BONK, 5 decimals
    splMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'wBONK',
    name: 'Wrapped BONK',
    description: 'Wrapped BONK bridged from Solana via sol-gateway-dcc',
    solDecimals: 5,
    dccDecimals: 5,
  },
  {
    // Verified via CoinGecko: Pump.fun (PUMP), 6 decimals
    splMint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
    symbol: 'wPUMP',
    name: 'Wrapped PUMP',
    description: 'Wrapped Pump.fun bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'wJUP',
    name: 'Wrapped JUP',
    description: 'Wrapped Jupiter bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'wRAY',
    name: 'Wrapped RAY',
    description: 'Wrapped Raydium bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    symbol: 'wPYTH',
    name: 'Wrapped PYTH',
    description: 'Wrapped Pyth Network bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    // Verified on Solscan: Render Token (RENDER), 8 decimals
    splMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    symbol: 'wRNDR',
    name: 'Wrapped RNDR',
    description: 'Wrapped Render Token bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    // Verified on Solscan + CoinGecko: Pudgy Penguins (PENGU), 6 decimals
    splMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
    symbol: 'wPENGU',
    name: 'Wrapped PENGU',
    description: 'Wrapped Pudgy Penguins bridged from Solana via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
];

module.exports = { TOKEN_REGISTRY };
