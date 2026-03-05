import React from 'react';
import { useBridgeStore, BridgeDirection } from '../hooks/useBridgeStore';
import { DepositForm } from './DepositForm';
import { RedeemForm } from './RedeemForm';
import { TransferProgress } from './TransferProgress';
import { TokenSelector, TokenLogo } from './TokenSelector';
import { BRIDGE_TOKENS, CATEGORY_LABELS, type BridgeToken } from '../config/tokens';

export function BridgeInterface() {
  const { direction, setDirection, activeTransfer, selectedToken, setSelectedToken } = useBridgeStore();

  if (activeTransfer) {
    return <TransferProgress />;
  }

  return (
    <div className="space-y-6">
      {/* Direction Toggle */}
      <div className="card">
        <div className="flex gap-2 p-1 bg-gray-800 rounded-xl">
          <button
            onClick={() => setDirection('sol_to_dcc')}
            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
              direction === 'sol_to_dcc'
                ? 'bg-purple-600 text-white shadow-lg'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <span>{selectedToken.symbol}</span>
            <span>→</span>
            <span>{selectedToken.wrappedSymbol}.DCC</span>
          </button>
          <button
            onClick={() => setDirection('dcc_to_sol')}
            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
              direction === 'dcc_to_sol'
                ? 'bg-teal-600 text-white shadow-lg'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <span>{selectedToken.wrappedSymbol}.DCC</span>
            <span>→</span>
            <span>{selectedToken.symbol}</span>
          </button>
        </div>
      </div>

      {/* Main Form */}
      {direction === 'sol_to_dcc' ? (
        <DepositForm />
      ) : (
        <RedeemForm />
      )}

      {/* Supported Tokens */}
      <SupportedTokens selectedToken={selectedToken} onSelect={setSelectedToken} />

      {/* How It Works */}
      <div className="card-glow">
        <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
          <span className="w-5 h-5 rounded gradient-zk flex items-center justify-center text-[10px] text-white font-bold">?</span>
          How It Works
        </h3>
        <div className="flex items-start gap-0 text-center">
          {[
            { icon: '◎', label: 'Lock SOL', desc: 'Deposit into PDA vault' },
            { icon: '⬡', label: 'Validate', desc: 'M-of-N checkpoint' },
            { icon: 'π', label: 'ZK Prove', desc: 'Groth16 proof gen' },
            { icon: '✓', label: 'Verify', desc: 'On-chain verification' },
            { icon: '⊕', label: 'Mint', desc: 'wSOL.DCC issued' },
          ].map((step, i) => (
            <React.Fragment key={step.label}>
              <div className="flex-1 min-w-0">
                <div className={`w-9 h-9 mx-auto rounded-full flex items-center justify-center text-sm font-bold ${
                  i === 2 || i === 3
                    ? 'gradient-zk text-white'
                    : 'bg-gray-800 text-gray-400 border border-gray-700'
                }`}>
                  {step.icon}
                </div>
                <p className="text-[11px] font-medium text-gray-300 mt-1.5">{step.label}</p>
                <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{step.desc}</p>
              </div>
              {i < 4 && (
                <div className="flex-shrink-0 w-6 flex items-center justify-center pt-3">
                  <div className="h-px w-full bg-gray-700" />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ZK Security Panel */}
      <div className="card bg-purple-950/20 border-purple-500/10">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-6 h-6 rounded-md gradient-zk flex items-center justify-center text-[10px] font-bold text-white">π</div>
          <h3 className="text-sm font-semibold text-purple-300">Zero-Knowledge Security</h3>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed mb-4">
          Every transfer is cryptographically verified with a <span className="text-purple-300 font-medium">Groth16 zero-knowledge proof</span> on
          the BN128 elliptic curve. No trust assumptions — only math.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '🔒', label: 'Groth16 ZK Proofs', desc: '3.5M constraint circuit' },
            { icon: '⬡', label: 'M-of-N Consensus', desc: 'Validator threshold signing' },
            { icon: '🏦', label: 'PDA-Controlled Vault', desc: 'Non-custodial on Solana' },
            { icon: '⚡', label: 'On-Chain Verification', desc: 'bn256Groth16Verify precompile' },
            { icon: '🛡️', label: 'Rate-Limited', desc: 'Circuit breaker protection' },
            { icon: '💎', label: '1:1 Collateralized', desc: 'Fully backed reserves' },
          ].map((item) => (
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
    </div>
  );
}

/* ── Supported Tokens Grid ── */

function SupportedTokens({
  selectedToken,
  onSelect,
}: {
  selectedToken: BridgeToken;
  onSelect: (t: BridgeToken) => void;
}) {
  const categoryOrder: BridgeToken['category'][] = [
    'native', 'stablecoin', 'btc', 'eth', 'ecosystem', 'meme',
  ];

  const grouped = BRIDGE_TOKENS.reduce<Record<string, BridgeToken[]>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">
        Supported Tokens
        <span className="text-gray-500 font-normal ml-2">({BRIDGE_TOKENS.length})</span>
      </h3>

      <div className="space-y-4">
        {categoryOrder.map((cat) => {
          const tokens = grouped[cat];
          if (!tokens) return null;
          return (
            <div key={cat}>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="flex flex-wrap gap-2">
                {tokens.map((token) => {
                  const isSelected = token.splMint === selectedToken.splMint;
                  return (
                    <button
                      key={token.splMint}
                      onClick={() => onSelect(token)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all ${
                        isSelected
                          ? 'border-purple-500 bg-purple-600/20 text-white shadow-md shadow-purple-500/10'
                          : 'border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
                      }`}
                    >
                      <TokenLogo token={token} size={20} />
                      <span className="font-medium">{token.symbol}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
