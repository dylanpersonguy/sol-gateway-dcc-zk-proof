import React, { useState, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';
import { useBridgeStore } from '../hooks/useBridgeStore';
import { bridgeApi } from '../services/api';
import {
  DUSD,
  DUSD_REDEEM_FEE_RATE,
  DUSD_REDEEM_FEE_DISPLAY,
  DUSD_MINT_MINIMUM,
  DUSD_SOURCE_TOKENS,
} from '../config/dusd';
import { type MintableToken } from '../config/cr-stable';
import toast from 'react-hot-toast';

export function RedeemDUSD() {
  const { publicKey: adapterPubkey } = useWallet();
  const { getPublicKey } = usePhantom();
  const publicKey = getPublicKey(adapterPubkey);
  const { setActiveTransfer } = useBridgeStore();

  const redeemTokens = DUSD_SOURCE_TOKENS.filter((t) => !t.requiresSwap);
  const [selectedOutput, setSelectedOutput] = useState<MintableToken>(redeemTokens[0]);
  const [amount, setAmount] = useState('');
  const [dccSender, setDccSender] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const amountNum = parseFloat(amount);
  const validAmount = !isNaN(amountNum) && amountNum > 0;

  const feeAmount = useMemo(() => {
    if (!validAmount) return 0;
    return amountNum * DUSD_REDEEM_FEE_RATE;
  }, [amountNum, validAmount]);

  const receiveAmount = useMemo(() => {
    if (!validAmount) return 0;
    return amountNum - feeAmount;
  }, [amountNum, validAmount, feeAmount]);

  const handleRedeem = async () => {
    if (!publicKey) {
      toast.error('Connect your Solana wallet to receive ' + selectedOutput.symbol);
      return;
    }
    if (!validAmount || amountNum < DUSD_MINT_MINIMUM) {
      toast.error(`Minimum redeem amount is $${DUSD_MINT_MINIMUM}`);
      return;
    }
    if (!dccSender || dccSender.length < 20) {
      toast.error('Enter your DCC sender address');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await bridgeApi.createRedeem({
        sender: dccSender,
        solRecipient: publicKey.toBase58(),
        amount: amountNum,
        splMint: selectedOutput.splMint,
      });

      if (!response.success) {
        throw new Error('Failed to create redeem instruction');
      }

      toast.success(`${DUSD.symbol} burn instruction generated — sign in DCC wallet`);

      setActiveTransfer({
        transferId: 'pending',
        status: 'pending_confirmation',
        direction: 'dcc_to_sol',
        amount: amountNum.toString(),
        sender: dccSender,
        recipient: publicKey.toBase58(),
        splMint: selectedOutput.splMint,
        tokenSymbol: `${DUSD.symbol} → ${selectedOutput.symbol}`,
      });
    } catch (err: any) {
      toast.error(err?.message || 'Redeem failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="card bg-gradient-to-br from-amber-950/40 to-gray-900/40 border-amber-500/20">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-amber-500/30">
            ↩
          </div>
          <div>
            <h1 className="text-xl font-bold">Redeem {DUSD.symbol}</h1>
            <p className="text-xs text-gray-400">Burn {DUSD.symbol} to unlock USDC/USDT on Solana</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Burn your {DUSD.symbol} on DecentralChain and receive the equivalent USDC or USDT
          on Solana, unlocked from the bridge vault.
        </p>
      </div>

      {/* Redeem Form */}
      <div className="card space-y-5">
        {/* DCC Sender */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Your DCC Address (sender)
          </label>
          <input
            type="text"
            value={dccSender}
            onChange={(e) => setDccSender(e.target.value)}
            placeholder="3P..."
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3
                       focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
          />
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {DUSD.symbol} Amount to Burn
          </label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min="1"
              step="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-lg
                         focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium">
              {DUSD.symbol}
            </span>
          </div>
        </div>

        {/* Output Token Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-3">Receive As</label>
          <div className="flex gap-2">
            {redeemTokens.map((token) => (
              <button
                key={token.splMint}
                onClick={() => setSelectedOutput(token)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all ${
                  selectedOutput.splMint === token.splMint
                    ? 'border-amber-500 bg-amber-600/20 text-white shadow-md shadow-amber-500/10'
                    : 'border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
                }`}
              >
                <img
                  src={token.logoURI}
                  alt={token.symbol}
                  className="w-6 h-6 rounded-full"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                <span className="font-medium text-sm">{token.symbol}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Solana Recipient */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {selectedOutput.symbol} Recipient (your connected wallet)
          </label>
          <div className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-gray-400 text-sm font-mono">
            {publicKey?.toBase58() || 'Connect wallet...'}
          </div>
        </div>

        {/* Quote */}
        <div className="bg-gray-800/50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">You burn</span>
            <span>{amount || '0'} {DUSD.symbol}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Redeem fee ({DUSD_REDEEM_FEE_DISPLAY})</span>
            {feeAmount > 0 ? (
              <span className="text-yellow-400">−${feeAmount.toFixed(4)}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </div>
          <div className="border-t border-gray-700 pt-2 mt-2" />
          <div className="flex justify-between text-sm font-medium">
            <span className="text-gray-300">You receive</span>
            <span className="text-amber-400 text-lg">
              {receiveAmount > 0
                ? `${receiveAmount.toFixed(2)} ${selectedOutput.symbol}`
                : `0 ${selectedOutput.symbol}`}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Network</span>
            <span className="text-xs">Solana</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Estimated time</span>
            <span className="text-xs">3–5 minutes</span>
          </div>
        </div>

        {/* Redeem Button */}
        {publicKey ? (
          <button
            onClick={handleRedeem}
            disabled={isSubmitting || !validAmount || !dccSender}
            className="w-full py-3.5 rounded-xl font-semibold text-lg transition-all
                       bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-500/20
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-amber-600"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating burn instruction...
              </span>
            ) : (
              `Redeem ${DUSD.symbol}`
            )}
          </button>
        ) : (
          <div className="text-center text-gray-500 text-sm py-3">
            Connect your Solana wallet above to redeem {DUSD.symbol}
          </div>
        )}
      </div>
    </div>
  );
}
