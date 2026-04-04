import React, { useState } from 'react';
import {
  DUSD_SOURCE_TOKENS,
  DUSD,
  DUSD_MINT_FEE_RATE,
  DUSD_MINT_FEE_DISPLAY,
  DUSD_MINT_MINIMUM,
} from '../config/dusd';
import { useMintFlow } from '../hooks/useMintFlow';
import { MintFeeBreakdown, HowItWorks, ReserveInfo } from './MintCRStable';
import { RedeemDUSD } from './RedeemDUSD';
import { TransferProgress } from './TransferProgress';

const MINT_CONFIG = {
  sourceTokens: DUSD_SOURCE_TOKENS,
  targetToken: DUSD,
  feeRate: DUSD_MINT_FEE_RATE,
  feeDisplay: DUSD_MINT_FEE_DISPLAY,
  minimum: DUSD_MINT_MINIMUM,
};

export function MintDUSD() {
  const [mode, setMode] = useState<'mint' | 'redeem'>('mint');
  const mint = useMintFlow(MINT_CONFIG);

  if (mint.activeTransfer) {
    return <TransferProgress />;
  }

  if (mode === 'redeem') {
    return (
      <div className="space-y-6">
        <div className="card">
          <div className="flex gap-2 p-1 bg-gray-800 rounded-xl">
            <button
              onClick={() => setMode('mint')}
              className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white"
            >
              <span>$</span> Mint {DUSD.symbol}
            </button>
            <button
              onClick={() => setMode('redeem')}
              className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-amber-600 text-white shadow-lg"
            >
              <span>↩</span> Redeem {DUSD.symbol}
            </button>
          </div>
        </div>
        <RedeemDUSD />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mode Toggle */}
      <div className="card">
        <div className="flex gap-2 p-1 bg-gray-800 rounded-xl">
          <button
            onClick={() => setMode('mint')}
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white shadow-lg"
          >
            <span>$</span> Mint {DUSD.symbol}
          </button>
          <button
            onClick={() => setMode('redeem')}
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white"
          >
            <span>↩</span> Redeem {DUSD.symbol}
          </button>
        </div>
      </div>

      {/* Hero */}
      <div className="card bg-gradient-to-br from-blue-950/40 to-gray-900/40 border-blue-500/20">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-blue-500/30">
            $
          </div>
          <div>
            <h1 className="text-xl font-bold">Mint {DUSD.symbol}</h1>
            <p className="text-xs text-gray-400">{DUSD.fullName} — backed 1:1 by USD reserves</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Deposit USDT, USDC, or SOL on Solana. Your collateral is locked in the bridge vault and
          {' '}{DUSD.symbol} is minted on DecentralChain via the ZK-verified gateway.
        </p>
      </div>

      {/* Source Token Selector */}
      <div className="card space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-3">Pay With</label>
          <div className="grid grid-cols-3 gap-2">
            {DUSD_SOURCE_TOKENS.map((token) => (
              <button
                key={token.splMint}
                onClick={() => mint.setSelectedSource(token)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all ${
                  mint.selectedSource.splMint === token.splMint
                    ? 'border-blue-500 bg-blue-600/20 text-white shadow-md shadow-blue-500/10'
                    : 'border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
                }`}
              >
                <img
                  src={token.logoURI}
                  alt={token.symbol}
                  className="w-6 h-6 rounded-full"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="text-left">
                  <div className="font-medium text-sm">{token.symbol}</div>
                  {token.requiresSwap && (
                    <div className="text-[9px] text-yellow-400">via Jupiter</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Amount</label>
          <div className="relative">
            <input
              type="number"
              value={mint.amount}
              onChange={(e) => mint.setAmount(e.target.value)}
              placeholder="0.00"
              min={mint.isSOL ? '0.01' : '1'}
              step={mint.isSOL ? '0.01' : '1'}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-lg
                         focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium">
              {mint.selectedSource.symbol}
            </span>
          </div>
        </div>

        {/* DCC Recipient */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">DCC Recipient Address</label>
          <input
            type="text"
            value={mint.recipientDcc}
            onChange={(e) => mint.setRecipientDcc(e.target.value)}
            placeholder="3P..."
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3
                       focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <MintFeeBreakdown
          mint={mint}
          config={MINT_CONFIG}
          accentColor="blue"
        />

        {/* Mint Button */}
        {mint.walletConnected ? (
          <button
            onClick={mint.handleMint}
            disabled={mint.isSubmitting || !mint.validAmount || !mint.recipientDcc || (mint.isSOL && !mint.solQuote)}
            className="w-full py-3.5 rounded-xl font-semibold text-lg transition-all
                       bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
          >
            {mint.isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {mint.isSOL ? 'Swapping & Minting...' : 'Minting...'}
              </span>
            ) : (
              `Mint ${DUSD.symbol}`
            )}
          </button>
        ) : (
          <div className="text-center text-gray-500 text-sm py-3">
            Connect your Phantom wallet above to mint {DUSD.symbol}
          </div>
        )}
      </div>

      <HowItWorks token={DUSD} accentColor="blue" />
      <ReserveInfo token={DUSD} accentColor="blue" />
    </div>
  );
}
