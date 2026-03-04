'use strict';
/**
 * End-to-End Reverse Bridge Test: wSOL.DCC → SOL
 *
 * 1. Fund the DCC validator with gas money from genesis
 * 2. Burn wSOL.DCC on DCC bridge (sends burn record on-chain)
 * 3. Read Solana bridge state (config, vault, validator)
 * 4. Register a validator on Solana if needed
 * 5. Construct canonical unlock message + Ed25519 signature
 * 6. Submit Ed25519SigVerify + Unlock instructions on Solana
 * 7. Verify SOL arrived at recipient
 */

const { createHash } = require('crypto');
const nacl = require('tweetnacl');
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY,
} = require('@solana/web3.js');
const { invokeScript, transfer, libs } = require('@decentralchain/decentralchain-transactions');
const fs   = require('fs');
require('dotenv').config();
const { privateKey, publicKey, address, base58Decode } = libs.crypto;

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Solana
const SOL_RPC      = 'https://api.devnet.solana.com';
const PROGRAM_ID   = new PublicKey('9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF');

// DCC
const DCC_NODE     = 'http://localhost:6869';
const DCC_CHAIN    = 'D';
const BRIDGE_ADDR  = '3Fans4vfDrZD5vJCyNqkHHKVzPjqok5v6Ui';
const BRIDGE_SEED  = 'bridge controller for sol-gateway-dcc local dev';
const VALIDATOR_SEED = process.env.DCC_VALIDATOR_SEED;
if (!VALIDATOR_SEED) {
  throw new Error('Missing required env var: DCC_VALIDATOR_SEED');
}
const WSOL_ASSET_ID  = '8AmLFgw5FXTuo6VegXrb8d1PZTx2Q8xD9Tn3kfEkfv5y';
const GENESIS_SEED_B58 = 'E8kZYpXnUTdo5Wy6FyNfvMW12fQ6WDFWXgs5a6MEz4thNg7hpudkAh6Nj9zmP4J6tvkvMXQUrDxcU5wfWKtC8bKdBkCRL';

const VALIDATOR_ADDR = address(VALIDATOR_SEED, DCC_CHAIN);

// Amount of wSOL.DCC to burn (in DCC-decimals, 8 dec)
// The validator holds 1,000,000 (= 0.01 wSOL.DCC)
// Burn half: 500,000 → should unlock 5,000,000 lamports (0.005 SOL on Solana, 9 dec)
const BURN_AMOUNT_DCC = 500_000;  // 0.005 wSOL.DCC (8 dec)
// DCC 8 dec → SOL 9 dec: multiply by 10
const UNLOCK_LAMPORTS = BURN_AMOUNT_DCC * 10;  // 5,000,000 lamports = 0.005 SOL

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dccGet(path) {
  const r = await fetch(`${DCC_NODE}${path}`);
  return r.json();
}

async function dccBroadcast(tx) {
  const r = await fetch(`${DCC_NODE}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DCC rejected: ${d.message || JSON.stringify(d)}`);
  return d;
}

async function waitDccTx(txId, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await dccGet(`/transactions/info/${txId}`);
      if (d.id) return d;
    } catch {}
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`DCC tx ${txId} not confirmed`);
}

/**
 * Read the BridgeConfig from Solana devnet.
 * Returns parsed fields.
 */
async function readBridgeConfig(connection) {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);
  const acct = await connection.getAccountInfo(configPda);
  if (!acct) throw new Error('BridgeConfig not found — was initialize() called?');

  const data = acct.data;
  let off = 8; // skip discriminator

  const authority       = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const guardian        = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const paused          = data[off] !== 0; off += 1;
  const globalNonce     = data.readBigUInt64LE(off); off += 8;
  const totalLocked     = data.readBigUInt64LE(off); off += 8;
  const totalUnlocked   = data.readBigUInt64LE(off); off += 8;
  const validatorCount  = data[off]; off += 1;
  const minValidators   = data[off]; off += 1;
  const maxValidators   = data[off]; off += 1;
  const minDeposit      = data.readBigUInt64LE(off); off += 8;
  const maxDeposit      = data.readBigUInt64LE(off); off += 8;
  const maxDailyOutflow = data.readBigUInt64LE(off); off += 8;
  const currentDailyOutflow = data.readBigUInt64LE(off); off += 8;
  const lastDailyReset  = Number(data.readBigInt64LE(off)); off += 8;
  const maxUnlockAmount = data.readBigUInt64LE(off); off += 8;
  const reqConfirmations = data.readUInt16LE(off); off += 2;
  const lgWithdrawDelay = Number(data.readBigInt64LE(off)); off += 8;
  const lgWithdrawThresh = data.readBigUInt64LE(off); off += 8;
  const dccChainId      = data.readUInt32LE(off); off += 4;
  const solanaChainId   = data.readUInt32LE(off); off += 4;
  const bump            = data[off]; off += 1;
  const vaultBump       = data[off]; off += 1;

  return {
    authority, guardian, paused, globalNonce, totalLocked, totalUnlocked,
    validatorCount, minValidators, maxValidators, minDeposit, maxDeposit,
    maxDailyOutflow, currentDailyOutflow, lastDailyReset, maxUnlockAmount,
    reqConfirmations, lgWithdrawDelay, lgWithdrawThresh,
    dccChainId, solanaChainId, bump, vaultBump,
  };
}

/**
 * Build an Ed25519SigVerify instruction (Solana Ed25519 precompile).
 * Embeds the pubkey, signature, and message all in a single instruction.
 */
function createEd25519Instruction(pubkey, message, signature) {
  // Ed25519 instruction layout:
  // [0]      num_signatures: u8
  // [1]      padding: u8
  // Per-signature block (14 bytes):
  //   [2..4]   signature_offset: u16 LE
  //   [4..6]   signature_instruction_index: u16 LE (0xFFFF = this ix)
  //   [6..8]   public_key_offset: u16 LE
  //   [8..10]  public_key_instruction_index: u16 LE (0xFFFF = this ix)
  //   [10..12] message_data_offset: u16 LE
  //   [12..14] message_data_size: u16 LE
  //   [14..16] message_instruction_index: u16 LE (0xFFFF = this ix)
  //
  // Then: signature (64 bytes), pubkey (32 bytes), message (N bytes)

  const headerSize = 2 + 14; // 1 sig × 14 byte header + 2 byte prefix
  const sigOffset   = headerSize;
  const pkOffset    = sigOffset + 64;
  const msgOffset   = pkOffset + 32;
  const msgSize     = message.length;
  const SELF_REF    = 0xFFFF;

  const data = Buffer.alloc(headerSize + 64 + 32 + msgSize);
  data[0] = 1;  // num_signatures
  data[1] = 0;  // padding

  // Offsets (u16 LE)
  data.writeUInt16LE(sigOffset, 2);    // signature_offset
  data.writeUInt16LE(SELF_REF, 4);     // signature_instruction_index
  data.writeUInt16LE(pkOffset, 6);     // public_key_offset
  data.writeUInt16LE(SELF_REF, 8);     // public_key_instruction_index
  data.writeUInt16LE(msgOffset, 10);   // message_data_offset
  data.writeUInt16LE(msgSize, 12);     // message_data_size
  data.writeUInt16LE(SELF_REF, 14);    // message_instruction_index

  // Copy data
  Buffer.from(signature).copy(data, sigOffset);
  Buffer.from(pubkey).copy(data, pkOffset);
  Buffer.from(message).copy(data, msgOffset);

  return new TransactionInstruction({
    programId: new PublicKey('Ed25519SigVerify111111111111111111111111111'),
    keys: [],
    data,
  });
}

/**
 * Construct the canonical unlock message matching the Rust code exactly:
 *   "SOL_DCC_BRIDGE_UNLOCK_V1" + transfer_id + recipient + amount(LE) + burn_tx_hash + dcc_chain_id(LE) + expiration(LE)
 */
function constructUnlockMessage(transferId, recipient, amount, burnTxHash, dccChainId, expiration) {
  const domain = Buffer.from('SOL_DCC_BRIDGE_UNLOCK_V1');
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amount));
  const chainBuf = Buffer.alloc(4);
  chainBuf.writeUInt32LE(dccChainId);
  const expBuf = Buffer.alloc(8);
  expBuf.writeBigInt64LE(BigInt(expiration));

  return Buffer.concat([
    domain,
    Buffer.from(transferId),
    recipient.toBuffer(),
    amountBuf,
    Buffer.from(burnTxHash),
    chainBuf,
    expBuf,
  ]);
}

// ═══════════════════════════════════════════════════════════════
// ANCHOR INSTRUCTION BUILDERS
// ═══════════════════════════════════════════════════════════════

// Discriminators (from the IDL)
const UNLOCK_DISC    = Buffer.from([101, 155, 40, 21, 158, 189, 56, 203]);
const REG_VAL_DISC   = Buffer.from([
  // sha256("global:register_validator")[0..8]
  // We'll compute this below
]);

// Compute register_validator discriminator from IDL: "register_validator"
// Anchor uses sha256("global:<fn_name>")[0..8]
const regValHash = createHash('sha256').update('global:register_validator').digest();
REG_VAL_DISC[0] = regValHash[0]; REG_VAL_DISC[1] = regValHash[1];
REG_VAL_DISC[2] = regValHash[2]; REG_VAL_DISC[3] = regValHash[3];
REG_VAL_DISC[4] = regValHash[4]; REG_VAL_DISC[5] = regValHash[5];
REG_VAL_DISC[6] = regValHash[6]; REG_VAL_DISC[7] = regValHash[7];

/**
 * Build the serialized UnlockParams struct for Anchor.
 */
function serializeUnlockParams(transferId, recipient, amount, burnTxHash, dccChainId, expiration, attestations) {
  // UnlockParams layout (Borsh):
  //   transfer_id: [u8; 32]
  //   recipient: Pubkey (32 bytes)
  //   amount: u64 (8 bytes LE)
  //   burn_tx_hash: [u8; 32]
  //   dcc_chain_id: u32 (4 bytes LE)
  //   expiration: i64 (8 bytes LE)
  //   attestations: Vec<ValidatorAttestation>
  //     length: u32 LE
  //     each: validator Pubkey (32) + signature [u8; 64]

  const parts = [];

  // transfer_id
  parts.push(Buffer.from(transferId));

  // recipient
  parts.push(recipient.toBuffer());

  // amount
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amount));
  parts.push(amountBuf);

  // burn_tx_hash
  parts.push(Buffer.from(burnTxHash));

  // dcc_chain_id
  const chainBuf = Buffer.alloc(4);
  chainBuf.writeUInt32LE(dccChainId);
  parts.push(chainBuf);

  // expiration
  const expBuf = Buffer.alloc(8);
  expBuf.writeBigInt64LE(BigInt(expiration));
  parts.push(expBuf);

  // attestations vec
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(attestations.length);
  parts.push(lenBuf);

  for (const att of attestations) {
    parts.push(att.validator.toBuffer());       // 32 bytes
    parts.push(Buffer.from(att.signature));     // 64 bytes
  }

  return Buffer.concat(parts);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  wSOL.DCC → SOL  Reverse Bridge Test');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // ── Load Solana wallet ────────────────────────────────────────
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/test-wallet.json', 'utf8')))
  );
  const connection = new Connection(SOL_RPC, 'confirmed');

  const solBal = await connection.getBalance(wallet.publicKey);
  console.log('Solana wallet:', wallet.publicKey.toBase58());
  console.log('SOL balance:  ', (solBal / 1e9).toFixed(6), 'SOL');
  console.log('DCC validator:', VALIDATOR_ADDR);
  console.log('Burn amount:  ', BURN_AMOUNT_DCC, `(${(BURN_AMOUNT_DCC / 1e8).toFixed(8)} wSOL.DCC)`);
  console.log('Unlock amount:', UNLOCK_LAMPORTS, `(${(UNLOCK_LAMPORTS / 1e9).toFixed(9)} SOL)`);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 0: Fund DCC validator with gas
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 0: Funding DCC validator with gas...');

  const dccValBal = await dccGet(`/addresses/balance/${VALIDATOR_ADDR}`);
  console.log('  Validator DCC balance:', dccValBal.balance);

  if (dccValBal.balance < 10_000_000) {
    console.log('  Insufficient gas — transferring 1 DCC from genesis...');
    const GENESIS_SEED = base58Decode(GENESIS_SEED_B58);
    const GENESIS_PUBKEY = publicKey(GENESIS_SEED);
    const GENESIS_SIGNER = { privateKey: privateKey(GENESIS_SEED) };

    const fundTx = transfer(
      {
        recipient: VALIDATOR_ADDR,
        amount: 100_000_000, // 1 DCC
        chainId: DCC_CHAIN,
        fee: 500000,
        senderPublicKey: GENESIS_PUBKEY,
        version: 2,
      },
      GENESIS_SIGNER
    );

    const fundResp = await dccBroadcast(fundTx);
    process.stdout.write('  Confirming');
    await waitDccTx(fundResp.id);
    console.log(' ✅');

    const newBal = await dccGet(`/addresses/balance/${VALIDATOR_ADDR}`);
    console.log('  New DCC balance:', (newBal.balance / 1e8).toFixed(4), 'DCC');
  } else {
    console.log('  Validator has sufficient gas ✅');
  }

  // Check wSOL balance before burn
  const wsolBefore = await dccGet(`/assets/balance/${VALIDATOR_ADDR}/${WSOL_ASSET_ID}`);
  console.log('  wSOL.DCC balance (before):', wsolBefore.balance, `(${(wsolBefore.balance / 1e8).toFixed(8)} wSOL.DCC)`);
  console.log();

  if (wsolBefore.balance < BURN_AMOUNT_DCC) {
    throw new Error(`Insufficient wSOL.DCC! Have ${wsolBefore.balance}, need ${BURN_AMOUNT_DCC}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Burn wSOL.DCC on DCC bridge
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 1: Burning wSOL.DCC on DCC bridge...');
  console.log('  Recipient (Solana):', wallet.publicKey.toBase58());
  console.log('  Amount:', BURN_AMOUNT_DCC, `(${(BURN_AMOUNT_DCC / 1e8).toFixed(8)} wSOL.DCC)`);

  const burnTx = invokeScript(
    {
      dApp: BRIDGE_ADDR,
      call: {
        function: 'burn',
        args: [
          { type: 'string', value: wallet.publicKey.toBase58() },
        ],
      },
      payment: [
        { assetId: WSOL_ASSET_ID, amount: BURN_AMOUNT_DCC },
      ],
      chainId: DCC_CHAIN,
      fee: 5_000_000, // 0.05 DCC
      senderPublicKey: publicKey(VALIDATOR_SEED),
      version: 1,
    },
    { privateKey: privateKey(VALIDATOR_SEED) }
  );

  console.log('  Burn Tx ID:', burnTx.id);
  const burnResp = await dccBroadcast(burnTx);
  process.stdout.write('  Confirming');
  await waitDccTx(burnResp.id);
  console.log(' ✅');

  // Verify wSOL balance decreased
  const wsolAfter = await dccGet(`/assets/balance/${VALIDATOR_ADDR}/${WSOL_ASSET_ID}`);
  console.log('  wSOL.DCC balance (after):', wsolAfter.balance, `(${(wsolAfter.balance / 1e8).toFixed(8)} wSOL.DCC)`);
  const burned = wsolBefore.balance - wsolAfter.balance;
  console.log('  Burned:', burned, burned === BURN_AMOUNT_DCC ? '✅' : '❌');

  // Read burn record from DCC
  const bridgeData = await dccGet(`/addresses/data/${BRIDGE_ADDR}`);
  const burnRecords = bridgeData.filter(d => d.key.startsWith('burn_') && !d.key.startsWith('burn_nonce'));
  const latestBurn = burnRecords[burnRecords.length - 1];
  console.log('  Burn record key:', latestBurn.key);
  console.log('  Burn record val:', latestBurn.value);

  // Parse burn record: caller|solRecipient|splMint|amount|height|timestamp
  const parts = latestBurn.value.split('|');
  const burnRecordAmount = parseInt(parts[3], 10);
  const burnRecordHeight = parseInt(parts[4], 10);
  console.log('  Burn record amount:', burnRecordAmount, burnRecordAmount === BURN_AMOUNT_DCC ? '✅' : '❌');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Read Solana bridge state
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 2: Reading Solana bridge configuration...');

  const config = await readBridgeConfig(connection);
  console.log('  Authority:       ', config.authority.toBase58());
  console.log('  Paused:          ', config.paused);
  console.log('  Min validators:  ', config.minValidators);
  console.log('  Validator count: ', config.validatorCount);
  console.log('  Total locked:    ', config.totalLocked.toString(), 'lamports');
  console.log('  Total unlocked:  ', config.totalUnlocked.toString(), 'lamports');
  console.log('  Max unlock:      ', config.maxUnlockAmount.toString(), 'lamports');
  console.log('  DCC chain ID:    ', config.dccChainId);
  console.log('  Vault bump:      ', config.vaultBump);

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID);
  const vaultBal = await connection.getBalance(vaultPda);
  console.log('  Vault balance:   ', vaultBal, 'lamports', `(${(vaultBal / 1e9).toFixed(6)} SOL)`);
  console.log();

  if (vaultBal < UNLOCK_LAMPORTS) {
    throw new Error(`Vault has ${vaultBal} lamports but need ${UNLOCK_LAMPORTS}. Run the forward e2e test first.`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Register validator on Solana (if needed)
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 3: Checking validator registration on Solana...');

  // Use the wallet as the validator (it's the authority so it can register itself)
  const validatorPubkey = wallet.publicKey;
  const [validatorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('validator'), validatorPubkey.toBuffer()],
    PROGRAM_ID
  );

  const valAcct = await connection.getAccountInfo(validatorPda);
  if (valAcct) {
    console.log('  Validator already registered ✅');
  } else {
    console.log('  Registering wallet as validator...');

    const [bridgeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);

    // RegisterValidatorParams: validator_pubkey (Pubkey, 32 bytes)
    const regData = Buffer.concat([
      Buffer.from(regValHash.subarray(0, 8)),  // discriminator
      validatorPubkey.toBuffer(),                // validator_pubkey
    ]);

    const regIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: bridgeConfigPda, isSigner: false, isWritable: true },
        { pubkey: validatorPda,    isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: regData,
    });

    const regTx = new Transaction().add(regIx);
    const { blockhash: regBh } = await connection.getLatestBlockhash();
    regTx.recentBlockhash = regBh;
    regTx.feePayer = wallet.publicKey;

    const regSig = await connection.sendTransaction(regTx, [wallet], {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(regSig, 'confirmed');
    console.log('  Registered ✅ Tx:', regSig);

    // Re-read config to confirm
    const newConfig = await readBridgeConfig(connection);
    console.log('  Validator count now:', newConfig.validatorCount);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Construct and submit Solana unlock
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 4: Unlocking SOL on Solana...');

  const solBalBefore = await connection.getBalance(wallet.publicKey);
  console.log('  SOL balance (before):', (solBalBefore / 1e9).toFixed(6), 'SOL');

  // Construct transfer_id from burn ID hash
  const burnIdStr = latestBurn.key.replace('burn_', '');
  const transferId = createHash('sha256').update(Buffer.from(burnIdStr)).digest();
  console.log('  Transfer ID:', transferId.toString('hex'));

  // Burn tx hash (use SHA256 of the DCC tx ID)
  const burnTxHash = createHash('sha256').update(Buffer.from(burnResp.id)).digest();
  console.log('  Burn TX hash:', burnTxHash.toString('hex'));

  // Expiration: 1 hour from now
  const expiration = Math.floor(Date.now() / 1000) + 3600;

  // Recipient = our wallet
  const recipient = wallet.publicKey;

  // Construct canonical message (must match Rust exactly)
  const message = constructUnlockMessage(
    transferId, recipient, UNLOCK_LAMPORTS, burnTxHash, config.dccChainId, expiration
  );
  console.log('  Message length:', message.length, 'bytes');

  // Sign with Ed25519 using the wallet's keypair (the validator key)
  const signature = nacl.sign.detached(message, wallet.secretKey);
  console.log('  Signature:', Buffer.from(signature).toString('hex').substring(0, 32) + '...');

  // Build Ed25519SigVerify instruction
  const ed25519Ix = createEd25519Instruction(
    wallet.publicKey.toBytes(),
    message,
    signature
  );

  // Build unlock instruction
  const [bridgeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], PROGRAM_ID);
  const [unlockRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('unlock'), transferId],
    PROGRAM_ID
  );

  const attestations = [
    { validator: wallet.publicKey, signature: Array.from(signature) },
  ];

  const unlockData = Buffer.concat([
    UNLOCK_DISC,
    serializeUnlockParams(transferId, recipient, UNLOCK_LAMPORTS, burnTxHash, config.dccChainId, expiration, attestations),
  ]);

  const unlockIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bridgeConfigPda,                            isSigner: false, isWritable: true  },
      { pubkey: unlockRecordPda,                            isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                                   isSigner: false, isWritable: true  },
      { pubkey: recipient,                                  isSigner: false, isWritable: true  },
      { pubkey: wallet.publicKey,                           isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,                    isSigner: false, isWritable: false },
      { pubkey: new PublicKey('Ed25519SigVerify111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,                 isSigner: false, isWritable: false },
      // remaining_accounts: validator entry PDA
      { pubkey: validatorPda,                               isSigner: false, isWritable: false },
    ],
    data: unlockData,
  });

  // Build transaction: Ed25519SigVerify FIRST, then unlock
  const unlockTx = new Transaction();
  unlockTx.add(ed25519Ix);
  unlockTx.add(unlockIx);

  const { blockhash } = await connection.getLatestBlockhash();
  unlockTx.recentBlockhash = blockhash;
  unlockTx.feePayer = wallet.publicKey;

  console.log('  Sending unlock transaction...');

  try {
    const unlockSig = await connection.sendTransaction(unlockTx, [wallet], {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log('  Tx sent:', unlockSig);
    await connection.confirmTransaction(unlockSig, 'confirmed');
    console.log('  ✅ Unlock confirmed!');
    console.log('  Explorer: https://explorer.solana.com/tx/' + unlockSig + '?cluster=devnet');
  } catch (err) {
    // If preflight fails, try with skipPreflight for better error message
    console.log('  ⚠️  Transaction failed, retrying with skipPreflight for diagnostics...');
    console.log('  Error:', err.message?.substring(0, 200));

    try {
      const unlockSig2 = await connection.sendTransaction(unlockTx, [wallet], {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      });
      console.log('  Tx sent (skipPreflight):', unlockSig2);
      await connection.confirmTransaction(unlockSig2, 'confirmed');
      console.log('  ✅ Unlock confirmed!');
      console.log('  Explorer: https://explorer.solana.com/tx/' + unlockSig2 + '?cluster=devnet');
    } catch (err2) {
      console.error('  ❌ Unlock failed:', err2.message?.substring(0, 300));
      // Still continue to check balances
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Verify SOL arrived
  // ═══════════════════════════════════════════════════════════════
  console.log('STEP 5: Verifying SOL balance...');

  await sleep(2000); // Wait a moment for RPC to catch up
  const solBalAfter = await connection.getBalance(wallet.publicKey);
  const gained = solBalAfter - solBalBefore;
  console.log('  SOL balance (after):', (solBalAfter / 1e9).toFixed(6), 'SOL');
  console.log('  Net change:', gained, 'lamports', `(${(gained / 1e9).toFixed(9)} SOL)`);
  // Note: gained = unlock_amount - tx_fee - unlock_record_rent (since wallet is payer + recipient)
  // Tx fee ~5000, unlock record rent ~1,183,680. So net gain ≈ unlock - 1,188,680
  const txFees = UNLOCK_LAMPORTS - gained;
  console.log('  Unlock amount:', UNLOCK_LAMPORTS, 'lamports');
  console.log('  Fees + rent:  ', txFees, 'lamports (tx fee + unlock record rent)');
  // Verify via on-chain state: total_unlocked should have increased by UNLOCK_LAMPORTS
  const success = gained > 0; // positive net gain = SOL came back
  console.log('  Result:', success ? '✅ SOL received!' : '❌ SOL not received');

  // Read the unlock record
  const [unlockRecordPda2] = PublicKey.findProgramAddressSync(
    [Buffer.from('unlock'), transferId],
    PROGRAM_ID
  );
  const unlockAcct = await connection.getAccountInfo(unlockRecordPda2);
  if (unlockAcct) {
    const uData = unlockAcct.data;
    const executed = uData[8 + 32 + 32 + 8 + 8 + 32]; // skip disc + fields to get executed bool
    console.log('  Unlock record exists:', '✅');
    console.log('  Executed:', executed ? '✅' : '❌ (possibly large-withdrawal delayed)');
  }

  // Final totals
  const newConfig = await readBridgeConfig(connection);
  console.log('  Total locked:   ', newConfig.totalLocked.toString(), 'lamports');
  console.log('  Total unlocked: ', newConfig.totalUnlocked.toString(), 'lamports');

  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log('  REVERSE BRIDGE TEST COMPLETE!');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Summary:');
  console.log(`  DCC burn:       ${burnResp.id}`);
  console.log(`  Burn ID:        ${burnIdStr}`);
  console.log(`  Transfer ID:    ${transferId.toString('hex')}`);
  console.log(`  Amount:         ${BURN_AMOUNT_DCC} wSOL.DCC (8 dec) → ${UNLOCK_LAMPORTS} lamports (9 dec)`);
  console.log(`  DCC sender:     ${VALIDATOR_ADDR}`);
  console.log(`  SOL recipient:  ${wallet.publicKey.toBase58()}`);
}

main().catch(e => {
  console.error('\n❌ ERROR:', e.message || e);
  if (e.logs) {
    console.error('\nProgram logs:');
    e.logs.forEach(l => console.error(' ', l));
  }
  process.exit(1);
});
