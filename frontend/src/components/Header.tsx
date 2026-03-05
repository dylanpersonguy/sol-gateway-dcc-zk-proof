import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Link } from 'react-router-dom';
import { usePhantom } from '../context/PhantomContext';

// Access the Phantom provider directly — bypasses wallet-adapter's broken connect flow
function getPhantomProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.phantom?.solana ?? w.solana ?? null;
}

function WalletButton() {
  const { publicKey, connected, disconnect, select, wallets } = useWallet();
  const { setPhantomPubkey } = usePhantom();
  const [showMenu, setShowMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [directPubkey, setDirectPubkey] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Sync directPubkey with wallet adapter context
  useEffect(() => {
    if (connected && publicKey) {
      setDirectPubkey(publicKey.toBase58());
    }
  }, [connected, publicKey]);

  const handleConnect = useCallback(async () => {
    console.log('[wallet] handleConnect fired');
    setShowMenu(false);
    setBusy(true);
    try {
      const w = window as any;
      console.log('[wallet] window.phantom =', w.phantom);
      console.log('[wallet] window.solana =', w.solana);
      const provider = w.phantom?.solana ?? w.solana ?? null;
      console.log('[wallet] provider =', provider);
      if (!provider) {
        console.warn('[wallet] No Phantom provider found — opening phantom.app');
        window.open('https://phantom.app/', '_blank');
        setBusy(false);
        return;
      }
      console.log('[wallet] Calling provider.connect()...');
      const resp = await provider.connect();
      console.log('[wallet] connect() resolved:', resp);
      const addr = resp.publicKey.toString();
      setDirectPubkey(addr);
      setPhantomPubkey(addr);
      console.log('[wallet] Connected! Address:', addr);
      // Sync WalletProvider so useWallet().publicKey works everywhere.
      // In wallet-adapter v0.15.39, select() triggers the provider to call connect()
      // internally — do NOT call connect() manually here or it throws WalletNotSelectedError.
      console.log('[wallet] available adapters:', wallets.map(w => w.adapter.name));
      const phantomAdapter = wallets.find(
        w => w.adapter.name === 'Phantom' || w.adapter.name.toLowerCase().includes('phantom')
      );
      if (phantomAdapter) {
        console.log('[wallet] selecting adapter:', phantomAdapter.adapter.name);
        select(phantomAdapter.adapter.name as any);
        // WalletProvider will call adapter.connect() internally via its own useEffect.
        // Phantom is already authorised so it resolves immediately without a popup.
      } else {
        console.warn('[wallet] Phantom adapter not found in wallets list — publicKey may be null in other components');
      }
    } catch (err: any) {
      console.error('[wallet] connect error:', err?.message ?? err);
      alert('[wallet] connect error: ' + (err?.message ?? String(err)));
    } finally {
      setBusy(false);
    }
  }, [wallets, select]);

  const handleDisconnect = useCallback(async () => {
    setShowMenu(false);
    try {
      const provider = getPhantomProvider();
      if (provider) await provider.disconnect();
      setDirectPubkey(null);
      setPhantomPubkey(null);
      await disconnect();
    } catch (err: any) {
      console.error('[wallet] disconnect error:', err);
    }
  }, [disconnect]);

  // Determine display address from either source
  const displayAddr = publicKey?.toBase58() ?? directPubkey;
  const isConnected = connected || !!directPubkey;

  // Connected state — show address + dropdown
  if (isConnected && displayAddr) {
    const short = displayAddr.slice(0, 4) + '...' + displayAddr.slice(-4);
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl h-10 flex items-center gap-2 text-sm font-medium transition-colors"
        >
          <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTIwIDRINEMyLjkgNCAyIDQuOSAyIDZ2MTJjMCAxLjEuOSAyIDIgMmgxNmMxLjEgMCAyLS45IDItMlY2YzAtMS4xLS45LTItMi0yem0wIDE0SDRWNmgxNnYxMnpNNCAxMGg0djRINHYtNHoiLz48L3N2Zz4=" alt="" className="w-5 h-5" />
          {short}
        </button>
        {showMenu && (
          <div className="absolute right-0 top-12 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 min-w-[160px] overflow-hidden">
            <button
              onClick={() => { navigator.clipboard.writeText(displayAddr); setShowMenu(false); }}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
            >
              Copy Address
            </button>
            <button
              onClick={handleDisconnect}
              className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-gray-700 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  // Busy state
  if (busy) {
    return (
      <button
        disabled
        className="bg-purple-600 text-white px-4 py-2 rounded-xl h-10 flex items-center gap-2 text-sm font-medium opacity-70 cursor-wait"
      >
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Connecting...
      </button>
    );
  }

  // Default — single Connect Wallet button
  return (
    <button
      onClick={handleConnect}
      className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl h-10 flex items-center gap-2 text-sm font-medium transition-colors"
    >
      Connect Wallet
    </button>
  );
}

export function Header() {
  return (
    <header className="border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-xl sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
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
              <h1 className="text-lg font-bold">SOL ⇄ DCC Bridge</h1>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full gradient-zk text-white font-semibold tracking-wide">
                ZK VERIFIED
              </span>
            </div>
            <p className="text-xs text-gray-500">Zero-Knowledge Cross-Chain Gateway</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/docs"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50 hover:bg-gray-700/50 hover:border-gray-600/50 transition-colors text-xs text-gray-400 hover:text-gray-200"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            Docs
          </Link>
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-gray-400">Mainnet</span>
          </div>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
