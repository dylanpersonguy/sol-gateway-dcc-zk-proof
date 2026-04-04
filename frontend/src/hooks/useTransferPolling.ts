import { useEffect, useState } from 'react';
import { useBridgeStore } from './useBridgeStore';
import { bridgeApi } from '../services/api';

const STATUS_MAP: Record<string, string> = {
  pending_confirmation: 'pending_confirmation',
  awaiting_consensus: 'awaiting_consensus',
  proving: 'zk_proving',
  verifying: 'zk_verifying',
  minting: 'minting',
  completed: 'completed',
  failed: 'failed',
};

function mapStatus(status: string): string {
  return STATUS_MAP[status] || status;
}

export function useTransferPolling() {
  const { activeTransfer, updateTransferStatus, clearActiveTransfer } = useBridgeStore();
  const [elapsed, setElapsed] = useState(0);

  // Timer
  useEffect(() => {
    if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'failed') return;
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [activeTransfer?.status]);

  // SSE + polling
  useEffect(() => {
    if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'failed') return;

    const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

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

    const fetchStatus = async () => {
      try {
        const data = await bridgeApi.getTransfer(activeTransfer.transferId);
        const s = data?.transfer?.status ?? data?.status;
        if (s && s !== activeTransfer.status) {
          updateTransferStatus(mapStatus(s));
        }
      } catch {}
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

  return {
    activeTransfer,
    elapsed,
    mappedStatus: activeTransfer ? mapStatus(activeTransfer.status) : '',
    clearActiveTransfer,
  };
}
