import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
    <footer className="fixed bottom-0 left-0 right-0 border-t border-gray-800/60 bg-gray-950/90 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-5 text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            TVL: <span className="text-gray-400 font-medium">{stats?.vaultBalance || '—'} SOL</span>
          </span>
          <span>wSOL Supply: <span className="text-gray-400 font-medium">{stats?.wsolSupply || '—'}</span></span>
          <span>Transfers: <span className="text-gray-400 font-medium">{stats?.totalTransfers || '—'}</span></span>
        </div>
        <div className="flex items-center gap-5 text-gray-500">
          <span>Validators: <span className="text-gray-400 font-medium">{stats?.activeValidators || '—'}/5</span></span>
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] px-1.5 py-0.5 rounded gradient-zk text-white font-semibold">ZK</span>
            <span className="text-gray-400">Groth16 · BN128</span>
          </span>
          <span>Ratio: <span className="text-green-400 font-medium">{stats?.collateralizationRatio || '1:1'}</span></span>
          <Link to="/docs" className="text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            Docs
          </Link>
        </div>
      </div>
    </footer>
  );
}
