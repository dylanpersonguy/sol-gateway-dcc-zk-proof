import React, { useMemo, useCallback } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletError } from '@solana/wallet-adapter-base';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { BridgeInterface } from './components/BridgeInterface';
import { Header } from './components/Header';
import { StatusBar } from './components/StatusBar';
import { DocsPage } from './components/DocsPage';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';

import '@solana/wallet-adapter-react-ui/styles.css';
import { PhantomProvider } from './context/PhantomContext';

const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC_URL || 'http://127.0.0.1:8899';

// Nuke ALL wallet-related localStorage keys so the adapter never auto-reconnects
if (typeof window !== 'undefined') {
  localStorage.removeItem('walletName');
  localStorage.removeItem('walletName_bridge');
  // Also remove any Wallet Standard keys
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('wallet') || k.startsWith('solana')) {
      localStorage.removeItem(k);
    }
  });
}

function App() {
  const wallets = useMemo(() => [], []);

  const onError = useCallback((error: WalletError) => {
    console.error('[wallet]', error);
    toast.error(error.message || 'Wallet connection failed');
  }, []);

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={wallets} localStorageKey="walletName_bridge" onError={onError}>
        <PhantomProvider>
          <BrowserRouter>
            <Routes>
              {/* Docs page — standalone layout */}
              <Route path="/docs" element={<DocsPage />} />

              {/* Main bridge app */}
              <Route
                path="*"
                element={
                  <div className="min-h-screen bg-gray-950 relative overflow-hidden">
                    {/* Ambient background glow */}
                    <div className="pointer-events-none fixed inset-0 z-0">
                      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-purple-900/10 blur-[120px]" />
                      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-900/10 blur-[100px]" />
                    </div>
                    <Header />
                    <main className="relative z-10 max-w-xl mx-auto px-4 py-8 pb-16">
                      <BridgeInterface />
                    </main>
                    <StatusBar />
                    <Toaster
                      position="bottom-right"
                      toastOptions={{
                        style: {
                          background: '#1f2937',
                          color: '#fff',
                          border: '1px solid #374151',
                        },
                      }}
                    />
                  </div>
                }
              />
            </Routes>
          </BrowserRouter>
        </PhantomProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
