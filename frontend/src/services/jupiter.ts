/**
 * Jupiter DEX integration for converting SOL → USDC before CR Stable minting.
 * Uses the Jupiter V6 Quote + Swap API.
 */
import axios from 'axios';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

/** USDC mint on Solana mainnet */
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Native SOL mint */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
}

export interface SwapTransaction {
  swapTransaction: string; // base64-encoded versioned transaction
  lastValidBlockHeight: number;
}

/**
 * Get a quote for swapping SOL → USDC via Jupiter.
 * @param amountLamports Amount of SOL in lamports (1 SOL = 1e9)
 * @param slippageBps Slippage tolerance in basis points (default: 50 = 0.5%)
 */
export async function getSwapQuote(
  amountLamports: bigint | number,
  slippageBps = 50,
): Promise<JupiterQuote> {
  const { data } = await axios.get(`${JUPITER_API}/quote`, {
    params: {
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: amountLamports.toString(),
      slippageBps,
      onlyDirectRoutes: false,
    },
  });
  return data;
}

/**
 * Build a swap transaction from a Jupiter quote.
 * Returns a serialized versioned transaction for the user to sign.
 * @param quote The quote from getSwapQuote
 * @param userPublicKey The user's Solana wallet public key (base58)
 */
export async function buildSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<SwapTransaction> {
  const { data } = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  });
  return data;
}

/**
 * Get the estimated USDC output for a given SOL amount.
 * Convenience method for UI display.
 * @param solAmount SOL amount as a decimal (e.g. 1.5 for 1.5 SOL)
 */
export async function estimateUsdcOutput(solAmount: number): Promise<{
  usdcAmount: number;
  priceImpact: string;
  rate: number;
}> {
  const lamports = BigInt(Math.round(solAmount * 1e9));
  const quote = await getSwapQuote(lamports);
  const usdcAmount = Number(quote.outAmount) / 1e6;
  const rate = usdcAmount / solAmount;
  return {
    usdcAmount,
    priceImpact: quote.priceImpactPct,
    rate,
  };
}
