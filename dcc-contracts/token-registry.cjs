/**
 * Token Registry — SPL tokens supported by the SOL↔DCC bridge
 *
 * Each entry maps a Solana SPL token to its bridge configuration.
 * - splMint:     Solana SPL token mint address (base58)
 * - symbol:      Short ticker used as DCC asset name (e.g. "USDC")
 * - name:        Full display name
 * - description: Stored in the DCC Issue() transaction
 * - solDecimals: Decimal places on Solana
 * - dccDecimals: Decimal places on DCC (max 8)
 *
 * Native SOL (So11111111111111111111111111111111111111112) is auto-registered
 * during initialize() as "SOL" — do NOT include here.
 *
 * All mint addresses verified via Solscan / CoinGecko.
 * Tokens without Solana SPL versions (ZEC, WBNB, USD1) are excluded.
 */

const TOKEN_REGISTRY = [
  // ── Stablecoins ──
  {
    splMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USDC',
    description: 'USD Coin — regulated dollar stablecoin issued by Circle on Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    name: 'USDT',
    description: 'Tether USD — largest stablecoin by market cap, issued on Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    symbol: 'PYUSD',
    name: 'PYUSD',
    description: 'PayPal USD — dollar stablecoin issued by PayPal on Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'DAI',
    name: 'DAI Stablecoin',
    description: 'DAI — decentralized overcollateralized stablecoin by MakerDAO, bridged from Solana via Wormhole and sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── BTC variants ──
  {
    splMint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    symbol: 'BTC',
    name: 'Bitcoin',
    description: 'Bitcoin — original proof-of-work cryptocurrency, bridged from Solana via Wormhole/Portal and sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    // Verified on Solscan: Coinbase Wrapped BTC (cbBTC), 8 decimals
    splMint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
    symbol: 'cbBTC',
    name: 'cbBTC',
    description: 'Coinbase Bitcoin — BTC 1:1 backed and custodied by Coinbase, bridged from Solana to DecentralChain via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    splMint: '6DNSN2BJsaPFdBAy8hkkkJ9QK64kAr7MRZGP9mLqPzQq',
    symbol: 'tBTC',
    name: 'tBTC',
    description: 'Threshold Bitcoin — permissionless decentralized BTC bridge token by Threshold Network, bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── ETH ──
  {
    splMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    symbol: 'ETH',
    name: 'Ether',
    description: 'Ether — native token of the Ethereum blockchain, bridged from Solana via Wormhole/Portal and sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },

  // ── SOL ecosystem ──
  {
    splMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'JitoSOL',
    name: 'JitoSOL',
    description: 'Jito Staked SOL — liquid staking token earning MEV-boosted rewards via Jito protocol on Solana, bridged via sol-gateway-dcc',
    solDecimals: 9,
    dccDecimals: 8,
  },

  // ── Memecoins & ecosystem tokens ──
  {
    // Verified on Solscan: BONK, 5 decimals
    splMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    name: 'BONK',
    description: 'BONK — Solana community memecoin originally airdropped to developers and NFT holders, bridged via sol-gateway-dcc',
    solDecimals: 5,
    dccDecimals: 5,
  },
  {
    // Verified via CoinGecko: Pump.fun (PUMP), 6 decimals
    splMint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
    symbol: 'PUMP',
    name: 'PUMP',
    description: 'Pump.fun — platform/governance token of the Pump.fun memecoin launchpad on Solana, bridged via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    name: 'Jupiter',
    description: 'Jupiter — governance token of Jupiter, the largest DEX aggregator on Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'RAY',
    name: 'Raydium',
    description: 'Raydium — governance and utility token of Raydium AMM/DEX on Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    splMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    symbol: 'PYTH',
    name: 'PYTH',
    description: 'Pyth Network — oracle network token providing real-time financial data feeds on Solana, bridged via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
  {
    // Verified on Solscan: Render Token (RENDER), 8 decimals
    splMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    symbol: 'RNDR',
    name: 'RNDR',
    description: 'Render Token — decentralized GPU rendering network powering AI and 3D content creation, bridged from Solana via sol-gateway-dcc',
    solDecimals: 8,
    dccDecimals: 8,
  },
  {
    // Verified on Solscan + CoinGecko: Pudgy Penguins (PENGU), 6 decimals
    splMint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
    symbol: 'PENGU',
    name: 'PENGU',
    description: 'Pudgy Penguins — token of the iconic Pudgy Penguins NFT collection on Ethereum/Solana, bridged to DecentralChain via sol-gateway-dcc',
    solDecimals: 6,
    dccDecimals: 6,
  },
];

module.exports = { TOKEN_REGISTRY };
