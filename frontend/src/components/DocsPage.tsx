import React, { useState } from 'react';
import { Link } from 'react-router-dom';

/* ═══════════════════════════════════════════════════════════════
   SOL ⇄ DCC Bridge — Public Documentation Page
   ═══════════════════════════════════════════════════════════════ */

type SectionId =
  | 'overview'
  | 'architecture'
  | 'how-it-works'
  | 'dual-path'
  | 'zk-proofs'
  | 'fees'
  | 'security'
  | 'threat-model'
  | 'status'
  | 'contracts'
  | 'api'
  | 'faq';

const NAV: { id: SectionId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '◎' },
  { id: 'architecture', label: 'Architecture', icon: '⬡' },
  { id: 'how-it-works', label: 'How It Works', icon: '⇄' },
  { id: 'dual-path', label: 'Dual-Path Routing', icon: '⚡' },
  { id: 'zk-proofs', label: 'ZK Proofs', icon: 'π' },
  { id: 'fees', label: 'Bridge Fees', icon: '💰' },
  { id: 'security', label: 'Security', icon: '🛡️' },
  { id: 'threat-model', label: 'Threat Model', icon: '⚠️' },
  { id: 'status', label: 'Status & Caps', icon: '📊' },
  { id: 'contracts', label: 'Contracts', icon: '📜' },
  { id: 'api', label: 'API Reference', icon: '{ }' },
  { id: 'faq', label: 'FAQ', icon: '?' },
];

/* ── Reusable bits ── */

function Badge({ children, color = 'purple' }: { children: React.ReactNode; color?: string }) {
  const cls =
    color === 'green'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/30'
      : color === 'cyan'
      ? 'bg-cyan-900/40 text-cyan-300 border-cyan-700/30'
      : color === 'amber'
      ? 'bg-amber-900/40 text-amber-300 border-amber-700/30'
      : 'bg-purple-900/40 text-purple-300 border-purple-700/30';
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {children}
    </span>
  );
}

function SectionHeading({ id, icon, title }: { id: string; icon: string; title: string }) {
  return (
    <h2 id={id} className="flex items-center gap-3 text-xl font-bold text-white pt-10 pb-4 scroll-mt-24">
      <span className="w-8 h-8 rounded-lg gradient-zk flex items-center justify-center text-sm text-white">
        {icon}
      </span>
      {title}
    </h2>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-gray-900/80 border border-gray-800/60 rounded-2xl p-6 shadow-xl backdrop-blur-sm ${className}`}>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/40">
      <div className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-white mt-1">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-gray-950 border border-gray-800 rounded-xl p-4 overflow-x-auto text-xs text-gray-300 font-mono leading-relaxed">
      {children}
    </pre>
  );
}

/* ── Main Component ── */

export function DocsPage() {
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const scrollTo = (id: SectionId) => {
    setActiveSection(id);
    setMobileNavOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-gray-950 relative">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-purple-900/10 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-900/10 blur-[100px]" />
      </div>

      {/* Top Navbar */}
      <header className="border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl gradient-zk flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-purple-500/20">
                ⇄
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 border-2 border-gray-950 flex items-center justify-center">
                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white">SOL ⇄ DCC Bridge</h1>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full gradient-zk text-white font-semibold tracking-wide">
                  DOCS
                </span>
              </div>
              <p className="text-xs text-gray-500">Technical Documentation</p>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-gray-400">Mainnet</span>
            </div>
            <Link
              to="/"
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl h-10 flex items-center gap-2 text-sm font-medium transition-colors"
            >
              Launch App
            </Link>
            {/* Mobile nav toggle */}
            <button
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="lg:hidden bg-gray-800 hover:bg-gray-700 text-gray-300 p-2 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 flex gap-8 relative z-10">
        {/* Sidebar — desktop */}
        <aside className="hidden lg:block w-56 flex-shrink-0 sticky top-20 self-start py-6">
          <nav className="space-y-0.5">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => scrollTo(n.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-2.5 ${
                  activeSection === n.id
                    ? 'bg-purple-600/20 text-purple-300 font-medium border border-purple-500/20'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                <span className="w-5 text-center text-xs opacity-70">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Mobile sidebar overlay */}
        {mobileNavOpen && (
          <div className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)}>
            <aside className="absolute left-0 top-16 bottom-0 w-64 bg-gray-950 border-r border-gray-800 p-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <nav className="space-y-0.5">
                {NAV.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => scrollTo(n.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center gap-2.5 ${
                      activeSection === n.id
                        ? 'bg-purple-600/20 text-purple-300 font-medium'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                    }`}
                  >
                    <span className="w-5 text-center text-xs opacity-70">{n.icon}</span>
                    {n.label}
                  </button>
                ))}
              </nav>
            </aside>
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 min-w-0 py-6 pb-24">
          {/* Hero */}
          <div className="mb-10">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Badge>Groth16</Badge>
              <Badge color="cyan">BN128 Curve</Badge>
              <Badge color="green">Mainnet Live</Badge>
              <Badge color="amber">Phase 11</Badge>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white leading-tight mb-3">
              SOL ⇄ DCC Bridge
              <span className="gradient-text-zk ml-2">Documentation</span>
            </h1>
            <p className="text-gray-400 text-base leading-relaxed max-w-2xl">
              A trustless cross-chain bridge between <strong className="text-white">Solana</strong> and{' '}
              <strong className="text-white">DecentralChain</strong>, secured by zero-knowledge proofs.
              Lock SOL on Solana, receive wSOL.DCC on DecentralChain — cryptographically verified, non-custodial, and fully collateralized.
            </p>
            <div className="mt-4 bg-amber-900/20 border border-amber-700/30 rounded-xl px-4 py-3">
              <p className="text-xs text-amber-300/90 leading-relaxed">
                <strong>⚠️ Note:</strong> All security assessments referenced in this documentation are internal team-generated reports and testing evidence.
                They are <strong>not</strong> a third-party audit. An independent external audit is a prerequisite before full production deployment.
                The bridge is currently in <strong>limited beta</strong> with conservative TVL caps.
              </p>
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
            <StatCard label="Proof System" value="Groth16" sub="BN128 elliptic curve" />
            <StatCard label="Constraints" value="3.5M" sub="R1CS circuit" />
            <StatCard label="Validators" value="3-of-3" sub="Committee consensus" />
            <StatCard label="Collateral" value="1 : 1" sub="Fully backed" />
          </div>

          {/* ═══════ §1 OVERVIEW ═══════ */}
          <SectionHeading id="overview" icon="◎" title="Overview" />
          <Card>
            <p className="text-sm text-gray-300 leading-relaxed mb-4">
              The SOL ⇄ DCC Bridge enables seamless, trustless transfers of SOL (and SPL tokens) from Solana to DecentralChain and back.
              Every deposit is locked in a PDA-controlled vault on Solana, verified by an independent validator committee, and —
              for large transfers — secured by a full Groth16 zero-knowledge proof verified on-chain using DecentralChain's native{' '}
              <code className="text-purple-300 bg-purple-900/30 px-1.5 py-0.5 rounded text-xs">bn256Groth16Verify</code> precompile.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/40">
                <div className="text-purple-400 text-lg font-bold mb-1">🔒 Non-Custodial</div>
                <p className="text-xs text-gray-400">Your SOL is locked in a Solana PDA vault — no intermediary ever touches your funds.</p>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/40">
                <div className="text-purple-400 text-lg font-bold mb-1">π ZK-Verified</div>
                <p className="text-xs text-gray-400">Groth16 proofs over the BN128 curve mathematically guarantee every transfer.</p>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/40">
                <div className="text-purple-400 text-lg font-bold mb-1">⚡ Dual-Path</div>
                <p className="text-xs text-gray-400">Small transfers settle in ~45s via committee; large transfers go through full ZK verification.</p>
              </div>
            </div>
          </Card>

          {/* ═══════ §2 ARCHITECTURE ═══════ */}
          <SectionHeading id="architecture" icon="⬡" title="Architecture" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              The bridge uses a <strong className="text-white">two-contract architecture</strong> on DecentralChain,
              with three independent validator nodes and a ZK proof pipeline.
            </p>

            {/* Architecture diagram */}
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 font-mono text-xs text-gray-400 overflow-x-auto">
              <div className="min-w-[500px]">
                <div className="text-center text-purple-400 font-bold mb-3">═══ Two-Contract Architecture ═══</div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="border border-gray-700 rounded-lg p-3">
                    <div className="text-cyan-400 font-bold text-center mb-2">Contract A: Bridge Core</div>
                    <div className="text-[11px] space-y-1 text-gray-500">
                      <div>• Committee-signed mints</div>
                      <div>• Validator registration</div>
                      <div>• Burn processing</div>
                      <div>• Rate limits & pause</div>
                      <div>• M-of-N attestation</div>
                    </div>
                  </div>
                  <div className="border border-purple-700/50 rounded-lg p-3">
                    <div className="text-purple-400 font-bold text-center mb-2">Contract B: ZK Verifier</div>
                    <div className="text-[11px] space-y-1 text-gray-500">
                      <div>• Checkpoint proposals</div>
                      <div>• Groth16 verification</div>
                      <div>• verifyAndMint execution</div>
                      <div>• Verification key storage</div>
                      <div>• Processed message tracking</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Node layout */}
            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Infrastructure</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { name: 'Validator 1 (Leader)', mem: '12 GB', cpu: '4 cores', zk: true },
                  { name: 'Validator 2', mem: '8 GB', cpu: '2 cores', zk: false },
                  { name: 'Validator 3', mem: '8 GB', cpu: '2 cores', zk: false },
                ].map((v) => (
                  <div key={v.name} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/40">
                    <div className="text-xs font-semibold text-gray-200 flex items-center gap-2">
                      {v.name}
                      {v.zk && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full gradient-zk text-white font-semibold">ZK</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      {v.mem} RAM · {v.cpu}
                      {v.zk && ' · Proof generation enabled'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* ═══════ §3 HOW IT WORKS ═══════ */}
          <SectionHeading id="how-it-works" icon="⇄" title="How It Works" />
          <Card className="space-y-6">
            <h4 className="text-sm font-semibold text-gray-200">SOL → DCC (Deposit)</h4>
            <div className="space-y-3">
              {[
                { step: 1, icon: '◎', title: 'Lock SOL', desc: 'User deposits SOL into the PDA-controlled vault on Solana. The instruction records a deposit with a unique transfer ID, nonce, and the DCC recipient address. The amount is locked and cannot be withdrawn by anyone except via the bridge unlock mechanism.' },
                { step: 2, icon: '⬡', title: 'Validator Detection', desc: 'All three validators independently monitor the Solana blockchain via RPC. When a deposit reaches 32+ block finality (irreversible), each validator processes the event and applies rate-limit checks before routing.' },
                { step: 3, icon: '⚡', title: 'Path Routing', desc: 'Based on the deposit amount, validators route to either the Committee Fast-Path (< 100 SOL) or the ZK Proof Path (≥ 100 SOL). All validators must agree on the path — enforced by a shared threshold configuration.' },
                { step: 4, icon: 'π', title: 'Verification', desc: 'Committee path: 3 validators sign an attestation, reach consensus in ~30 seconds. ZK path: a Groth16 proof is generated (~98s avg), then verified on-chain via bn256Groth16Verify_8inputs on DecentralChain.' },
                { step: 5, icon: '⊕', title: 'Mint wSOL.DCC', desc: 'Upon successful verification, the designated DCC contract mints exactly the deposited amount of wSOL.DCC tokens to the recipient\'s DCC wallet. The transfer is recorded as processed — replay is impossible.' },
              ].map((s) => (
                <div key={s.step} className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full gradient-zk flex items-center justify-center text-white text-sm font-bold">
                    {s.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h5 className="text-sm font-semibold text-gray-200">
                      Step {s.step}: {s.title}
                    </h5>
                    <p className="text-xs text-gray-400 leading-relaxed mt-1">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-gray-800 pt-6">
              <h4 className="text-sm font-semibold text-gray-200 mb-3">DCC → SOL (Redeem)</h4>
              <p className="text-sm text-gray-400 leading-relaxed">
                The reverse flow works similarly: burn wSOL.DCC on DecentralChain → validators observe the burn →
                multi-signature attestation → SOL released from the PDA vault on Solana. Large withdrawals are subject to a
                daily outflow cap and a timelock delay for security.
              </p>
            </div>
          </Card>

          {/* ═══════ §4 DUAL-PATH ═══════ */}
          <SectionHeading id="dual-path" icon="⚡" title="Dual-Path Routing" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Committee Card */}
            <Card className="border-emerald-500/10 bg-emerald-950/10 space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold text-sm">⚡</div>
                <div>
                  <h4 className="text-sm font-bold text-emerald-300">Committee Fast-Path</h4>
                  <p className="text-[11px] text-gray-500">Transfers under 100 SOL</p>
                </div>
              </div>
              <div className="space-y-2 text-xs text-gray-400">
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Threshold</span>
                  <span className="text-emerald-300 font-medium">{'< 100 SOL'}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Consensus</span>
                  <span className="text-emerald-300 font-medium">3-of-3 validators</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Settlement Time</span>
                  <span className="text-emerald-300 font-medium">~45 seconds</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Verification</span>
                  <span className="text-emerald-300 font-medium">M-of-N Attestation</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span>Contract</span>
                  <span className="text-emerald-300 font-medium">Contract A (Bridge Core)</span>
                </div>
              </div>
              <div className="bg-emerald-900/20 rounded-lg p-3 border border-emerald-700/20">
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  Each validator independently observes the deposit on Solana, signs an attestation using Curve25519 keys, and broadcasts it via P2P transport.
                  Once all 3 signatures are collected (within a 30s timeout), the consensus engine triggers minting on DCC automatically.
                </p>
              </div>
            </Card>

            {/* ZK Card */}
            <Card className="border-purple-500/10 bg-purple-950/10 space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg gradient-zk flex items-center justify-center text-white font-bold text-sm">π</div>
                <div>
                  <h4 className="text-sm font-bold text-purple-300">ZK Proof Path</h4>
                  <p className="text-[11px] text-gray-500">Transfers ≥ 100 SOL</p>
                </div>
              </div>
              <div className="space-y-2 text-xs text-gray-400">
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Threshold</span>
                  <span className="text-purple-300 font-medium">≥ 100 SOL</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Proof System</span>
                  <span className="text-purple-300 font-medium">Groth16 / BN128</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Settlement Time</span>
                  <span className="text-purple-300 font-medium">~3–5 minutes</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-gray-800/50">
                  <span>Verification</span>
                  <span className="text-purple-300 font-medium">bn256Groth16Verify</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span>Contract</span>
                  <span className="text-purple-300 font-medium">Contract B (ZK Verifier)</span>
                </div>
              </div>
              <div className="bg-purple-900/20 rounded-lg p-3 border border-purple-700/20">
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  Deposits are batched into checkpoint windows (60s). Validators build a Merkle tree from canonical message IDs,
                  propose the root on-chain, then the leader generates a full Groth16 proof (~98s avg) and submits it for
                  on-chain verification before minting.
                </p>
              </div>
            </Card>
          </div>

          {/* ═══════ §5 ZK PROOFS ═══════ */}
          <SectionHeading id="zk-proofs" icon="π" title="Zero-Knowledge Proofs" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              The bridge uses <strong className="text-purple-300">Groth16</strong> — a succinct non-interactive argument of knowledge (zkSNARK) —
              over the <strong className="text-cyan-300">BN128 elliptic curve</strong>. Each proof mathematically guarantees that a deposit
              occurred on Solana without revealing any private witness data.
            </p>

            {/* Circuit Architecture */}
            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Circuit Architecture</h4>
              <CodeBlock>{`181-byte deposit preimage
    → Keccak256(1448 bits) → message_id (256 bits)
    → leaf = Keccak256(0x00 || message_id)     // RFC 6962 domain separation
    → MerkleTreeInclusion(depth=20) → checkpoint_root`}</CodeBlock>
            </div>

            {/* Public Inputs */}
            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Public Inputs (8 Field Elements)</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-4">#</th>
                      <th className="text-left py-2 pr-4">Input</th>
                      <th className="text-left py-2 pr-4">Bits</th>
                      <th className="text-left py-2">Purpose</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    {[
                      ['0', 'checkpoint_root_lo', '128', 'Merkle root lower half'],
                      ['1', 'checkpoint_root_hi', '128', 'Merkle root upper half'],
                      ['2', 'message_id_lo', '128', 'Message ID lower half'],
                      ['3', 'message_id_hi', '128', 'Message ID upper half'],
                      ['4', 'amount', '64', 'Transfer amount in lamports'],
                      ['5', 'recipient_lo', '128', 'DCC recipient lower half'],
                      ['6', 'recipient_hi', '128', 'DCC recipient upper half'],
                      ['7', 'version', '32', 'Protocol version (must = 1)'],
                    ].map(([n, name, bits, purpose]) => (
                      <tr key={n} className="border-b border-gray-800/50">
                        <td className="py-2 pr-4 font-mono text-purple-400">{n}</td>
                        <td className="py-2 pr-4 font-mono">{name}</td>
                        <td className="py-2 pr-4">{bits}</td>
                        <td className="py-2">{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Proof Pipeline */}
            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Proof Generation Pipeline</h4>
              <div className="space-y-2">
                {[
                  { icon: '🔢', name: 'Witness Generation', time: '~15s', desc: 'Evaluate all 3.5M constraint values from deposit inputs' },
                  { icon: '〰', name: 'Polynomial Encoding', time: '~35s', desc: 'Number Theoretic Transform across BN128 prime field' },
                  { icon: '⊗', name: 'Multi-Scalar Multiplication', time: '~90s', desc: '3.5M elliptic-curve point multiplications on G1 & G2' },
                  { icon: '📦', name: 'Proof Assembly', time: '~15s', desc: 'Combine curve points into final (π_A, π_B, π_C) tuple' },
                  { icon: '🔍', name: 'Local Verification', time: '~10s', desc: 'Pre-flight pairing check before broadcasting' },
                ].map((s) => (
                  <div key={s.name} className="flex items-center gap-3 bg-gray-800/30 rounded-lg px-3 py-2.5 border border-gray-700/30">
                    <span className="text-base flex-shrink-0">{s.icon}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-gray-200">{s.name}</span>
                      <p className="text-[11px] text-gray-500">{s.desc}</p>
                    </div>
                    <span className="text-[11px] font-mono text-purple-400 flex-shrink-0">{s.time}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Circuit" value="Circom 2.1" sub="bridge_deposit.circom" />
              <StatCard label="Avg Proof Time" value="~98s" sub="6 GB V8 heap" />
              <StatCard label="Constraints" value="3.5M" sub="R1CS" />
              <StatCard label="On-Chain Verify" value="<1s" sub="bn256Groth16Verify" />
            </div>
          </Card>

          {/* ═══════ §6 BRIDGE FEES ═══════ */}
          <SectionHeading id="fees" icon="💰" title="Bridge Fees" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              The bridge charges <strong className="text-white">asymmetric fees</strong> — lower on deposits (to attract TVL) and higher on withdrawals
              (to protect the vault). Fees vary by routing path.
            </p>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-green-400 uppercase tracking-wider">Deposit Fees (SOL → DCC)</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-800/60 rounded-xl p-4 border border-green-500/20">
                  <div className="text-green-400 text-xs font-medium mb-1">⚡ Committee Fast-Path</div>
                  <div className="text-2xl font-bold text-white">0.10%</div>
                  <div className="text-xs text-gray-500 mt-1">Deposits &lt; 100 SOL</div>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-4 border border-purple-500/20">
                  <div className="text-purple-400 text-xs font-medium mb-1">🔐 ZK Proof Path</div>
                  <div className="text-2xl font-bold text-white">0.15%</div>
                  <div className="text-xs text-gray-500 mt-1">Deposits ≥ 100 SOL</div>
                </div>
              </div>

              <h4 className="text-sm font-semibold text-teal-400 uppercase tracking-wider mt-4">Withdrawal Fees (DCC → SOL)</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-800/60 rounded-xl p-4 border border-green-500/20">
                  <div className="text-green-400 text-xs font-medium mb-1">⚡ Committee Fast-Path</div>
                  <div className="text-2xl font-bold text-white">0.25%</div>
                  <div className="text-xs text-gray-500 mt-1">Withdrawals &lt; 100 SOL</div>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-4 border border-purple-500/20">
                  <div className="text-purple-400 text-xs font-medium mb-1">🔐 ZK Proof Path</div>
                  <div className="text-2xl font-bold text-white">0.50%</div>
                  <div className="text-xs text-gray-500 mt-1">Withdrawals ≥ 100 SOL</div>
                </div>
              </div>
            </div>

            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-yellow-400 mb-2">Minimum Fee Floor</h4>
              <p className="text-sm text-gray-300">
                A minimum fee of <strong className="text-white">0.001 SOL</strong> is applied to all transfers,
                ensuring micro-transactions cover network costs. The fee shown in the interface is always the higher of the
                percentage-based fee or this floor.
              </p>
            </div>

            <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-blue-400 mb-2">Where Do Fees Go?</h4>
              <p className="text-sm text-gray-300">
                Fees accumulate as <strong className="text-white">surplus SOL</strong> inside the existing
                Vault PDA — a trustless, program-owned account. The validator mints or unlocks
                <code className="text-gray-400 mx-1">amount − fee</code> so the difference stays in the vault.
                No separate fee wallet exists; the vault balance always exceeds the total DCC supply,
                with the surplus representing protocol revenue.
              </p>
            </div>

            <div className="text-xs text-gray-500 italic">
              Fee calculation is available via the API at <code className="text-gray-400">GET /api/v1/fees/quote?amount=X&direction=deposit|withdrawal</code>.
              Committee and withdrawal paths enforce fees at the validator level. ZK-path deposits (≥ 100 SOL) are currently fee-exempt pending a RIDE contract update.
            </div>
          </Card>

          {/* ═══════ §7 SECURITY ═══════ */}
          <SectionHeading id="security" icon="🛡️" title="Security" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              The bridge has undergone <strong className="text-white">11 phases of internal security analysis</strong> including formal verification,
              catastrophic failure simulation, cryptographic attack testing, and live mainnet validation. An independent external audit is pending.
            </p>

            {/* Security layers */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { icon: 'π', title: 'ZK Proof Integrity', desc: 'Groth16 proofs verified on-chain with 8 cross-validated public inputs. Strategy A defense-in-depth recomputes message_id independently.' },
                { icon: '🔁', title: 'Replay Protection', desc: 'Solana: UnlockRecord PDA per transfer_id. DCC: immutable processed:: / zk_processed_ markers. @Verifier blocks DataTransaction deletion.' },
                { icon: '⏸️', title: 'Emergency Pause', desc: 'Both chains: all operations gated by pause flag. Two-step resume with timelock on Solana (5-min minimum). Guardian can cancel malicious resumes.' },
                { icon: '📊', title: 'Rate Limiting', desc: 'Solana: daily outflow cap, per-tx max, large withdrawal delay. DCC: hourly + daily caps, anomaly auto-pause. API: express-rate-limit.' },
                { icon: '🔐', title: 'Admin Separation', desc: 'Guardian can pause only. Authority requires timelock to resume. @Verifier blocks direct state manipulation on DCC.' },
                { icon: '🧪', title: 'Formal Verification', desc: '40,000 property-based fuzz operations across 4 runs — zero invariant violations. 58 catastrophic failure simulation tests all pass.' },
              ].map((s) => (
                <div key={s.title} className="bg-gray-800/40 rounded-xl p-4 border border-gray-700/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">{s.icon}</span>
                    <h5 className="text-xs font-semibold text-gray-200">{s.title}</h5>
                  </div>
                  <p className="text-[11px] text-gray-500 leading-relaxed">{s.desc}</p>
                </div>
              ))}
            </div>

            {/* Attack resistance table */}
            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Cryptographic Attack Resistance</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-4">Attack Vector</th>
                      <th className="text-left py-2 pr-4">Result</th>
                      <th className="text-left py-2">Defense</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    {[
                      ['Forge Groth16 proof', '❌ Failed', 'Discrete log intractability on BN128'],
                      ['Substitute public inputs', '❌ Failed', 'RIDE recomputes + cross-validates all fields'],
                      ['Replay old proof', '❌ Failed', 'Processed markers + UnlockRecord PDA'],
                      ['Merkle second-preimage', '❌ Failed', '0x00 leaf prefix (RFC 6962)'],
                      ['Hash collision', '❌ Failed', 'Keccak-256 collision resistance (2¹²⁸)'],
                      ['Amount manipulation', '❌ Failed', 'Amount in preimage AND circuit public input'],
                      ['Recipient substitution', '❌ Failed', 'Bound via message_id + circuit public inputs'],
                      ['Path routing manipulation', '❌ Failed', 'Server-side threshold; client flag advisory only'],
                    ].map(([attack, result, defense]) => (
                      <tr key={attack} className="border-b border-gray-800/50">
                        <td className="py-2 pr-4 font-medium text-gray-300">{attack}</td>
                        <td className="py-2 pr-4 text-red-400 font-mono">{result}</td>
                        <td className="py-2">{defense}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Audit stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Audit Phases" value="11" sub="Internal assessment" />
              <StatCard label="Fuzz Ops" value="40,000" sub="Zero violations" />
              <StatCard label="Failure Tests" value="58/58" sub="All pass" />
              <StatCard label="Test Vectors" value="32" sub="Cross-language" />
            </div>
          </Card>

          {/* ═══════ §7 THREAT MODEL ═══════ */}
          <SectionHeading id="threat-model" icon="⚠️" title="Threat Model & Assumptions" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              Security depends on explicit assumptions. Understanding what is trusted vs. trustless is critical for users and auditors.
            </p>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Trust Assumptions</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-4">Assumption</th>
                      <th className="text-left py-2 pr-4">If Violated</th>
                      <th className="text-left py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    {[
                      ['Honest majority of validators (2/3)', 'Committee mints could be forged; ZK path unaffected', '✅ 3/3 required'],
                      ['BN128 discrete log hardness', 'Groth16 proofs could be forged — would break Ethereum too', '✅ Industry standard'],
                      ['Keccak-256 collision resistance', 'Message IDs forgeable — would break all modern crypto', '✅ Industry standard'],
                      ['≥1 honest ceremony contributor', 'Proofs could be forged if tau is known', '⚠️ MPC ceremony pending'],
                      ['Authority key not compromised', 'Config changes possible after timelock', '⚠️ Multisig pending'],
                      ['Solana 32-block finality', 'Reorgs below 32 blocks not processed', '✅ Standard assumption'],
                    ].map(([assumption, violation, status]) => (
                      <tr key={assumption} className="border-b border-gray-800/50">
                        <td className="py-2 pr-4 font-medium text-gray-300">{assumption}</td>
                        <td className="py-2 pr-4">{violation}</td>
                        <td className="py-2 whitespace-nowrap">{status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Trusted vs. Trustless Components</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { name: 'SOL Vault (PDA)', level: 'Trustless', desc: 'Controlled by program logic, no human key' },
                  { name: 'ZK Proof Path', level: 'Trustless*', desc: 'Math guarantees correctness (*pending MPC ceremony)' },
                  { name: 'Committee Path', level: 'Trust-minimized', desc: 'Requires 3/3 honest validators' },
                  { name: 'API Server', level: 'Untrusted', desc: 'Cannot move funds; status/instructions only' },
                  { name: 'Frontend', level: 'Untrusted', desc: 'All signing is client-side via wallet' },
                  { name: 'Authority Key', level: 'Trusted', desc: 'Controls pause/resume — SPOF until multisig' },
                ].map((c) => (
                  <div key={c.name} className="flex items-center gap-3 bg-gray-800/30 rounded-lg px-3 py-2.5 border border-gray-700/30">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                      c.level === 'Trustless' || c.level === 'Trustless*' ? 'bg-emerald-900/40 text-emerald-300' :
                      c.level === 'Trust-minimized' ? 'bg-cyan-900/40 text-cyan-300' :
                      c.level === 'Untrusted' ? 'bg-gray-700/40 text-gray-300' :
                      'bg-amber-900/40 text-amber-300'
                    }`}>
                      {c.level}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-gray-200">{c.name}</span>
                      <p className="text-[11px] text-gray-500">{c.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">What Happens If…</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-4">Scenario</th>
                      <th className="text-left py-2 pr-4">Impact</th>
                      <th className="text-left py-2">Recovery</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    {[
                      ['1 validator goes offline', 'Committee minting blocked (3/3 required); ZK path unaffected', 'Restart container; deposits complete on recovery'],
                      ['Leader validator offline', 'ZK proofs cannot be generated', 'Restart validator-1; recover-deposit.mjs for stuck ones'],
                      ['API server offline', 'Frontend status unavailable', 'Validators still mint independently; restart API'],
                      ['Checkpoint corruption', 'ZK proofs fail verification', 'Propose correct checkpoint; old one expires'],
                      ['Solana chain reorg', 'No impact — 32-block finality required', 'Automatic — deposit not processed until finalized'],
                      ['Bridge paused (emergency)', 'All operations blocked; funds safe', 'Two-step resume: request → timelock → execute'],
                    ].map(([scenario, impact, recovery]) => (
                      <tr key={scenario} className="border-b border-gray-800/50">
                        <td className="py-2 pr-4 font-medium text-gray-300">{scenario}</td>
                        <td className="py-2 pr-4">{impact}</td>
                        <td className="py-2">{recovery}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          {/* ═══════ §8 STATUS & CAPS ═══════ */}
          <SectionHeading id="status" icon="📊" title="Deployment Status & TVL Caps" />
          <Card className="space-y-6">
            <div className="bg-amber-900/20 border border-amber-700/30 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-amber-300 mb-2">Current Status: Limited Beta</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                The bridge is <strong className="text-white">production-ready for limited beta deployment</strong> with conservative TVL caps and active monitoring.
                Full-scale TVL deployment requires: (1) MPC trusted setup ceremony, (2) multisig authority deployment, and (3) external professional audit.
              </p>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Outstanding Prerequisites</h4>
              <div className="space-y-2">
                {[
                  { item: 'MPC Trusted Setup Ceremony', status: 'pending', desc: 'Dev ceremony (single-machine) completed. Production multi-party ceremony with 3+ independent contributors needed.' },
                  { item: 'Multisig Authority Deployment', status: 'pending', desc: 'Single-key authority is a SPOF. Migration to multisig (e.g., Squads) required.' },
                  { item: 'External Professional Audit', status: 'pending', desc: 'All current assessments are internal. Independent third-party review required.' },
                ].map((p) => (
                  <div key={p.item} className="flex items-start gap-3 bg-gray-800/30 rounded-lg px-3 py-2.5 border border-gray-700/30">
                    <span className="text-amber-400 text-base flex-shrink-0 mt-0.5">⏳</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-gray-200">{p.item}</span>
                      <p className="text-[11px] text-gray-500">{p.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">TVL Cap Escalation Path</h4>
              <div className="space-y-2">
                {[
                  { milestone: 'Current (Beta)', cap: '≤ 500 SOL', color: 'amber' },
                  { milestone: 'After MPC ceremony', cap: '≤ 5,000 SOL', color: 'cyan' },
                  { milestone: 'After multisig migration', cap: '≤ 25,000 SOL', color: 'purple' },
                  { milestone: 'After external audit (no critical/high)', cap: 'Rate-limit only', color: 'green' },
                ].map((m) => (
                  <div key={m.milestone} className="flex items-center justify-between bg-gray-800/30 rounded-lg px-3 py-2.5 border border-gray-700/30">
                    <span className="text-xs text-gray-300">{m.milestone}</span>
                    <span className={`text-xs font-mono font-medium ${
                      m.color === 'green' ? 'text-emerald-300' :
                      m.color === 'amber' ? 'text-amber-300' :
                      m.color === 'cyan' ? 'text-cyan-300' :
                      'text-purple-300'
                    }`}>{m.cap}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* ═══════ §9 CONTRACTS ═══════ */}
          <SectionHeading id="contracts" icon="📜" title="Smart Contracts" />
          <Card className="space-y-6">
            <h4 className="text-sm font-semibold text-gray-200 mb-1">Mainnet Addresses</h4>
            <div className="space-y-3">
              {[
                { label: 'Solana Program', addr: '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF', chain: 'Solana' },
                { label: 'Vault PDA', addr: 'A2CMs9oPjSW46NvQDKFDqBqxj9EMvoJbTKkJJP9WK96U', chain: 'Solana' },
                { label: 'Contract A (Bridge Core)', addr: '3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG', chain: 'DCC' },
                { label: 'Contract B (ZK Verifier)', addr: '3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6', chain: 'DCC' },
              ].map((c) => (
                <div key={c.label} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/40">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-200">{c.label}</span>
                    <Badge color={c.chain === 'Solana' ? 'purple' : 'cyan'}>{c.chain}</Badge>
                  </div>
                  <code className="text-[11px] text-gray-400 font-mono break-all">{c.addr}</code>
                </div>
              ))}
            </div>

            <div className="border-t border-gray-800 pt-4">
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Contract Components</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-4">Component</th>
                      <th className="text-left py-2 pr-4">Language</th>
                      <th className="text-left py-2 pr-4">LOC</th>
                      <th className="text-left py-2">Purpose</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-400">
                    {[
                      ['sol-bridge-lock', 'Rust / Anchor', '~2,200', 'Solana vault, deposits, unlocks, rate limits'],
                      ['checkpoint-registry', 'Rust / Anchor', '~400', 'On-chain checkpoint management'],
                      ['bridge_controller.ride', 'RIDE v6', '~1,023', 'DCC bridge core + ZK verification'],
                      ['bridge_deposit.circom', 'Circom 2.1', '~300', 'ZK circuit (3.5M constraints)'],
                      ['encoding-rust', 'Rust', '~500', 'Canonical message encoding'],
                      ['encoding-ts', 'TypeScript', '~400', 'Canonical message encoding (TS)'],
                    ].map(([name, lang, loc, purpose]) => (
                      <tr key={name} className="border-b border-gray-800/50">
                        <td className="py-2 pr-4 font-mono text-purple-400">{name}</td>
                        <td className="py-2 pr-4">{lang}</td>
                        <td className="py-2 pr-4">{loc}</td>
                        <td className="py-2">{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          {/* ═══════ §8 API ═══════ */}
          <SectionHeading id="api" icon="{ }" title="API Reference" />
          <Card className="space-y-6">
            <p className="text-sm text-gray-300 leading-relaxed">
              The bridge API is a stateless Express.js server that provides transfer tracking, fee estimation, and instruction generation.
              It <strong className="text-white">never holds funds</strong> — all signing happens client-side.
            </p>

            <div className="space-y-2">
              {[
                { method: 'GET', path: '/api/v1/transfer/:id', desc: 'Get transfer status (DB + on-chain fallback)' },
                { method: 'GET', path: '/api/v1/transfer/:id/stream', desc: 'SSE real-time status push' },
                { method: 'POST', path: '/api/v1/transfer/register', desc: 'Register a new transfer from the frontend' },
                { method: 'GET', path: '/api/v1/transfer/history/:address', desc: 'Transfer history for a wallet' },
                { method: 'GET', path: '/api/v1/health', desc: 'Bridge health status and validator count' },
                { method: 'GET', path: '/api/v1/stats', desc: 'TVL, transfer count, collateralization ratio' },
                { method: 'POST', path: '/api/v1/deposit/generate', desc: 'Generate deposit instruction (client signs)' },
                { method: 'POST', path: '/api/v1/redeem/generate', desc: 'Generate redeem instruction (client signs)' },
              ].map((ep) => (
                <div key={ep.path + ep.method} className="flex items-center gap-3 bg-gray-800/30 rounded-lg px-3 py-2.5 border border-gray-700/30">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                    ep.method === 'GET' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'
                  }`}>
                    {ep.method}
                  </span>
                  <code className="text-xs text-gray-300 font-mono flex-1 min-w-0 truncate">{ep.path}</code>
                  <span className="text-[11px] text-gray-500 flex-shrink-0 hidden sm:block">{ep.desc}</span>
                </div>
              ))}
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Transfer Status Flow</h4>
              <CodeBlock>{`pending_confirmation → awaiting_consensus → consensus_reached → minting → completed
                                                     ↘ zk_proving → zk_verifying ↗

Status resolution: Local DB → Contract A (processed::) → Contract B (zk_processed_)`}</CodeBlock>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-200 mb-3">Real-Time Updates (SSE)</h4>
              <CodeBlock>{`// Connect to SSE stream
const sse = new EventSource('/api/v1/transfer/{transferId}/stream');

sse.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.status);      // 'minting', 'completed', etc.
  console.log(data.destTxHash);   // DCC transaction hash
};`}</CodeBlock>
            </div>
          </Card>

          {/* ═══════ §9 FAQ ═══════ */}
          <SectionHeading id="faq" icon="?" title="Frequently Asked Questions" />
          <div className="space-y-3">
            {[
              {
                q: 'What is a zero-knowledge proof?',
                a: 'A zero-knowledge proof (ZKP) allows one party to prove they know a value without revealing the value itself. In our bridge, Groth16 proofs mathematically verify that a deposit occurred on Solana without revealing private witness data — only the public inputs (amount, recipient, checkpoint root) are visible.',
              },
              {
                q: 'Why are there two paths (committee vs ZK)?',
                a: 'For smaller transfers (under 100 SOL), the cost of generating a full Groth16 proof is disproportionate. The committee fast-path settles in ~45 seconds with 3-of-3 validator signatures. For larger transfers (≥ 100 SOL), the additional security of a ZK proof is warranted — it provides full trustlessness with no reliance on honest validator behavior.',
              },
              {
                q: 'Is the bridge non-custodial?',
                a: 'Yes. Your SOL is locked in a PDA (Program-Derived Address) controlled vault on Solana — no human or entity has the private key. The bridge can only release funds through the unlock mechanism, which requires either validator consensus or a verified ZK proof.',
              },
              {
                q: 'What happens if a transfer gets stuck?',
                a: 'The bridge has multiple recovery mechanisms: SSE push notifications for real-time updates, automatic retry logic in validators, and a standalone recovery tool (recover-deposit.mjs) that can regenerate ZK proofs and re-submit stuck transactions.',
              },
              {
                q: 'How long does a transfer take?',
                a: 'Committee fast-path (< 100 SOL): ~45 seconds total. ZK proof path (≥ 100 SOL): ~3-5 minutes. The majority of time in the ZK path is spent on Groth16 proof generation (~98 seconds average).',
              },
              {
                q: 'Is the bridge audited?',
                a: 'The bridge has undergone 11 phases of internal security analysis including formal verification (40,000 fuzz operations), catastrophic failure simulation (58 tests), cryptographic attack testing, and live mainnet validation. However, all reports are team-generated — an independent external professional audit is a prerequisite before full production deployment. The bridge currently operates in limited beta with conservative TVL caps.',
              },
              {
                q: 'What tokens are supported?',
                a: 'Natively, the bridge supports SOL. Additionally, SPL tokens (USDC, USDT, wBTC, wETH, and more) are supported through the same PDA vault mechanism, each receiving a corresponding wrapped representation on DecentralChain.',
              },
            ].map((faq) => (
              <FaqItem key={faq.q} q={faq.q} a={faq.a} />
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-16 text-center">
            <div className="card-glow inline-block px-10 py-8">
              <h3 className="text-xl font-bold text-white mb-2">Ready to Bridge?</h3>
              <p className="text-sm text-gray-400 mb-5">
                Transfer SOL to DecentralChain in seconds — secured by zero-knowledge proofs.
              </p>
              <Link
                to="/"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white transition-all duration-200 bg-gradient-to-r from-purple-600 to-cyan-500 hover:opacity-90 hover:scale-[1.02] shadow-lg shadow-purple-500/20"
              >
                Launch Bridge App
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
            </div>
          </div>
        </main>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-800/60 bg-gray-950/90 relative z-10">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-lg gradient-zk flex items-center justify-center text-xs font-bold text-white">⇄</div>
                <span className="font-bold text-white text-sm">SOL ⇄ DCC Bridge</span>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                Trustless cross-chain gateway secured by Groth16 zero-knowledge proofs on the BN128 elliptic curve.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Protocol</h4>
              <div className="space-y-2">
                <FooterLink label="Bridge App" to="/" />
                <FooterLink label="Documentation" to="/docs" />
                <FooterExternalLink label="GitHub" href="https://github.com/dylanpersonguy/sol-gateway-dcc-zk-proof" />
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Security</h4>
              <div className="space-y-2 text-xs text-gray-500">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  11 internal assessment phases completed
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  40,000 fuzz operations — zero violations
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  Live ZK-verified mints on mainnet
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  External audit pending
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-gray-800/60 mt-6 pt-4 flex items-center justify-between">
            <span className="text-[11px] text-gray-600">© 2026 SOL ⇄ DCC Bridge. All rights reserved.</span>
            <div className="flex items-center gap-2">
              <span className="text-[9px] px-1.5 py-0.5 rounded-full gradient-zk text-white font-semibold">ZK</span>
              <span className="text-[11px] text-gray-600">Groth16 · BN128 · Phase 11</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ── FAQ accordion item ── */

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="!p-0 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-800/30"
      >
        <span className="text-sm font-medium text-gray-200">{q}</span>
        <svg
          className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-4">
          <p className="text-xs text-gray-400 leading-relaxed">{a}</p>
        </div>
      )}
    </Card>
  );
}

/* ── Footer link helpers ── */

function FooterLink({ label, to }: { label: string; to: string }) {
  return (
    <Link to={to} className="block text-xs text-gray-500 hover:text-gray-300 transition-colors">{label}</Link>
  );
}

function FooterExternalLink({ label, href }: { label: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block text-xs text-gray-500 hover:text-gray-300 transition-colors">
      {label} ↗
    </a>
  );
}
