import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';

function getPhantomProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.phantom?.solana ?? w.solana ?? null;
}

export function useWalletConnection() {
  const { publicKey, connected, disconnect, select, wallets, connect, wallet } = useWallet();
  const { setPhantomPubkey } = usePhantom();
  const [busy, setBusy] = useState(false);
  const [directPubkey, setDirectPubkey] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState(false);

  // Sync directPubkey with wallet adapter context
  useEffect(() => {
    if (connected && publicKey) {
      setDirectPubkey(publicKey.toBase58());
      setPhantomPubkey(publicKey.toBase58());
    }
  }, [connected, publicKey]);

  // After select(), call connect() once the adapter is ready
  useEffect(() => {
    if (pendingConnect && wallet && !connected) {
      connect().catch((err) => {
        console.error('[wallet] adapter connect error:', err);
      }).finally(() => setPendingConnect(false));
    }
  }, [pendingConnect, wallet, connected, connect]);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      const provider = getPhantomProvider();
      if (!provider) {
        window.open('https://phantom.app/', '_blank');
        setBusy(false);
        return;
      }
      const resp = await provider.connect();
      const addr = resp.publicKey.toString();
      setDirectPubkey(addr);
      setPhantomPubkey(addr);

      const phantomAdapter = wallets.find(
        w => w.adapter.name === 'Phantom' || w.adapter.name.toLowerCase().includes('phantom')
      );
      if (phantomAdapter) {
        select(phantomAdapter.adapter.name as any);
        setPendingConnect(true);
      }
    } catch (err: any) {
      console.error('[wallet] connect error:', err?.message ?? err);
      alert('[wallet] connect error: ' + (err?.message ?? String(err)));
    } finally {
      setBusy(false);
    }
  }, [wallets, select]);

  const handleDisconnect = useCallback(async () => {
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

  const displayAddr = publicKey?.toBase58() ?? directPubkey;
  const isConnected = connected || !!directPubkey;

  return {
    busy,
    isConnected,
    displayAddr,
    handleConnect,
    handleDisconnect,
  };
}
