import { useConnection } from '@solana/wallet-adapter-react';
import { usePhantom } from '../context/PhantomContext';
import { useWallet } from '@solana/wallet-adapter-react';
import { bridgeApi } from '../services/api';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import toast from 'react-hot-toast';

const DEPOSIT_DISC = new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]);

function encodeRecipientBytes(recipientDcc: string): Uint8Array {
  const recipientBytes = new Uint8Array(32);
  try {
    const decoded = bs58.decode(recipientDcc);
    recipientBytes.set(decoded.slice(0, 32), 0);
  } catch {
    const enc = new TextEncoder().encode(recipientDcc);
    recipientBytes.set(enc.slice(0, 32), 0);
  }
  return recipientBytes;
}

async function computeTransferId(publicKey: PublicKey, nonce: bigint): Promise<Uint8Array> {
  const tidBuf = new Uint8Array(40);
  tidBuf.set(publicKey.toBytes(), 0);
  const nonceBytes = new ArrayBuffer(8);
  new DataView(nonceBytes).setBigUint64(0, nonce, true);
  tidBuf.set(new Uint8Array(nonceBytes), 32);
  const hashBuffer = await crypto.subtle.digest('SHA-256', tidBuf);
  return new Uint8Array(hashBuffer);
}

async function readNonce(connection: any, userState: PublicKey): Promise<bigint> {
  const usInfo = await connection.getAccountInfo(userState);
  if (usInfo && usInfo.data.length >= 48) {
    return usInfo.data.readBigUInt64LE(40);
  }
  return 0n;
}

export function transferIdToHex(transferId: Uint8Array): string {
  return Array.from(transferId)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildNativeDepositTx(
  connection: any,
  publicKey: PublicKey,
  recipientDcc: string,
  metadata: {
    programId: string;
    bridgeConfig: string;
    vault: string;
    userState: string;
    amountLamports: string;
  },
): Promise<{ tx: Transaction; transferId: Uint8Array; blockhash: string; lastValidBlockHeight: number }> {
  const programId = new PublicKey(metadata.programId);
  const bridgeConfig = new PublicKey(metadata.bridgeConfig);
  const vault = new PublicKey(metadata.vault);
  const userState = new PublicKey(metadata.userState);
  const amountLamports = BigInt(metadata.amountLamports);

  const nonce = await readNonce(connection, userState);
  const transferId = await computeTransferId(publicKey, nonce);

  const [depositRecord] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('deposit'), transferId],
    programId,
  );

  const recipientBytes = encodeRecipientBytes(recipientDcc);

  const ixData = new Uint8Array(8 + 32 + 8 + 32);
  ixData.set(DEPOSIT_DISC, 0);
  ixData.set(recipientBytes, 8);
  new DataView(ixData.buffer).setBigUint64(40, amountLamports, true);
  ixData.set(transferId, 48);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: bridgeConfig,            isSigner: false, isWritable: true  },
      { pubkey: userState,               isSigner: false, isWritable: true  },
      { pubkey: depositRecord,           isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: true  },
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
  tx.add(ix);

  return { tx, transferId, blockhash, lastValidBlockHeight };
}
