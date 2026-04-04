import React, { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useWalletConnection } from '../hooks/useWalletConnection';

function ConnectedMenu({ displayAddr, onCopy, onDisconnect }: {
  displayAddr: string;
  onCopy: () => void;
  onDisconnect: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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
            onClick={() => { onCopy(); setShowMenu(false); }}
            className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
          >
            Copy Address
          </button>
          <button
            onClick={() => { onDisconnect(); setShowMenu(false); }}
            className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-gray-700 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function WalletButton() {
  const { busy, isConnected, displayAddr, handleConnect, handleDisconnect } = useWalletConnection();

  if (isConnected && displayAddr) {
    return (
      <ConnectedMenu
        displayAddr={displayAddr}
        onCopy={() => navigator.clipboard.writeText(displayAddr)}
        onDisconnect={handleDisconnect}
      />
    );
  }

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
            <img
              src="https://avatars.githubusercontent.com/u/75630395?s=200&v=4"
              alt="DecentralChain"
              className="w-10 h-10 rounded-xl shadow-lg shadow-purple-500/20"
            />
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
            to="/mint-crs"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-800/50 border border-emerald-700/50 hover:bg-emerald-700/50 hover:border-emerald-600/50 transition-colors text-xs text-emerald-300 hover:text-emerald-100 font-medium"
          >
            <span className="text-sm">$</span>
            Mint CRS
          </Link>
          <Link
            to="/mint-dusd"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-800/50 border border-blue-700/50 hover:bg-blue-700/50 hover:border-blue-600/50 transition-colors text-xs text-blue-300 hover:text-blue-100 font-medium"
          >
            <span className="text-sm">$</span>
            Mint DUSD
          </Link>
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
