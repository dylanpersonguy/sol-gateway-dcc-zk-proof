import React, { useState, useMemo, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';
import { useBridgeStore } from '../hooks/useBridgeStore';
import { bridgeApi } from '../services/api';
import { getSwapQuote, buildSwapTransaction, estimateUsdcOutput } from '../services/jupiter';
import {
  DUSD_SOURCE_TOKENS,
  DUSD,
  DUSD_MINT_FEE_RATE,
  DUSD_MINT_FEE_DISPLAY,
  DUSD_MINT_MINIMUM,
} from '../config/dusd';
import { type MintableToken } from '../config/cr-stable';
import { RedeemDUSD } from './RedeemDUSD';
import { TransferProgress } from './TransferProgress';
import toast from 'react-hot-toast';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// SPL program IDs — inlined to avoid @solana/spl-token dependency
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Derive the Associated Token Account address (no off-curve check needed here). */
function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// deposit (native SOL) discriminator — kept for reference
// const DEPOSIT_DISC = new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]);
// deposit_spl discriminator = sha256("global:deposit_spl")[0:8]
const DEPOSIT_SPL_DISC = new Uint8Array([224, 0, 198, 175, 198, 47, 105, 204]);
const BRIDGE_PROGRAM_ID = '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';

export function MintDUSD() {
  const { publicKey: adapterPubkey, signTransaction: adapterSign } = useWallet();
  const { getPublicKey, getSignTransaction } = usePhantom();
  const publicKey = getPublicKey(adapterPubkey);
  const signTransaction = getSignTransaction(adapterSign ?? null);
  const { connection } = useConnection();
  const { setActiveTransfer, activeTransfer, updateTransferStatus } = useBridgeStore();

  const [mode, setMode] = useState<'mint' | 'redeem'>('mint');
  const [selectedSource, setSelectedSource] = useState<MintableToken>(DUSD_SOURCE_TOKENS[0]);
  const [amount, setAmount] = useState('');
  const [recipientDcc, setRecipientDcc] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // SOL swap estimate
  const [solQuote, setSolQuote] = useState<{ usdcAmount: number; priceImpact: string; rate: number } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const walletConnected = !!publicKey && !!signTransaction;
  const isSOL = selectedSource.symbol === 'SOL';

  const amountNum = parseFloat(amount);
  const validAmount = !isNaN(amountNum) && amountNum > 0;

  const mintAmount = useMemo(() => {
    if (!validAmount) return 0;
    if (isSOL) {
      return solQuote ? solQuote.usdcAmount * (1 - DUSD_MINT_FEE_RATE) : 0;
    }
    return amountNum * (1 - DUSD_MINT_FEE_RATE);
  }, [amountNum, validAmount, isSOL, solQuote]);

  const feeAmount = useMemo(() => {
    if (!validAmount) return 0;
    if (isSOL) {
      return solQuote ? solQuote.usdcAmount * DUSD_MINT_FEE_RATE : 0;
    }
    return amountNum * DUSD_MINT_FEE_RATE;
  }, [amountNum, validAmount, isSOL, solQuote]);

  // Fetch Jupiter quote when SOL is selected
  useEffect(() => {
    if (!isSOL || !validAmount) {
      setSolQuote(null);
      return;
    }
    let cancelled = false;
    const fetchQuote = async () => {
      setQuoteLoading(true);
      try {
        const result = await estimateUsdcOutput(amountNum);
        if (!cancelled) setSolQuote(result);
      } catch (err) {
        console.error('Jupiter quote error:', err);
        if (!cancelled) setSolQuote(null);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    };
    const timer = setTimeout(fetchQuote, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isSOL, amountNum, validAmount]);

  const handleMint = async () => {
    if (!walletConnected) {
      toast.error('Connect your wallet first');
      return;
    }
    if (!validAmount || amountNum < DUSD_MINT_MINIMUM) {
      toast.error(`Minimum mint amount is $${DUSD_MINT_MINIMUM}`);
      return;
    }
    if (!recipientDcc || recipientDcc.length < 20) {
      toast.error('Enter a valid DCC recipient address');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isSOL) {
        await handleSOLMint();
      } else {
        await handleStableMint();
      }
    } catch (err: any) {
      console.error('Mint error:', err);
      const msg = err?.message || String(err);
      if (msg.includes('User rejected')) {
        toast.error('Transaction rejected');
      } else {
        toast.error(`Mint failed: ${msg.slice(0, 120)}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Build a deposit_spl instruction.
   * Uses the correct Anchor discriminator, token accounts, and 6-decimal amount.
   */
  const buildSplDepositTx = async (splMintAddress: string, amountDecimal: number) => {
    const programId = new PublicKey(BRIDGE_PROGRAM_ID);
    const splMintPubkey = new PublicKey(splMintAddress);

    const [bridgeConfig] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bridge_config')], programId,
    );
    const [userState] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('user_state'), publicKey!.toBytes()], programId,
    );

    // Sender's ATA for the SPL mint
    const senderTokenAccount = getAssociatedTokenAddressSync(splMintPubkey, publicKey!);
    // Bridge vault ATA for the SPL mint (owned by bridge_config PDA — off-curve)
    const vaultTokenAccount = getAssociatedTokenAddressSync(splMintPubkey, bridgeConfig, true);

    // ── Pre-flight: verify balance ──
    const symbol = splMintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : 'USDT';
    const requiredUnits = BigInt(Math.round(amountDecimal * 1e6));

    const ataInfo = await connection.getAccountInfo(senderTokenAccount);
    if (!ataInfo) {
      throw new Error(`No ${symbol} token account found. Please acquire ${symbol} first.`);
    }
    const tokenBalance = ataInfo.data.readBigUInt64LE(64);
    if (tokenBalance < requiredUnits) {
      const have = (Number(tokenBalance) / 1e6).toFixed(2);
      throw new Error(`Insufficient balance: you have ${have} ${symbol}, need ${amountDecimal.toFixed(2)}.`);
    }

    let nonce = 0n;
    const usInfo = await connection.getAccountInfo(userState);
    if (usInfo && usInfo.data.length >= 48) {
      nonce = usInfo.data.readBigUInt64LE(40);
    }

    const tidBuf = new Uint8Array(40);
    tidBuf.set(publicKey!.toBytes(), 0);
    const nonceBytes = new ArrayBuffer(8);
    new DataView(nonceBytes).setBigUint64(0, nonce, true);
    tidBuf.set(new Uint8Array(nonceBytes), 32);
    const hashBuffer = await crypto.subtle.digest('SHA-256', tidBuf);
    const transferId = new Uint8Array(hashBuffer);

    const [depositRecord] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('deposit'), transferId], programId,
    );

    let recipientBytes: Uint8Array;
    try {
      const decoded = bs58.decode(recipientDcc);
      recipientBytes = new Uint8Array(32);
      recipientBytes.set(decoded.slice(0, 32), 0);
    } catch {
      const enc = new TextEncoder().encode(recipientDcc);
      recipientBytes = new Uint8Array(32);
      recipientBytes.set(enc.slice(0, 32), 0);
    }

    // Amount in token smallest units: USDC/USDT = 6 decimals
    const amountTokenUnits = BigInt(Math.round(amountDecimal * 1e6));

    const ixData = new Uint8Array(8 + 32 + 8 + 32);
    ixData.set(DEPOSIT_SPL_DISC, 0);
    ixData.set(recipientBytes, 8);
    new DataView(ixData.buffer).setBigUint64(40, amountTokenUnits, true);
    ixData.set(transferId, 48);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: bridgeConfig,          isSigner: false, isWritable: true  },
        { pubkey: userState,             isSigner: false, isWritable: true  },
        { pubkey: depositRecord,         isSigner: false, isWritable: true  },
        { pubkey: splMintPubkey,         isSigner: false, isWritable: false },
        { pubkey: senderTokenAccount,    isSigner: false, isWritable: true  },
        { pubkey: vaultTokenAccount,     isSigner: false, isWritable: true  },
        { pubkey: publicKey!,            isSigner: true,  isWritable: true  },
        { pubkey: SPL_TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(ixData),
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey! });
    tx.add(ix);
    return { tx, transferId, blockhash, lastValidBlockHeight };
  };

  const handleStableMint = async () => {
    const { tx, transferId, blockhash, lastValidBlockHeight } = await buildSplDepositTx(
      selectedSource.splMint, amountNum,
    );

    toast.success('Sign the transaction in your wallet');
    const signedTx = await signTransaction!(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    toast.success(`Deposit sent! Tx: ${signature.slice(0, 16)}...`);

    const transferIdHex = Array.from(transferId).map((b) => b.toString(16).padStart(2, '0')).join('');

    setActiveTransfer({
      transferId: transferIdHex,
      status: 'pending_confirmation',
      direction: 'sol_to_dcc',
      amount: amountNum.toString(),
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      splMint: selectedSource.splMint,
      tokenSymbol: `${selectedSource.symbol} → ${DUSD.symbol}`,
      useZk: false,
    });

    bridgeApi.registerTransfer({
      transferId: transferIdHex,
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      amount: amountNum.toString(),
      amountFormatted: `${amountNum} ${selectedSource.symbol} → ${DUSD.symbol}`,
      splMint: selectedSource.splMint,
      sourceTxHash: signature,
      direction: 'sol_to_dcc',
    }).catch(() => {});

    connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, 'confirmed',
    ).then((conf) => {
      if (conf.value.err) {
        toast.error('Transaction failed on-chain');
      } else {
        updateTransferStatus('awaiting_consensus');
        toast.success('Deposit confirmed! DUSD will be minted shortly.');
      }
    });
  };

  const handleSOLMint = async () => {
    if (!solQuote) {
      toast.error('Waiting for price quote...');
      return;
    }

    toast.success('Step 1/2: Swapping SOL → USDC via Jupiter...');

    const lamports = BigInt(Math.round(amountNum * 1e9));
    const quote = await getSwapQuote(lamports);
    const swapTx = await buildSwapTransaction(quote, publicKey!.toBase58());

    const txBuf = Buffer.from(swapTx.swapTransaction, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);

    const provider = (window as any).phantom?.solana ?? (window as any).solana;
    if (!provider) throw new Error('Phantom wallet not found');

    const signedSwap = await provider.signTransaction(versionedTx);
    const swapSig = await connection.sendRawTransaction(signedSwap.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    toast.success(`Swap sent! Tx: ${swapSig.slice(0, 16)}...`);

    const { blockhash: swapBh, lastValidBlockHeight: swapLvbh } = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: swapSig, blockhash: swapBh, lastValidBlockHeight: swapLvbh },
      'confirmed',
    );

    toast.success('Swap confirmed! Step 2/2: Depositing USDC into gateway...');

    const usdcAmountRaw = Number(quote.outAmount);
    const usdcAmountDecimal = usdcAmountRaw / 1e6;

    const usdcSource = DUSD_SOURCE_TOKENS.find((t) => t.symbol === 'USDC')!;
    const { tx, transferId, blockhash, lastValidBlockHeight } = await buildSplDepositTx(
      usdcSource.splMint, usdcAmountDecimal,
    );

    toast.success('Sign the deposit transaction');
    const signedTx = await signTransaction!(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    toast.success(`Deposit sent! Tx: ${signature.slice(0, 16)}...`);

    const transferIdHex = Array.from(transferId).map((b) => b.toString(16).padStart(2, '0')).join('');

    setActiveTransfer({
      transferId: transferIdHex,
      status: 'pending_confirmation',
      direction: 'sol_to_dcc',
      amount: usdcAmountDecimal.toString(),
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      splMint: usdcSource.splMint,
      tokenSymbol: `SOL → ${DUSD.symbol}`,
      useZk: false,
    });

    bridgeApi.registerTransfer({
      transferId: transferIdHex,
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      amount: usdcAmountDecimal.toString(),
      amountFormatted: `${amountNum} SOL → ${mintAmount.toFixed(2)} ${DUSD.symbol}`,
      splMint: usdcSource.splMint,
      sourceTxHash: signature,
      direction: 'sol_to_dcc',
    }).catch(() => {});

    connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    ).then((conf) => {
      if (conf.value.err) {
        toast.error('Deposit transaction failed on-chain');
      } else {
        updateTransferStatus('awaiting_consensus');
        toast.success('Deposit confirmed! DUSD will be minted shortly.');
      }
    });
  };

  if (activeTransfer) {
    return <TransferProgress />;
  }

  if (mode === 'redeem') {
    return (
      <div className="space-y-6">
        <div className="card">
          <div className="flex gap-2 p-1 bg-gray-800 rounded-xl">
            <button
              onClick={() => setMode('mint')}
              className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white"
            >
              <span>$</span> Mint {DUSD.symbol}
            </button>
            <button
              onClick={() => setMode('redeem')}
              className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-amber-600 text-white shadow-lg"
            >
              <span>↩</span> Redeem {DUSD.symbol}
            </button>
          </div>
        </div>
        <RedeemDUSD />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mode Toggle */}
      <div className="card">
        <div className="flex gap-2 p-1 bg-gray-800 rounded-xl">
          <button
            onClick={() => setMode('mint')}
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white shadow-lg"
          >
            <span>$</span> Mint {DUSD.symbol}
          </button>
          <button
            onClick={() => setMode('redeem')}
            className="flex-1 py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white"
          >
            <span>↩</span> Redeem {DUSD.symbol}
          </button>
        </div>
      </div>

      {/* Hero */}
      <div className="card bg-gradient-to-br from-blue-950/40 to-gray-900/40 border-blue-500/20">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-blue-500/30">
            $
          </div>
          <div>
            <h1 className="text-xl font-bold">Mint {DUSD.symbol}</h1>
            <p className="text-xs text-gray-400">{DUSD.fullName} — backed 1:1 by USD reserves</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed">
          Deposit USDT, USDC, or SOL on Solana. Your collateral is locked in the bridge vault and
          {' '}{DUSD.symbol} is minted on DecentralChain via the ZK-verified gateway.
        </p>
      </div>

      {/* Source Token Selector */}
      <div className="card space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-3">Pay With</label>
          <div className="grid grid-cols-3 gap-2">
            {DUSD_SOURCE_TOKENS.map((token) => (
              <button
                key={token.splMint}
                onClick={() => {
                  setSelectedSource(token);
                  setSolQuote(null);
                }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all ${
                  selectedSource.splMint === token.splMint
                    ? 'border-blue-500 bg-blue-600/20 text-white shadow-md shadow-blue-500/10'
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
                <div className="text-left">
                  <div className="font-medium text-sm">{token.symbol}</div>
                  {token.requiresSwap && (
                    <div className="text-[9px] text-yellow-400">via Jupiter</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Amount</label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min={isSOL ? '0.01' : '1'}
              step={isSOL ? '0.01' : '1'}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-lg
                         focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium">
              {selectedSource.symbol}
            </span>
          </div>
        </div>

        {/* DCC Recipient */}
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
                       focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Quote / Fee Breakdown */}
        <div className="bg-gray-800/50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">You deposit</span>
            <span>{amount || '0'} {selectedSource.symbol}</span>
          </div>

          {isSOL && validAmount && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Jupiter swap</span>
              {quoteLoading ? (
                <span className="text-gray-500 text-xs">Fetching quote...</span>
              ) : solQuote ? (
                <span className="text-blue-400">
                  ≈ {solQuote.usdcAmount.toFixed(2)} USDC
                  <span className="text-gray-500 text-xs ml-1">
                    (1 SOL ≈ ${solQuote.rate.toFixed(2)})
                  </span>
                </span>
              ) : (
                <span className="text-gray-500 text-xs">—</span>
              )}
            </div>
          )}

          {isSOL && solQuote && parseFloat(solQuote.priceImpact) > 1 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Price impact</span>
              <span className="text-yellow-400 text-xs">{solQuote.priceImpact}%</span>
            </div>
          )}

          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Mint fee ({DUSD_MINT_FEE_DISPLAY})</span>
            {feeAmount > 0 ? (
              <span className="text-yellow-400">−${feeAmount.toFixed(4)}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </div>

          {isSOL && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Process</span>
              <span className="text-xs text-blue-300">SOL → USDC (Jupiter) → Gateway → {DUSD.symbol}</span>
            </div>
          )}

          <div className="border-t border-gray-700 pt-2 mt-2" />

          <div className="flex justify-between text-sm font-medium">
            <span className="text-gray-300">You receive</span>
            <span className="text-blue-400 text-lg">
              {mintAmount > 0 ? `${mintAmount.toFixed(2)} ${DUSD.symbol}` : `0 ${DUSD.symbol}`}
            </span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Network</span>
            <span className="text-xs">DecentralChain</span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Estimated time</span>
            <span className="text-xs">{isSOL ? '~2 minutes' : '~45 seconds'}</span>
          </div>
        </div>

        {/* Mint Button */}
        {walletConnected ? (
          <button
            onClick={handleMint}
            disabled={isSubmitting || !validAmount || !recipientDcc || (isSOL && !solQuote)}
            className="w-full py-3.5 rounded-xl font-semibold text-lg transition-all
                       bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {isSOL ? 'Swapping & Minting...' : 'Minting...'}
              </span>
            ) : (
              `Mint ${DUSD.symbol}`
            )}
          </button>
        ) : (
          <div className="text-center text-gray-500 text-sm py-3">
            Connect your Phantom wallet above to mint {DUSD.symbol}
          </div>
        )}
      </div>

      {/* How It Works */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
          <span className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-[10px] text-white font-bold">?</span>
          How {DUSD.symbol} Works
        </h3>
        <div className="space-y-3">
          {[
            {
              icon: '💵',
              title: 'Deposit Collateral',
              desc: 'Send USDT, USDC, or SOL on Solana. SOL is auto-swapped to USDC via Jupiter.',
            },
            {
              icon: '🔒',
              title: 'Lock in Vault',
              desc: 'Your stablecoins are locked in the non-custodial bridge PDA vault on Solana.',
            },
            {
              icon: '🔐',
              title: 'ZK Verification',
              desc: 'Validators create a Groth16 zero-knowledge proof of the deposit.',
            },
            {
              icon: '💎',
              title: `Mint ${DUSD.symbol}`,
              desc: `${DUSD.symbol} is minted 1:1 on DecentralChain, fully backed by the locked reserves.`,
            },
            {
              icon: '🔄',
              title: 'Redeem Anytime',
              desc: `Burn ${DUSD.symbol} on DCC to unlock your USDT/USDC on Solana.`,
            },
          ].map((step) => (
            <div key={step.title} className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center text-base">
                {step.icon}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-200">{step.title}</div>
                <div className="text-xs text-gray-500 leading-relaxed">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reserve Info */}
      <div className="card bg-blue-950/20 border-blue-500/10">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-6 h-6 rounded-md bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">$</div>
          <h3 className="text-sm font-semibold text-blue-300">Reserve Backing</h3>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed mb-3">
          Every {DUSD.symbol} is backed 1:1 by USDT/USDC locked in the Solana bridge vault.
          Reserves are verifiable on-chain at any time.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '🏦', label: '1:1 USD Backed', desc: 'USDT/USDC reserves' },
            { icon: '🔒', label: 'PDA Vault', desc: 'Non-custodial on Solana' },
            { icon: '🔐', label: 'ZK Verified', desc: 'Groth16 proof of reserves' },
            { icon: '🔄', label: 'Redeemable', desc: 'Burn to unlock collateral' },
          ].map((item) => (
            <div key={item.label} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-800/40 border border-gray-700/30">
              <span className="text-base flex-shrink-0 mt-0.5">{item.icon}</span>
              <div>
                <span className="text-xs font-medium text-gray-200 block">{item.label}</span>
                <span className="text-[10px] text-gray-500">{item.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
