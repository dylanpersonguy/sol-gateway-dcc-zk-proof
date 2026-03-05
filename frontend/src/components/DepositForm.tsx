import React, { useState, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';
import { useBridgeStore } from '../hooks/useBridgeStore';
import { bridgeApi } from '../services/api';
import { TokenSelector, TokenLogo } from './TokenSelector';
import { calculateFee, formatFeeAmount, ZK_THRESHOLD_SOL } from '../config/fees';
import toast from 'react-hot-toast';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const DEPOSIT_DISC = new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]);

// Bridge constants
const BRIDGE_PROGRAM_ID = '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';
const VAULT_ADDRESS     = 'A2CMs9oPjSW46NvQDKFDqBqxj9EMvoJbTKkJJP9WK96U';
const BRIDGE_CONFIG     = 'Fn4CxJ47wbTy4cuGZBf1a1p9ncAfWrjgjpqcdVR3eY1M';

export function DepositForm() {
  const { publicKey: adapterPubkey, signTransaction: adapterSign } = useWallet();
  const { getPublicKey, getSignTransaction } = usePhantom();
  const publicKey = getPublicKey(adapterPubkey);
  const signTransaction = getSignTransaction(adapterSign ?? null);
  const { connection } = useConnection();
  const { setActiveTransfer, selectedToken, setSelectedToken } = useBridgeStore();

  const [amount, setAmount] = useState('');
  const [recipientDcc, setRecipientDcc] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualTxSig, setManualTxSig] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const walletConnected = !!publicKey && !!signTransaction;
  const isNativeSOL = selectedToken.splMint === 'So11111111111111111111111111111111111111112';

  // ── Fee Calculation ──
  const feeQuote = useMemo(() => {
    const amountNum = parseFloat(amount);
    return calculateFee(isNaN(amountNum) ? 0 : amountNum, 'deposit');
  }, [amount]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    toast.success(`${label} copied!`);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDeposit = async () => {
    if (!walletConnected) {
      toast.error('Connect your wallet or use Manual Deposit below');
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('Invalid amount');
      return;
    }

    if (!recipientDcc || recipientDcc.length < 20) {
      toast.error('Invalid DCC recipient address');
      return;
    }

    setIsSubmitting(true);

    try {
      // 1. Call API to get instruction metadata (PDAs, validation)
      const response = await bridgeApi.createDeposit({
        sender: publicKey!.toBase58(),
        recipientDcc,
        amount: amountNum,
        splMint: selectedToken.splMint,
      });

      if (!response.success) {
        throw new Error('Failed to create deposit instruction');
      }

      const { metadata } = response;
      const programId = new PublicKey(metadata.programId);
      const bridgeConfig = new PublicKey(metadata.bridgeConfig);
      const vault = new PublicKey(metadata.vault);
      const userState = new PublicKey(metadata.userState);
      const amountLamports = BigInt(metadata.amountLamports);

      // 2. Read user nonce from on-chain UserState
      let nonce = 0n;
      const usInfo = await connection.getAccountInfo(userState);
      if (usInfo && usInfo.data.length >= 48) {
        nonce = usInfo.data.readBigUInt64LE(40);
      }

      // 3. Compute transfer_id = SHA256(sender || nonce_le)
      const tidBuf = new Uint8Array(40);
      tidBuf.set(publicKey!.toBytes(), 0);
      const nonceBytes = new ArrayBuffer(8);
      new DataView(nonceBytes).setBigUint64(0, nonce, true);
      tidBuf.set(new Uint8Array(nonceBytes), 32);

      const hashBuffer = await crypto.subtle.digest('SHA-256', tidBuf);
      const transferId = new Uint8Array(hashBuffer);

      // 4. Derive deposit record PDA
      const [depositRecord] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('deposit'), transferId],
        programId,
      );

      // 5. Encode DCC recipient as 32 bytes
      let recipientBytes: Uint8Array;
      try {
        const decoded = bs58.decode(recipientDcc);
        recipientBytes = new Uint8Array(32);
        recipientBytes.set(decoded.slice(0, 32), 0);
      } catch {
        // Fallback: UTF-8 encode
        const enc = new TextEncoder().encode(recipientDcc);
        recipientBytes = new Uint8Array(32);
        recipientBytes.set(enc.slice(0, 32), 0);
      }

      // 6. Serialize instruction data: disc(8) + recipient(32) + amount(u64) + transfer_id(32)
      const ixData = new Uint8Array(8 + 32 + 8 + 32);
      ixData.set(DEPOSIT_DISC, 0);
      ixData.set(recipientBytes, 8);
      new DataView(ixData.buffer).setBigUint64(40, amountLamports, true);
      ixData.set(transferId, 48);

      // 7. Build the instruction (TransactionInstruction.data must be Buffer, not Uint8Array)
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: bridgeConfig,            isSigner: false, isWritable: true  },
          { pubkey: userState,               isSigner: false, isWritable: true  },
          { pubkey: depositRecord,           isSigner: false, isWritable: true  },
          { pubkey: vault,                   isSigner: false, isWritable: true  },
          { pubkey: publicKey!,              isSigner: true,  isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(ixData),
      });

      // 8. Build, sign, and send the transaction
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: publicKey!,
      });
      tx.add(ix);

      console.log('[deposit] Requesting Phantom signature...');
      toast.success('Sign the transaction in your wallet');
      const signedTx = await signTransaction!(tx);

      console.log('[deposit] Sending raw transaction...');
      const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      console.log('[deposit] Sent! Signature:', signature);
      toast.success(`Deposit sent! Tx: ${signature.slice(0, 16)}...`);

      // 9. Set active transfer for the progress tracker
      const transferIdHex = Array.from(transferId)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      setActiveTransfer({
        transferId: transferIdHex,
        status: 'pending_confirmation',
        direction: 'sol_to_dcc',
        amount: amountNum.toString(),
        sender: publicKey!.toBase58(),
        recipient: recipientDcc,
        splMint: selectedToken.splMint,
        tokenSymbol: selectedToken.symbol,
        useZk: amountNum >= 100,
      });

      // 10. Register transfer with API so status polling works
      bridgeApi.registerTransfer({
        transferId: transferIdHex,
        sender: publicKey!.toBase58(),
        recipient: recipientDcc,
        amount: amountNum.toString(),
        amountFormatted: `${amountNum} ${selectedToken.symbol}`,
        splMint: selectedToken.splMint,
        sourceTxHash: signature,
        direction: 'sol_to_dcc',
      }).catch(() => {}); // Non-critical

      // 11. Wait for confirmation in background
      connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      ).then((confirmation) => {
        if (confirmation.value.err) {
          toast.error('Deposit transaction failed on-chain');
        } else {
          toast.success('Deposit confirmed on Solana!');
        }
      });

    } catch (err: any) {
      console.error('Deposit error (full):', JSON.stringify(err, Object.getOwnPropertyNames(err)));
      console.error('Deposit error:', err);
      const msg = err?.message || String(err);
      if (msg.includes('User rejected')) {
        toast.error('Transaction rejected by user');
      } else if (msg.includes('Simulation failed')) {
        toast.error('Transaction simulation failed — check console for details');
      } else {
        toast.error(`Deposit failed: ${msg.slice(0, 120)}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Register a manually-sent deposit with the API
  const handleManualDeposit = async () => {
    if (!manualTxSig || manualTxSig.length < 40) {
      toast.error('Enter a valid Solana transaction signature');
      return;
    }

    if (!recipientDcc || recipientDcc.length < 20) {
      toast.error('Enter your DCC recipient address');
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('Enter the deposit amount');
      return;
    }

    setIsSubmitting(true);
    try {
      // Verify the transaction exists on-chain
      const txInfo = await connection.getTransaction(manualTxSig, {
        maxSupportedTransactionVersion: 0,
      });
      if (!txInfo) {
        toast.error('Transaction not found on Solana — is it confirmed?');
        return;
      }

      toast.success('Transaction found on Solana!');

      // Set the active transfer for progress tracking
      setActiveTransfer({
        transferId: manualTxSig.slice(0, 32),
        status: 'pending_confirmation',
        direction: 'sol_to_dcc',
        amount: amountNum.toString(),
        sender: 'manual',
        recipient: recipientDcc,
        splMint: selectedToken.splMint,
        tokenSymbol: selectedToken.symbol,
        useZk: amountNum >= 100,
      });

      toast.success('Deposit registered! Validators will detect it shortly.');
    } catch (err: any) {
      console.error('Manual deposit error:', err);
      toast.error(err?.message || 'Failed to register deposit');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Wallet Deposit Mode ── */}
      <div className="card space-y-6">
        <div>
          <h2 className="text-xl font-bold mb-1">Deposit {selectedToken.symbol}</h2>
          <p className="text-gray-400 text-sm">
            {walletConnected
              ? `Lock ${selectedToken.symbol} on Solana to receive ${selectedToken.wrappedSymbol}.DCC on DecentralChain`
              : 'Connect your Phantom wallet above, or use Manual Deposit below'}
          </p>
        </div>

        {/* Token + Amount Input */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Token &amp; Amount
          </label>
          <div className="flex gap-2">
            <TokenSelector
              selected={selectedToken}
              onChange={setSelectedToken}
            />
            <div className="relative flex-1">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                min="0.001"
                step="0.001"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-lg
                           focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
                {selectedToken.symbol}
              </span>
            </div>
          </div>
        </div>

        {/* Recipient Input */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            DCC Recipient Address
          </label>
          <input
            type="text"
            value={recipientDcc}
            onChange={(e) => setRecipientDcc(e.target.value)}
            placeholder="3P..."
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3
                       focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
          />
        </div>

        {/* Fee Estimate */}
        <div className="bg-gray-800/50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">You deposit</span>
            <span className="flex items-center gap-1.5">
              <TokenLogo token={selectedToken} size={16} />
              {amount || '0'} {selectedToken.symbol}
            </span>
          </div>

          {/* Bridge Fee */}
          <div className="flex justify-between text-sm">
            <span className="text-gray-400 flex items-center gap-1">
              Bridge fee
              <span className="text-[10px] text-gray-600">
                ({feeQuote.feeDisplay})
              </span>
            </span>
            {feeQuote.feeAmount > 0 ? (
              <span className="text-yellow-400">
                −{formatFeeAmount(feeQuote.feeAmount)} {selectedToken.symbol}
              </span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </div>

          {/* Fee destination note */}
          {feeQuote.feeAmount > 0 && (
            <div className="text-[10px] text-gray-600 text-right -mt-1">
              Retained in trustless vault PDA
            </div>
          )}

          {/* Path indicator */}
          {parseFloat(amount) > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Routing path</span>
              {feeQuote.path === 'zk' ? (
                <span className="text-purple-400 text-xs">
                  🔐 ZK Proof (≥{ZK_THRESHOLD_SOL} SOL)
                </span>
              ) : (
                <span className="text-green-400 text-xs">
                  ⚡ Committee (&lt;{ZK_THRESHOLD_SOL} SOL)
                </span>
              )}
            </div>
          )}

          <div className="border-t border-gray-700 pt-2 mt-2" />

          <div className="flex justify-between text-sm font-medium">
            <span className="text-gray-300">You receive</span>
            <span className="text-white flex items-center gap-1.5">
              {feeQuote.receiveAmount > 0
                ? `${formatFeeAmount(feeQuote.receiveAmount)} ${selectedToken.wrappedSymbol}.DCC`
                : `0 ${selectedToken.wrappedSymbol}.DCC`}
            </span>
          </div>

          {selectedToken.solDecimals !== selectedToken.dccDecimals && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Decimal conversion</span>
              <span className="text-yellow-400 text-xs">
                {selectedToken.solDecimals}→{selectedToken.dccDecimals} dec
              </span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Network fee</span>
            <span>~0.000005 SOL</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Estimated time</span>
            <span>{feeQuote.path === 'zk' ? '3–5 minutes' : '~45 seconds'}</span>
          </div>
        </div>

        {/* Wallet Deposit Button */}
        {walletConnected ? (
          <button
            onClick={handleDeposit}
            disabled={isSubmitting || !amount || !recipientDcc}
            className="btn-primary w-full text-lg"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing...
              </span>
            ) : (
              `Deposit ${selectedToken.symbol}`
            )}
          </button>
        ) : (
          <div className="text-center text-gray-500 text-sm py-2">
            Connect Phantom above to deposit directly, or use Manual Deposit below
          </div>
        )}
      </div>

      {/* ── Manual Deposit Mode ── */}
      <ManualDeposit
        selectedToken={selectedToken}
        amount={amount}
        recipientDcc={recipientDcc}
        manualTxSig={manualTxSig}
        setManualTxSig={setManualTxSig}
        isSubmitting={isSubmitting}
        handleManualDeposit={handleManualDeposit}
        copyToClipboard={copyToClipboard}
        copied={copied}
      />
    </div>
  );
}

/* ── Manual Deposit Panel ── */

function ManualDeposit({
  selectedToken,
  amount,
  recipientDcc,
  manualTxSig,
  setManualTxSig,
  isSubmitting,
  handleManualDeposit,
  copyToClipboard,
  copied,
}: {
  selectedToken: any;
  amount: string;
  recipientDcc: string;
  manualTxSig: string;
  setManualTxSig: (s: string) => void;
  isSubmitting: boolean;
  handleManualDeposit: () => void;
  copyToClipboard: (text: string, label: string) => void;
  copied: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h3 className="text-sm font-semibold text-gray-300">
            Manual Deposit
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Deposit from CLI, another wallet, or any Solana tool
          </p>
        </div>
        <span className={`text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Step 1: Vault Address */}
          <div className="bg-gray-800/50 rounded-xl p-4 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">
              Step 1: Send {selectedToken.symbol} to the Bridge Vault
            </h4>

            <div className="space-y-2">
              <div>
                <span className="text-xs text-gray-500 block mb-1">Vault Address</span>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-900 text-green-400 px-3 py-2 rounded-lg flex-1 break-all select-all">
                    {VAULT_ADDRESS}
                  </code>
                  <button
                    onClick={() => copyToClipboard(VAULT_ADDRESS, 'Vault')}
                    className={`text-xs px-3 py-2 rounded-lg transition-colors ${
                      copied === 'Vault' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {copied === 'Vault' ? '✓' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <span className="text-xs text-gray-500 block mb-1">Bridge Program</span>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-900 text-blue-400 px-3 py-2 rounded-lg flex-1 break-all select-all">
                    {BRIDGE_PROGRAM_ID}
                  </code>
                  <button
                    onClick={() => copyToClipboard(BRIDGE_PROGRAM_ID, 'Program')}
                    className={`text-xs px-3 py-2 rounded-lg transition-colors ${
                      copied === 'Program' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {copied === 'Program' ? '✓' : 'Copy'}
                  </button>
                </div>
              </div>

              {amount && (
                <div>
                  <span className="text-xs text-gray-500 block mb-1">Amount (lamports)</span>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-gray-900 text-yellow-400 px-3 py-2 rounded-lg flex-1">
                      {Math.floor(parseFloat(amount) * 1e9)} lamports ({amount} SOL)
                    </code>
                    <button
                      onClick={() => copyToClipboard(String(Math.floor(parseFloat(amount) * 1e9)), 'Amount')}
                      className={`text-xs px-3 py-2 rounded-lg transition-colors ${
                        copied === 'Amount' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {copied === 'Amount' ? '✓' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3 mt-2">
              <p className="text-xs text-yellow-400">
                <strong>CLI Example:</strong> Send a plain SOL transfer to the vault using:
              </p>
              <code className="text-[10px] text-yellow-300 block mt-1 break-all select-all">
                solana transfer {VAULT_ADDRESS} {amount || '0.01'} --allow-unfunded-recipient
              </code>
            </div>
          </div>

          {/* Step 2: Enter TX signature */}
          <div className="bg-gray-800/50 rounded-xl p-4 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">
              Step 2: Enter Transaction Signature
            </h4>
            <p className="text-xs text-gray-500">
              After sending SOL, paste the transaction signature here so validators can track your deposit.
            </p>
            <input
              type="text"
              value={manualTxSig}
              onChange={(e) => setManualTxSig(e.target.value)}
              placeholder="Paste Solana TX signature..."
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm font-mono
                         focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
            />

            {recipientDcc ? (
              <p className="text-xs text-gray-400">
                DCC Recipient: <span className="text-green-400 font-mono">{recipientDcc}</span>
              </p>
            ) : (
              <p className="text-xs text-yellow-500">
                ↑ Fill in your DCC recipient address above first
              </p>
            )}

            <button
              onClick={handleManualDeposit}
              disabled={isSubmitting || !manualTxSig || !recipientDcc || !amount}
              className="btn-primary w-full"
            >
              {isSubmitting ? 'Verifying...' : 'Register Manual Deposit'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
