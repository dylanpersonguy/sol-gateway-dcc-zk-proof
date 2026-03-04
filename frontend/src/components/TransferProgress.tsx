import React, { useEffect, useState } from 'react';
import { useBridgeStore } from '../hooks/useBridgeStore';
import { bridgeApi } from '../services/api';
import { getTokenByMint, DEFAULT_TOKEN } from '../config/tokens';
import { TokenLogo } from './TokenSelector';

const STEPS = {
  sol_to_dcc: [
    { key: 'pending_confirmation', label: 'Confirming on Solana', description: 'Waiting for 32+ block confirmations' },
    { key: 'awaiting_consensus', label: 'Validator Consensus', description: 'Validators verifying your deposit' },
    { key: 'minting', label: 'Minting SOL on DCC', description: 'Creating bridged SOL on DecentralChain' },
    { key: 'completed', label: 'Complete', description: 'SOL.DCC delivered to your wallet' },
  ],
  dcc_to_sol: [
    { key: 'pending_confirmation', label: 'Confirming Burn', description: 'Waiting for DCC confirmations' },
    { key: 'awaiting_consensus', label: 'Validator Consensus', description: 'Validators verifying the burn' },
    { key: 'minting', label: 'Unlocking SOL', description: 'Releasing SOL from vault' },
    { key: 'completed', label: 'Complete', description: 'SOL delivered to your wallet' },
  ],
};

export function TransferProgress() {
  const { activeTransfer, clearActiveTransfer } = useBridgeStore();
  const [pollCount, setPollCount] = useState(0);

  // Poll for status updates (pauses when tab is hidden)
  useEffect(() => {
    if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'failed') {
      return;
    }

    const fetchStatus = async () => {
      try {
        const data = await bridgeApi.getTransfer(activeTransfer.transferId);
        if (data?.status && data.status !== activeTransfer.status) {
          useBridgeStore.getState().updateTransferStatus(data.status);
        }
      } catch {
        // Non-critical — next tick will retry
      }
      setPollCount((c) => c + 1);
    };

    let interval: ReturnType<typeof setInterval>;
    const startPolling = () => {
      interval = setInterval(fetchStatus, 5000);
    };
    fetchStatus(); // immediate first fetch
    startPolling();

    const onVisibility = () => {
      clearInterval(interval);
      if (!document.hidden) {
        fetchStatus();
        startPolling();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeTransfer]);

  if (!activeTransfer) return null;

  const token = activeTransfer.splMint
    ? getTokenByMint(activeTransfer.splMint) ?? DEFAULT_TOKEN
    : DEFAULT_TOKEN;

  const steps = STEPS[activeTransfer.direction];
  const currentStepIdx = steps.findIndex(
    (s) => s.key === activeTransfer.status
  );

  return (
    <div className="card space-y-6">
      <div className="text-center">
        <div className="flex justify-center mb-2">
          <TokenLogo token={token} size={40} />
        </div>
        <h2 className="text-xl font-bold mb-1">
          {activeTransfer.direction === 'sol_to_dcc'
            ? `Bridging ${token.symbol} → ${token.wrappedSymbol}.DCC`
            : `Redeeming ${token.wrappedSymbol}.DCC → ${token.symbol}`}
        </h2>
        <p className="text-gray-400 text-sm">
          {activeTransfer.amount}{' '}
          {activeTransfer.direction === 'sol_to_dcc' ? token.symbol : `${token.wrappedSymbol}.DCC`}
        </p>
      </div>

      {/* Progress Steps */}
      <div className="space-y-4">
        {steps.map((step, idx) => {
          const isActive = idx === currentStepIdx;
          const isComplete = idx < currentStepIdx;
          const isPending = idx > currentStepIdx;

          return (
            <div key={step.key} className="flex items-start gap-4">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    isComplete
                      ? 'bg-green-600'
                      : isActive
                      ? 'bg-purple-600 animate-pulse'
                      : 'bg-gray-700'
                  }`}
                >
                  {isComplete ? '✓' : idx + 1}
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={`w-0.5 h-8 ${
                      isComplete ? 'bg-green-600' : 'bg-gray-700'
                    }`}
                  />
                )}
              </div>
              <div className="pt-1">
                <p
                  className={`font-medium ${
                    isActive ? 'text-white' : isPending ? 'text-gray-500' : 'text-green-400'
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-xs text-gray-500">{step.description}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Transfer Details */}
      <div className="bg-gray-800/50 rounded-xl p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-400">Transfer ID</span>
          <span className="font-mono text-xs">{activeTransfer.transferId}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">From</span>
          <span className="font-mono text-xs truncate max-w-[200px]">
            {activeTransfer.sender}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">To</span>
          <span className="font-mono text-xs truncate max-w-[200px]">
            {activeTransfer.recipient}
          </span>
        </div>
      </div>

      {/* Actions */}
      {(activeTransfer.status === 'completed' ||
        activeTransfer.status === 'failed') && (
        <button
          onClick={clearActiveTransfer}
          className="btn-primary w-full"
        >
          {activeTransfer.status === 'completed'
            ? 'Start New Transfer'
            : 'Try Again'}
        </button>
      )}
    </div>
  );
}
