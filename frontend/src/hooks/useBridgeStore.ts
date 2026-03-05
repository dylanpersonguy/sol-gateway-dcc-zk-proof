import { create } from 'zustand';
import { type BridgeToken, DEFAULT_TOKEN } from '../config/tokens';

export type BridgeDirection = 'sol_to_dcc' | 'dcc_to_sol';

export interface ActiveTransfer {
  transferId: string;
  status: string;
  direction: BridgeDirection;
  amount: string;
  sender: string;
  recipient: string;
  /** SPL mint of the token being transferred */
  splMint?: string;
  /** Display symbol (e.g. "SOL", "USDC") */
  tokenSymbol?: string;
  /** Whether this transfer uses ZK proof path (>=100 SOL) */
  useZk?: boolean;
}

interface BridgeState {
  direction: BridgeDirection;
  selectedToken: BridgeToken;
  activeTransfer: ActiveTransfer | null;
  setDirection: (dir: BridgeDirection) => void;
  setSelectedToken: (token: BridgeToken) => void;
  setActiveTransfer: (transfer: ActiveTransfer) => void;
  updateTransferStatus: (status: string) => void;
  clearActiveTransfer: () => void;
}

export const useBridgeStore = create<BridgeState>((set) => ({
  direction: 'sol_to_dcc',
  selectedToken: DEFAULT_TOKEN,
  activeTransfer: null,

  setDirection: (direction) => set({ direction }),

  setSelectedToken: (selectedToken) => set({ selectedToken }),

  setActiveTransfer: (transfer) => set({ activeTransfer: transfer }),

  updateTransferStatus: (status) =>
    set((state) => ({
      activeTransfer: state.activeTransfer
        ? { ...state.activeTransfer, status }
        : null,
    })),

  clearActiveTransfer: () => set({ activeTransfer: null }),
}));
