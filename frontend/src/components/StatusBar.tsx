import React, { useEffect, useState } from 'react';
import { bridgeApi } from '../services/api';

export function StatusBar() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await bridgeApi.getStats();
        setStats(data);
      } catch {
        // Silently ignore — non-critical
      }
    };

    fetchStats();
    let interval = setInterval(fetchStats, 30000);

    // Pause polling when tab is hidden to save bandwidth
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(interval);
      } else {
        fetchStats();
        interval = setInterval(fetchStats, 30000);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <footer className="fixed bottom-0 left-0 right-0 border-t border-gray-800 bg-gray-950/90 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 py-2 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-6">
          <span>TVL: {stats?.vaultBalance || '—'} SOL</span>
          <span>SOL Supply: {stats?.wsolSupply || '—'}</span>
          <span>Transfers: {stats?.totalTransfers || '—'}</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Validators: {stats?.activeValidators || '—'}/5</span>
          <span>Ratio: {stats?.collateralizationRatio || '1:1'}</span>
        </div>
      </div>
    </footer>
  );
}
