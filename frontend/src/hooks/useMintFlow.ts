import { useState, useMemo, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';
import { useBridgeStore } from './useBridgeStore';
import { bridgeApi } from '../services/api';
import { getSwapQuote, buildSwapTransaction, estimateUsdcOutput } from '../services/jupiter';
import { type MintableToken } from '../config/cr-stable';
import toast from 'react-hot-toast';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

const DEPOSIT_SPL_DISC = new Uint8Array([224, 0, 198, 175, 198, 47, 105, 204]);
const BRIDGE_PROGRAM_ID = '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF';

export interface MintFlowConfig {
  sourceTokens: MintableToken[];
  targetToken: { symbol: string; fullName: string };
  feeRate: number;
  feeDisplay: string;
  minimum: number;
}

export function useMintFlow(config: MintFlowConfig) {
  const { publicKey: adapterPubkey, signTransaction: adapterSign } = useWallet();
  const { getPublicKey, getSignTransaction } = usePhantom();
  const publicKey = getPublicKey(adapterPubkey);
  const signTransaction = getSignTransaction(adapterSign ?? null);
  const { connection } = useConnection();
  const { setActiveTransfer, activeTransfer, updateTransferStatus } = useBridgeStore();

  const [selectedSource, setSelectedSource] = useState<MintableToken>(config.sourceTokens[0]);
  const [amount, setAmount] = useState('');
  const [recipientDcc, setRecipientDcc] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [solQuote, setSolQuote] = useState<{ usdcAmount: number; priceImpact: string; rate: number } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const walletConnected = !!publicKey && !!signTransaction;
  const isSOL = selectedSource.symbol === 'SOL';
  const amountNum = parseFloat(amount);
  const validAmount = !isNaN(amountNum) && amountNum > 0;

  const mintAmount = useMemo(() => {
    if (!validAmount) return 0;
    if (isSOL) return solQuote ? solQuote.usdcAmount * (1 - config.feeRate) : 0;
    return amountNum * (1 - config.feeRate);
  }, [amountNum, validAmount, isSOL, solQuote, config.feeRate]);

  const feeAmount = useMemo(() => {
    if (!validAmount) return 0;
    if (isSOL) return solQuote ? solQuote.usdcAmount * config.feeRate : 0;
    return amountNum * config.feeRate;
  }, [amountNum, validAmount, isSOL, solQuote, config.feeRate]);

  // Fetch Jupiter quote when SOL selected
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

  const buildSplDepositTx = async (splMintAddress: string, amountDecimal: number) => {
    const programId = new PublicKey(BRIDGE_PROGRAM_ID);
    const splMintPubkey = new PublicKey(splMintAddress);

    const [bridgeConfig] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bridge_config')], programId,
    );
    const [userState] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('user_state'), publicKey!.toBytes()], programId,
    );

    const senderTokenAccount = getAssociatedTokenAddressSync(splMintPubkey, publicKey!);
    const vaultTokenAccount = getAssociatedTokenAddressSync(splMintPubkey, bridgeConfig, true);

    const sym = splMintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : 'USDT';
    const requiredUnits = BigInt(Math.round(amountDecimal * 1e6));

    const ataInfo = await connection.getAccountInfo(senderTokenAccount);
    if (!ataInfo) throw new Error(`No ${sym} token account found. Please acquire ${sym} first.`);
    const tokenBalance = ataInfo.data.readBigUInt64LE(64);
    if (tokenBalance < requiredUnits) {
      throw new Error(`Insufficient ${sym}: you have ${(Number(tokenBalance)/1e6).toFixed(2)}, need ${amountDecimal.toFixed(2)}.`);
    }

    let nonce = 0n;
    const usInfo = await connection.getAccountInfo(userState);
    if (usInfo && usInfo.data.length >= 48) nonce = usInfo.data.readBigUInt64LE(40);

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

  const sendAndRegister = async (
    tx: Transaction,
    transferId: Uint8Array,
    blockhash: string,
    lastValidBlockHeight: number,
    tokenSymbolLabel: string,
    splMint: string,
    depositAmount: string,
    confirmMsg: string,
  ) => {
    toast.success('Sign the transaction in your wallet');
    const signedTx = await signTransaction!(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    toast.success(`Deposit sent! Tx: ${signature.slice(0, 16)}...`);

    const transferIdHex = Array.from(transferId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    setActiveTransfer({
      transferId: transferIdHex,
      status: 'pending_confirmation',
      direction: 'sol_to_dcc',
      amount: depositAmount,
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      splMint,
      tokenSymbol: tokenSymbolLabel,
      useZk: false,
    });

    bridgeApi.registerTransfer({
      transferId: transferIdHex,
      sender: publicKey!.toBase58(),
      recipient: recipientDcc,
      amount: depositAmount,
      amountFormatted: `${depositAmount} ${tokenSymbolLabel}`,
      splMint,
      sourceTxHash: signature,
      direction: 'sol_to_dcc',
    }).catch(() => {});

    connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    ).then((conf: any) => {
      if (conf.value.err) {
        toast.error('Transaction failed on-chain');
      } else {
        updateTransferStatus('awaiting_consensus');
        toast.success(confirmMsg);
      }
    });
  };

  const handleStableMint = async () => {
    const { tx, transferId, blockhash, lastValidBlockHeight } = await buildSplDepositTx(
      selectedSource.splMint, amountNum,
    );
    await sendAndRegister(
      tx, transferId, blockhash, lastValidBlockHeight,
      `${selectedSource.symbol} → ${config.targetToken.symbol}`,
      selectedSource.splMint,
      amountNum.toString(),
      `Deposit confirmed! ${config.targetToken.symbol} will be minted shortly.`,
    );
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

    const usdcSource = config.sourceTokens.find((t) => t.symbol === 'USDC')!;
    const { tx, transferId, blockhash, lastValidBlockHeight } = await buildSplDepositTx(
      usdcSource.splMint, usdcAmountDecimal,
    );

    await sendAndRegister(
      tx, transferId, blockhash, lastValidBlockHeight,
      `SOL → ${config.targetToken.symbol}`,
      usdcSource.splMint,
      usdcAmountDecimal.toString(),
      `Deposit confirmed! ${config.targetToken.symbol} will be minted shortly.`,
    );
  };

  const handleMint = async () => {
    if (!walletConnected) {
      toast.error('Connect your wallet first');
      return;
    }
    if (!validAmount || amountNum < config.minimum) {
      toast.error(`Minimum mint amount is $${config.minimum}`);
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

  return {
    selectedSource,
    setSelectedSource: (t: MintableToken) => { setSelectedSource(t); setSolQuote(null); },
    amount,
    setAmount,
    recipientDcc,
    setRecipientDcc,
    isSubmitting,
    walletConnected,
    isSOL,
    validAmount,
    amountNum,
    mintAmount,
    feeAmount,
    solQuote,
    quoteLoading,
    activeTransfer,
    handleMint,
  };
}
