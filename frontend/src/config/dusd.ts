/**
 * DUSD (Decentral USD) configuration — a stablecoin backed 1:1 by USDC/USDT on Solana.
 * Minted on DCC chain via the DUSD smart contract.
 */

import { type MintableToken } from './cr-stable';

const TOKEN_LIST_CDN =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';

/** Tokens accepted for minting DUSD */
export const DUSD_SOURCE_TOKENS: MintableToken[] = [
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

/** DUSD token details on DCC chain */
export const DUSD = {
  symbol: 'DUSD',
  name: 'Decentral USD',
  fullName: 'Decentral USD Stablecoin',
  decimals: 6,
  dccAssetId: 'ACmPEtWQLQnZJcvZD7BWrnc4EySyu2kYFzEF8YFRcH9q',
  contractAddress: '3DNgmqL8JGBFTWFL7bB92EdZT2wSA8yNFZW',
  description: 'A decentralized stablecoin backed 1:1 by USDC/USDT reserves locked on Solana via the ZK-verified gateway.',
} as const;

/** Mint fee: 0.1% */
export const DUSD_MINT_FEE_RATE = 0.001;
export const DUSD_MINT_FEE_DISPLAY = '0.10%';

/** Redeem fee: 0.1% */
export const DUSD_REDEEM_FEE_RATE = 0.001;
export const DUSD_REDEEM_FEE_DISPLAY = '0.10%';

/** Minimum mint/redeem amount in USD */
export const DUSD_MINT_MINIMUM = 1;
