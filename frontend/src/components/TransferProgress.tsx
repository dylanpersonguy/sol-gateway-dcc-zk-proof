import React, { useEffect, useState, useRef } from 'react';
import { useBridgeStore } from '../hooks/useBridgeStore';
import { bridgeApi } from '../services/api';
import { getTokenByMint, DEFAULT_TOKEN } from '../config/tokens';
import { TokenLogo } from './TokenSelector';

/* ── ZK Proof Sub-Steps Panel ── */

const ZK_SUB_STEPS = [
  {
    icon: '🔢',
    label: 'Witness Generation',
    desc: 'Evaluating all 3.5M constraint values from your deposit inputs',
    duration: 15,
  },
  {
    icon: '〰',
    label: 'Polynomial Encoding',
    desc: 'Number Theoretic Transform across the BN128 prime field',
    duration: 35,
  },
  {
    icon: '⊗',
    label: 'Multi-Scalar Multiplication',
    desc: 'Computing 3.5M elliptic-curve point multiplications on G1 & G2',
    duration: 90,
  },
  {
    icon: '📦',
    label: 'Proof Assembly',
    desc: 'Combining curve points into the final (π_A, π_B, π_C) tuple',
    duration: 15,
  },
  {
    icon: '🔍',
    label: 'Local Verification',
    desc: 'Pre-flight pairing check before broadcasting to DecentralChain',
    duration: 10,
  },
];

function ZkProofPanel({ isDone }: { isDone: boolean }) {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isDone) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [isDone]);

  // Determine which sub-step is active based on cumulative durations
  let cursor = 0;
  const activeIdx = isDone
    ? ZK_SUB_STEPS.length
    : ZK_SUB_STEPS.findIndex((s) => { cursor += s.duration; return elapsed < cursor; });
  const clampedActive = activeIdx === -1 ? ZK_SUB_STEPS.length - 1 : activeIdx;

  return (
    <div className="space-y-2.5">
      {/* sub-step list */}
      {ZK_SUB_STEPS.map((s, i) => {
        const done = i < clampedActive || isDone;
        const active = !isDone && i === clampedActive;
        return (
          <div key={s.label} className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-all ${
            active ? 'bg-purple-900/30 border border-purple-600/30' :
            done  ? 'opacity-60' : 'opacity-30'
          }`}>
            <span className={`text-base mt-0.5 ${ active ? 'animate-pulse' : '' }`}>{s.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-semibold ${
                  done ? 'text-green-400' : active ? 'text-white' : 'text-gray-500'
                }`}>{s.label}</span>
                {done && (
                  <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {active && (
                  <span className="flex gap-0.5">
                    {[0,1,2].map(d => (
                      <span key={d} className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />
                    ))}
                  </span>
                )}
              </div>
              <p className={`text-[10px] leading-snug mt-0.5 ${
                active ? 'text-gray-400' : 'text-gray-600'
              }`}>{s.desc}</p>
            </div>
            <span className={`text-[10px] font-mono flex-shrink-0 mt-0.5 ${
              done ? 'text-green-700' : active ? 'text-purple-400' : 'text-gray-700'
            }`}>~{s.duration}s</span>
          </div>
        );
      })}

      {/* progress bar */}
      <div className="mt-1 h-1 bg-gray-700/50 rounded-full overflow-hidden">
        <div
          className="h-full gradient-zk rounded-full transition-all duration-1000"
          style={{ width: `${isDone ? 100 : Math.min(99, (elapsed / 165) * 100)}%` }}
        />
      </div>

      {/* tags */}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {[
          ['Groth16', 'purple'],
          ['BN128 Curve', 'cyan'],
          ['8 Public Inputs', 'indigo'],
          ['3.5M Constraints', 'violet'],
        ].map(([label, color]) => (
          <span key={label} className={`text-[10px] px-2 py-0.5 rounded bg-${color}-900/40 text-${color}-300 border border-${color}-700/30`}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── ZK-Aware Transfer Steps ── */

const ZK_THRESHOLD_SOL = 100;

const STEPS_SOL_TO_DCC_ZK = [
  {
    key: 'pending_confirmation',
    label: 'Solana Confirmation',
    description: 'Waiting for 32+ block finality on Solana',
    icon: '◎',
    avgTime: '~15s',
    detail: 'Your SOL is locked in a PDA-controlled vault. The bridge awaits irreversible finality before proceeding.',
  },
  {
    key: 'awaiting_consensus',
    label: 'Validator Checkpoint',
    description: 'M-of-N validators creating Merkle checkpoint',
    icon: '⬡',
    avgTime: '~60s',
    detail: 'Validators independently observe the deposit and propose a signed Merkle root checkpoint on DecentralChain.',
  },
  {
    key: 'zk_proving',
    label: 'ZK Proof Generation',
    description: 'Generating Groth16 proof over BN128 curve',
    icon: 'π',
    avgTime: '2–5 min',
    detail: 'A zero-knowledge proof is generated using snarkjs with 3.5M constraints, proving the deposit is valid without revealing private inputs.',
    isZk: true,
  },
  {
    key: 'zk_verifying',
    label: 'On-Chain ZK Verification',
    description: 'bn256Groth16Verify on DecentralChain',
    icon: '✓',
    avgTime: '~10s',
    detail: 'The Groth16 proof is verified on-chain using the bn256Groth16Verify_8inputs precompile. Only valid proofs can trigger minting.',
    isZk: true,
  },
  {
    key: 'minting',
    label: 'Minting wSOL.DCC',
    description: 'Issuing wrapped tokens on DecentralChain',
    icon: '⊕',
    avgTime: '~5s',
    detail: 'The bridge smart contract mints exactly the deposited amount (1:1 ratio) to your DCC wallet address.',
  },
  {
    key: 'completed',
    label: 'Complete',
    description: 'Bridge transfer verified and delivered',
    icon: '✦',
    avgTime: '',
    detail: 'Your tokens have been cryptographically verified and delivered. The entire process is trustless — no human intervention required.',
  },
];

const STEPS_SOL_TO_DCC_COMMITTEE = [
  {
    key: 'pending_confirmation',
    label: 'Solana Confirmation',
    description: 'Waiting for 32+ block finality on Solana',
    icon: '◎',
    avgTime: '~15s',
    detail: 'Your SOL is locked in a PDA-controlled vault. The bridge awaits irreversible finality before proceeding.',
  },
  {
    key: 'awaiting_consensus',
    label: 'Validator Consensus',
    description: 'M-of-N validators signing attestation',
    icon: '⬡',
    avgTime: '~30s',
    detail: 'Three independent validators observe your deposit on Solana and sign a multi-party attestation to authorize minting.',
  },
  {
    key: 'minting',
    label: 'Minting wSOL.DCC',
    description: 'Issuing wrapped tokens on DecentralChain',
    icon: '⊕',
    avgTime: '~5s',
    detail: 'The bridge smart contract mints exactly the deposited amount (1:1 ratio) to your DCC wallet address.',
  },
  {
    key: 'completed',
    label: 'Complete',
    description: 'Bridge transfer verified and delivered',
    icon: '✦',
    avgTime: '',
    detail: 'Your tokens have been verified by the validator committee and delivered. Fast-path for transfers under 100 SOL.',
  },
];

const STEPS_DCC_TO_SOL_ZK = [
  {
    key: 'pending_confirmation',
    label: 'DCC Burn Confirmation',
    description: 'Confirming burn transaction on DecentralChain',
    icon: '🔥',
    avgTime: '~15s',
    detail: 'Your wrapped tokens are being burned on DecentralChain. The bridge waits for confirmation before releasing SOL.',
  },
  {
    key: 'awaiting_consensus',
    label: 'Validator Attestation',
    description: 'Validators verifying the burn event',
    icon: '⬡',
    avgTime: '~60s',
    detail: 'Validators independently verify the burn transaction and create a signed attestation.',
  },
  {
    key: 'zk_proving',
    label: 'ZK Proof Generation',
    description: 'Generating unlock proof with Groth16',
    icon: 'π',
    avgTime: '2–5 min',
    detail: 'A zero-knowledge proof is generated to cryptographically verify the burn is legitimate.',
    isZk: true,
  },
  {
    key: 'minting',
    label: 'Unlocking SOL',
    description: 'Releasing SOL from the PDA vault',
    icon: '🔓',
    avgTime: '~10s',
    detail: 'The verified proof triggers a SOL release from the PDA-controlled vault on Solana.',
  },
  {
    key: 'completed',
    label: 'Complete',
    description: 'SOL delivered to your wallet',
    icon: '✦',
    avgTime: '',
    detail: 'Your SOL has been unlocked and transferred to your Solana wallet.',
  },
];

const STEPS_DCC_TO_SOL_COMMITTEE = [
  {
    key: 'pending_confirmation',
    label: 'DCC Burn Confirmation',
    description: 'Confirming burn transaction on DecentralChain',
    icon: '🔥',
    avgTime: '~15s',
    detail: 'Your wrapped tokens are being burned on DecentralChain. The bridge waits for confirmation before releasing SOL.',
  },
  {
    key: 'awaiting_consensus',
    label: 'Validator Consensus',
    description: 'M-of-N validators signing unlock attestation',
    icon: '⬡',
    avgTime: '~30s',
    detail: 'Three independent validators verify the burn and sign a multi-party attestation to authorize the SOL release.',
  },
  {
    key: 'minting',
    label: 'Unlocking SOL',
    description: 'Releasing SOL from the PDA vault',
    icon: '🔓',
    avgTime: '~10s',
    detail: 'The committee attestation triggers a SOL release from the PDA-controlled vault on Solana.',
  },
  {
    key: 'completed',
    label: 'Complete',
    description: 'SOL delivered to your wallet',
    icon: '✦',
    avgTime: '',
    detail: 'Your SOL has been unlocked and transferred to your Solana wallet.',
  },
];

/* ── Map any server status to our expanded step keys ── */
function mapStatus(status: string): string {
  const mapping: Record<string, string> = {
    pending_confirmation: 'pending_confirmation',
    awaiting_consensus: 'awaiting_consensus',
    proving: 'zk_proving',
    verifying: 'zk_verifying',
    minting: 'minting',
    completed: 'completed',
    failed: 'failed',
  };
  return mapping[status] || status;
}

export function TransferProgress() {
  const { activeTransfer, updateTransferStatus, clearActiveTransfer } = useBridgeStore();
  const [elapsed, setElapsed] = useState(0);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  // Timer
  useEffect(() => {
    if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'failed') return;
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [activeTransfer?.status]);

  // Poll for status updates + SSE real-time push
  useEffect(() => {
    if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'failed') return;

    const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

    // SSE for instant push updates from validator
    let sse: EventSource | null = null;
    try {
      sse = new EventSource(`${API_BASE}/transfer/${activeTransfer.transferId}/stream`);
      sse.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const s = msg.status;
          if (s && s !== activeTransfer.status) {
            updateTransferStatus(mapStatus(s));
          }
        } catch {}
      };
      sse.onerror = () => { sse?.close(); sse = null; };
    } catch {}

    // Polling fallback (every 5s)
    const fetchStatus = async () => {
      try {
        const data = await bridgeApi.getTransfer(activeTransfer.transferId);
        const s = data?.transfer?.status ?? data?.status;
        if (s && s !== activeTransfer.status) {
          updateTransferStatus(mapStatus(s));
        }
      } catch { /* retry next tick */ }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    const onVis = () => { if (!document.hidden) fetchStatus(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
      sse?.close();
    };
  }, [activeTransfer?.transferId]);

  if (!activeTransfer) return null;

  const token = activeTransfer.splMint
    ? getTokenByMint(activeTransfer.splMint) ?? DEFAULT_TOKEN
    : DEFAULT_TOKEN;

  const useZk = activeTransfer.useZk ?? parseFloat(activeTransfer.amount) >= ZK_THRESHOLD_SOL;

  const steps = activeTransfer.direction === 'sol_to_dcc'
    ? (useZk ? STEPS_SOL_TO_DCC_ZK : STEPS_SOL_TO_DCC_COMMITTEE)
    : (useZk ? STEPS_DCC_TO_SOL_ZK : STEPS_DCC_TO_SOL_COMMITTEE);
  const mappedStatus = mapStatus(activeTransfer.status);
  const currentStepIdx = Math.max(0, steps.findIndex((s) => s.key === mappedStatus));
  const isComplete = mappedStatus === 'completed';
  const isFailed = mappedStatus === 'failed';

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-4">
      {/* ── Main Progress Card ── */}
      <div className={`card-glow space-y-6 ${isComplete ? '!border-green-500/30' : ''}`}>
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="relative inline-flex items-center justify-center">
            {!isComplete && !isFailed && (
              <div className="absolute inset-0 rounded-full animate-ping opacity-20 bg-purple-500" style={{ animationDuration: '2s' }} />
            )}
            <div className={`relative z-10 w-16 h-16 rounded-full flex items-center justify-center ${
              isComplete ? 'bg-green-500/20 ring-2 ring-green-500/50' :
              isFailed ? 'bg-red-500/20 ring-2 ring-red-500/50' :
              'bg-purple-500/20 ring-2 ring-purple-500/50 animate-pulse-glow'
            }`}>
              {isComplete ? (
                <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : isFailed ? (
                <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <TokenLogo token={token} size={32} />
              )}
            </div>
          </div>

          <div>
            <h2 className="text-xl font-bold">
              {isComplete ? (
                <span className="text-green-400">Transfer Complete!</span>
              ) : isFailed ? (
                <span className="text-red-400">Transfer Failed</span>
              ) : (
                <>
                  Bridging {activeTransfer.amount}{' '}
                  <span className="gradient-text-solana">
                    {activeTransfer.direction === 'sol_to_dcc' ? token.symbol : `${token.wrappedSymbol}.DCC`}
                  </span>
                </>
              )}
            </h2>
            <p className="text-gray-400 text-sm mt-1">
              {isComplete
                ? (useZk ? 'Cryptographically verified via ZK proof' : 'Verified by validator committee')
                : `${activeTransfer.direction === 'sol_to_dcc' ? 'Solana → DecentralChain' : 'DecentralChain → Solana'} · ${formatTime(elapsed)}`}
            </p>
            {!isComplete && !isFailed && (
              <span className={`inline-block mt-2 text-[10px] px-2.5 py-1 rounded-full font-medium ${
                useZk
                  ? 'bg-purple-900/40 text-purple-300 border border-purple-700/30'
                  : 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/30'
              }`}>
                {useZk ? '🔐 ZK Proof Path • ≥100 SOL' : '⚡ Committee Fast-Path • <100 SOL'}
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="relative h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-out ${
              isComplete ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'gradient-zk'
            }`}
            style={{ width: `${isComplete ? 100 : Math.max(5, (currentStepIdx / (steps.length - 1)) * 100)}%` }}
          />
          {!isComplete && !isFailed && (
            <div className="absolute inset-0 animate-shimmer rounded-full" />
          )}
        </div>

        {/* Steps */}
        <div className="space-y-1">
          {steps.map((step, idx) => {
            const isActive = idx === currentStepIdx && !isComplete && !isFailed;
            const isDone = idx < currentStepIdx || isComplete;
            const isZk = 'isZk' in step && step.isZk;
            const isExpanded = expandedStep === idx;

            return (
              <div key={step.key}>
                <button
                  onClick={() => setExpandedStep(isExpanded ? null : idx)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                    isActive ? 'bg-purple-500/10 border border-purple-500/20' :
                    isDone ? 'bg-green-500/5' :
                    'hover:bg-gray-800/50'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 transition-all ${
                    isDone ? 'bg-green-500/20 text-green-400' :
                    isActive ? (isZk ? 'gradient-zk text-white animate-pulse-glow' : 'bg-purple-600 text-white animate-pulse') :
                    'bg-gray-800 text-gray-500'
                  }`}>
                    {isDone ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <span className={isZk && isActive ? 'text-xs font-mono' : ''}>{step.icon}</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${
                        isDone ? 'text-green-400' : isActive ? 'text-white' : 'text-gray-500'
                      }`}>
                        {step.label}
                      </span>
                      {isZk && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full gradient-zk text-white font-medium">
                          ZK
                        </span>
                      )}
                      {isActive && (
                        <span className="flex items-center gap-1 text-[10px] text-purple-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                          In Progress
                        </span>
                      )}
                    </div>
                    <p className={`text-xs ${isDone ? 'text-green-600' : isActive ? 'text-gray-400' : 'text-gray-600'}`}>
                      {step.description}
                    </p>
                  </div>

                  {'avgTime' in step && step.avgTime && (
                    <span className={`text-[10px] font-mono flex-shrink-0 ${
                      isDone ? 'text-green-700' : isActive ? 'text-purple-400' : 'text-gray-600'
                    }`}>
                      {step.avgTime}
                    </span>
                  )}

                  <svg className={`w-4 h-4 text-gray-600 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {isExpanded && (
                  <div className="ml-11 mr-3 mt-1 mb-2 p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
                    {isZk ? (
                      <ZkProofPanel isDone={isDone} />
                    ) : (
                      <p className="text-xs text-gray-400 leading-relaxed">{step.detail}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Transfer Details ── */}
      <div className="card space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Transfer Details</h3>
        <div className="space-y-2 text-sm">
          <DetailRow label="Transfer ID" value={activeTransfer.transferId} mono truncate />
          <DetailRow label="From" value={activeTransfer.sender} mono truncate />
          <DetailRow label="To" value={activeTransfer.recipient} mono truncate />
          <DetailRow label="Amount" value={`${activeTransfer.amount} ${token.symbol}`} />
          <DetailRow label="Verification" value={useZk ? 'Groth16 ZK Proof' : 'M-of-N Committee Attestation'} highlight />
          <DetailRow label="Security" value={useZk ? 'Trustless — No intermediaries' : 'Multi-party — 2/3 validator threshold'} />
        </div>
      </div>

      {/* ── ZK Info Card (only for ZK path) ── */}
      {useZk && (
      <div className="card bg-purple-950/20 border-purple-500/10 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md gradient-zk flex items-center justify-center text-[10px] font-bold text-white">π</div>
          <h3 className="text-xs font-semibold text-purple-300 uppercase tracking-wider">Zero-Knowledge Proof</h3>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          Your transfer is secured by a <span className="text-purple-300 font-medium">Groth16 zero-knowledge proof</span> generated
          over the <span className="text-cyan-300 font-medium">BN128 elliptic curve</span>. The proof mathematically
          verifies your deposit without revealing any private data. It is verified on-chain using DecentralChain&apos;s
          native <span className="text-purple-300 font-mono text-[11px]">bn256Groth16Verify</span> precompile.
        </p>
        <div className="grid grid-cols-3 gap-2 pt-1">
          <ZkStat label="Curve" value="BN128" />
          <ZkStat label="Proof System" value="Groth16" />
          <ZkStat label="Constraints" value="3.5M" />
        </div>
      </div>
      )}

      {/* ── Committee Info Card (only for committee path) ── */}
      {!useZk && (
      <div className="card bg-emerald-950/20 border-emerald-500/10 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-emerald-600 flex items-center justify-center text-[10px] font-bold text-white">⚡</div>
          <h3 className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">Committee Fast-Path</h3>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          Transfers under <span className="text-emerald-300 font-medium">100 SOL</span> are verified by a
          <span className="text-emerald-300 font-medium"> 2-of-3 validator committee</span> for faster settlement.
          Each validator independently observes your deposit on Solana and signs an attestation.
          Once a quorum is reached, minting executes automatically — typically in under <span className="text-emerald-300 font-medium">60 seconds</span>.
        </p>
        <div className="grid grid-cols-3 gap-2 pt-1">
          <CommitteeStat label="Validators" value="3" />
          <CommitteeStat label="Threshold" value="2/3" />
          <CommitteeStat label="Avg. Time" value="~45s" />
        </div>
      </div>
      )}

      {/* ── Action ── */}
      {(isComplete || isFailed) && (
        <button
          onClick={clearActiveTransfer}
          className={`w-full py-3 rounded-xl font-semibold text-white transition-all ${
            isComplete ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
          }`}
        >
          {isComplete ? 'Start New Transfer' : 'Try Again'}
        </button>
      )}
    </div>
  );
}

/* ── Helpers ── */

function DetailRow({ label, value, mono, truncate, highlight }: {
  label: string; value: string; mono?: boolean; truncate?: boolean; highlight?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className={`text-xs ${highlight ? 'text-purple-400 font-medium' : mono ? 'font-mono text-gray-300' : 'text-gray-300'} ${truncate ? 'truncate max-w-[180px]' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function ZkStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-2 text-center">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-xs font-semibold text-purple-300 mt-0.5">{value}</div>
    </div>
  );
}

function CommitteeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-2 text-center">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-xs font-semibold text-emerald-300 mt-0.5">{value}</div>
    </div>
  );
}
