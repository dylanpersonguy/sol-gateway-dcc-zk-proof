import React, { useState } from 'react';
import {
  MINT_SOURCE_TOKENS,
  CR_STABLE,
  CR_MINT_FEE_RATE,
  CR_MINT_FEE_DISPLAY,
  CR_MINT_MINIMUM,
} from '../config/cr-stable';
import { useMintFlow } from '../hooks/useMintFlow';
import { RedeemCRStable } from './RedeemCRStable';
import { TransferProgress } from './TransferProgress';

const MINT_CONFIG = {
  sourceTokens: MINT_SOURCE_TOKENS,
  targetToken: CR_STABLE,
  feeRate: CR_MINT_FEE_RATE,
  feeDisplay: CR_MINT_FEE_DISPLAY,
  minimum: CR_MINT_MINIMUM,
};

export function MintCRStable() {
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
              <span>$</span> Mint {CR_STABLE.symbol}
            </button>
            <button
              onClick={() => setMode('redeem')}
              className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-orange-600 text-white shadow-lg"
            >
              <span>↩</span> Redeem {CR_STABLE.symbol}
            </button>
          </div>
        </div>
        <RedeemCRStable />
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
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-emerald-600 text-white shadow-lg"
          >
            <span>$</span> Mint {CR_STABLE.symbol}
          </button>
          <button
            onClick={() => setMode('redeem')}
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white"
          >
            <span>↩</span> Redeem {CR_STABLE.symbol}
          </button>
        </div>
      </div>

      {/* Hero */}
      <div className="card bg-gradient-to-br from-emerald-950/40 to-gray-900/40 border-emerald-500/20">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-emerald-500/30">
            $
          </div>
          <div>
            <h1 className="text-xl font-bold">Mint {CR_STABLE.symbol}</h1>
            <p className="text-xs text-gray-400">{CR_STABLE.fullName} — backed 1:1 by USD reserves</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Deposit USDT, USDC, or SOL on Solana. Your collateral is locked in the bridge vault and
          {' '}{CR_STABLE.symbol} is minted on DecentralChain via the ZK-verified gateway.
        </p>
      </div>

      {/* Source Token Selector */}
      <div className="card space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-3">Pay With</label>
          <div className="grid grid-cols-3 gap-2">
            {MINT_SOURCE_TOKENS.map((token) => (
              <button
                key={token.splMint}
                onClick={() => mint.setSelectedSource(token)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all ${
                  mint.selectedSource.splMint === token.splMint
                    ? 'border-emerald-500 bg-emerald-600/20 text-white shadow-md shadow-emerald-500/10'
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
                         focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
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
                       focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <MintFeeBreakdown
          mint={mint}
          config={MINT_CONFIG}
          accentColor="emerald"
        />

        {/* Mint Button */}
        {mint.walletConnected ? (
          <button
            onClick={mint.handleMint}
            disabled={mint.isSubmitting || !mint.validAmount || !mint.recipientDcc || (mint.isSOL && !mint.solQuote)}
            className="w-full py-3.5 rounded-xl font-semibold text-lg transition-all
                       bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600"
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
              `Mint ${CR_STABLE.symbol}`
            )}
          </button>
        ) : (
          <div className="text-center text-gray-500 text-sm py-3">
            Connect your Phantom wallet above to mint {CR_STABLE.symbol}
          </div>
        )}
      </div>

      <HowItWorks token={CR_STABLE} accentColor="emerald" />
      <ReserveInfo token={CR_STABLE} accentColor="emerald" />
    </div>
  );
}

/* ── Shared Sub-Components ── */

export function MintFeeBreakdown({ mint, config, accentColor }: {
  mint: ReturnType<typeof useMintFlow>;
  config: { feeDisplay: string; targetToken: { symbol: string } };
  accentColor: string;
}) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-4 space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-gray-400">You deposit</span>
        <span>{mint.amount || '0'} {mint.selectedSource.symbol}</span>
      </div>

      {mint.isSOL && mint.validAmount && (
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Jupiter swap</span>
          {mint.quoteLoading ? (
            <span className="text-gray-500 text-xs">Fetching quote...</span>
          ) : mint.solQuote ? (
            <span className="text-blue-400">
              ≈ {mint.solQuote.usdcAmount.toFixed(2)} USDC
              <span className="text-gray-500 text-xs ml-1">
                (1 SOL ≈ ${mint.solQuote.rate.toFixed(2)})
              </span>
            </span>
          ) : (
            <span className="text-gray-500 text-xs">—</span>
          )}
        </div>
      )}

      {mint.isSOL && mint.solQuote && parseFloat(mint.solQuote.priceImpact) > 1 && (
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Price impact</span>
          <span className="text-yellow-400 text-xs">{mint.solQuote.priceImpact}%</span>
        </div>
      )}

      <div className="flex justify-between text-sm">
        <span className="text-gray-400">Mint fee ({config.feeDisplay})</span>
        {mint.feeAmount > 0 ? (
          <span className="text-yellow-400">−${mint.feeAmount.toFixed(4)}</span>
        ) : (
          <span className="text-gray-500">—</span>
        )}
      </div>

      {mint.isSOL && (
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Process</span>
          <span className="text-xs text-blue-300">SOL → USDC (Jupiter) → Gateway → {config.targetToken.symbol}</span>
        </div>
      )}

      <div className="border-t border-gray-700 pt-2 mt-2" />

      <div className="flex justify-between text-sm font-medium">
        <span className="text-gray-300">You receive</span>
        <span className={`text-${accentColor}-400 text-lg`}>
          {mint.mintAmount > 0 ? `${mint.mintAmount.toFixed(2)} ${config.targetToken.symbol}` : `0 ${config.targetToken.symbol}`}
        </span>
      </div>

      <div className="flex justify-between text-sm">
        <span className="text-gray-400">Network</span>
        <span className="text-xs">DecentralChain</span>
      </div>

      <div className="flex justify-between text-sm">
        <span className="text-gray-400">Estimated time</span>
        <span className="text-xs">{mint.isSOL ? '~2 minutes' : '~45 seconds'}</span>
      </div>
    </div>
  );
}

export function HowItWorks({ token, accentColor }: { token: { symbol: string }; accentColor: string }) {
  const steps = [
    { icon: '💵', title: 'Deposit Collateral', desc: 'Send USDT, USDC, or SOL on Solana. SOL is auto-swapped to USDC via Jupiter.' },
    { icon: '🔒', title: 'Lock in Vault', desc: 'Your stablecoins are locked in the non-custodial bridge PDA vault on Solana.' },
    { icon: '🔐', title: 'ZK Verification', desc: 'Validators create a Groth16 zero-knowledge proof of the deposit.' },
    { icon: '💎', title: `Mint ${token.symbol}`, desc: `${token.symbol} is minted 1:1 on DecentralChain, fully backed by the locked reserves.` },
    { icon: '🔄', title: 'Redeem Anytime', desc: `Burn ${token.symbol} on DCC to unlock your USDT/USDC on Solana.` },
  ];

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
        <span className={`w-5 h-5 rounded bg-${accentColor}-600 flex items-center justify-center text-[10px] text-white font-bold`}>?</span>
        How {token.symbol} Works
      </h3>
      <div className="space-y-3">
        {steps.map((step) => (
          <div key={step.title} className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center text-base">
              {step.icon}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-200">{step.title}</div>
              <div className="text-xs text-gray-500 leading-relaxed">{step.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReserveInfo({ token, accentColor }: { token: { symbol: string }; accentColor: string }) {
  const items = [
    { icon: '🏦', label: '1:1 USD Backed', desc: 'USDT/USDC reserves' },
    { icon: '🔒', label: 'PDA Vault', desc: 'Non-custodial on Solana' },
    { icon: '🔐', label: 'ZK Verified', desc: 'Groth16 proof of reserves' },
    { icon: '🔄', label: 'Redeemable', desc: 'Burn to unlock collateral' },
  ];

  return (
    <div className={`card bg-${accentColor}-950/20 border-${accentColor}-500/10`}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-6 h-6 rounded-md bg-${accentColor}-600 flex items-center justify-center text-[10px] font-bold text-white`}>$</div>
        <h3 className={`text-sm font-semibold text-${accentColor}-300`}>Reserve Backing</h3>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed mb-3">
        Every {token.symbol} is backed 1:1 by USDT/USDC locked in the Solana bridge vault.
        Reserves are verifiable on-chain at any time.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-800/40 border border-gray-700/30">
            <span className="text-base flex-shrink-0 mt-0.5">{item.icon}</span>
            <div>
              <span className="text-xs font-medium text-gray-200 block">{item.label}</span>
              <span className="text-[10px] text-gray-500">{item.desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
