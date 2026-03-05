import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=b2d48101-dab0-43d8-863a-2db864a1a059';
const PROGRAM_ID = new PublicKey('9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');

const conn = new Connection(RPC_URL, 'confirmed');
const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID);

const keyPath = process.env.SOLANA_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
const keyData = JSON.parse(readFileSync(keyPath, 'utf8'));
const wallet = Keypair.fromSecretKey(Uint8Array.from(keyData));

const walletBal = await conn.getBalance(wallet.publicKey);
const vaultBal = await conn.getBalance(vault);

console.log('Wallet:', wallet.publicKey.toBase58());
console.log('Wallet balance:', walletBal / 1e9, 'SOL');
console.log('Vault PDA:', vault.toBase58());
console.log('Vault balance:', vaultBal / 1e9, 'SOL');
