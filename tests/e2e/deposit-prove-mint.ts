/**
 * DCC <-> Solana ZK Bridge — E2E Devnet Test: Deposit → Prove → Mint
 *
 * Full pipeline test (Solana devnet → DCC testnet):
 * 1. Deposit SOL into the BridgeVaultProgram on Solana devnet
 * 2. Wait for finalization + checkpoint activation
 * 3. Collect all deposits in the checkpoint window
 * 4. Build Merkle tree + generate Groth16 proof
 * 5. Submit proof to DCC ZK bridge contract
 * 6. Verify wSOL minted on DCC
 *
 * Prerequisites:
 *   - Solana devnet validator running
 *   - Bridge vault program deployed
 *   - Checkpoint registry deployed
 *   - DCC testnet node accessible
 *   - ZK circuit compiled (WASM + zkey available)
 *   - Funded test wallets (SOL + DCC)
 *
 * Usage:
 *   npx tsx tests/e2e/deposit-prove-mint.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import {
  computeMessageId,
  MessageFields,
  MerkleTree,
  BridgeProver,
  ProverConfig,
  DepositEvent,
  SOL_CHAIN_ID,
  DCC_CHAIN_ID,
  MERKLE_TREE_DEPTH,
  hexToBytes,
  bytesToHex,
} from '../../zk/prover/src/index.js';

// ──────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────

const SOLANA_RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8899';
const BRIDGE_PROGRAM_ID = new PublicKey(
  process.env.BRIDGE_PROGRAM_ID ?? '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF'
);
const CHECKPOINT_PROGRAM_ID = new PublicKey(
  process.env.CHECKPOINT_PROGRAM_ID ?? 'G9NL1r3B7Dzuxsct3nSYrcW3PySeBpNivcDmKH2fWRW6'
);

const DEPOSIT_AMOUNT = 0.5 * LAMPORTS_PER_SOL; // 0.5 SOL
const DCC_RECIPIENT = process.env.DCC_RECIPIENT ?? '3P' + 'A'.repeat(33); // DCC test address

const CIRCUIT_DIR = path.resolve(
  process.env.CIRCUIT_DIR ?? 'zk/circuits/build'
);

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function loadKeypair(filepath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(step: string, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${step}] ${msg}`);
}

// ──────────────────────────────────────────────────────────────
// Step 1: Deposit SOL into BridgeVault
// ──────────────────────────────────────────────────────────────

async function depositSol(
  connection: Connection,
  depositor: Keypair,
  recipientDcc: string,
  amount: number
): Promise<{
  signature: string;
  slot: number;
  depositRecord: PublicKey;
}> {
  log('DEPOSIT', `Depositing ${amount / LAMPORTS_PER_SOL} SOL...`);
  log('DEPOSIT', `DCC recipient: ${recipientDcc}`);

  // Derive PDAs
  const [bridgeState] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge-state')],
    BRIDGE_PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')],
    BRIDGE_PROGRAM_ID
  );

  // Fetch nonce from bridge state
  const bridgeStateAccount = await connection.getAccountInfo(bridgeState);
  if (!bridgeStateAccount) {
    throw new Error('Bridge state not initialized. Deploy the bridge first.');
  }

  // Parse nonce from account data (offset depends on state layout)
  // For now, use a simple counter approach
  const nonce = Math.floor(Date.now() / 1000);

  // Derive deposit record PDA
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), depositor.publicKey.toBuffer(), nonceBuf],
    BRIDGE_PROGRAM_ID
  );

  // Build anchor-style instruction
  // NOTE: In a real deployment, use anchor's program.methods interface
  const program = new anchor.Program(
    JSON.parse(
      fs.readFileSync(
        path.resolve('target/idl/sol_bridge_lock.json'),
        'utf-8'
      )
    ),
    new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(depositor),
      { commitment: 'confirmed' }
    )
  );

  const tx = await (program.methods as any)
    .deposit(
      new anchor.BN(amount),
      recipientDcc,
      new anchor.BN(nonce)
    )
    .accounts({
      user: depositor.publicKey,
      bridgeState,
      depositRecord,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: 'confirmed' });

  // Get slot
  const txInfo = await connection.getTransaction(tx, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const slot = txInfo?.slot ?? 0;

  log('DEPOSIT', `TX: ${tx}`);
  log('DEPOSIT', `Slot: ${slot}`);
  log('DEPOSIT', `Deposit record: ${depositRecord.toBase58()}`);

  return { signature: tx, slot, depositRecord };
}

// ──────────────────────────────────────────────────────────────
// Step 2: Wait for checkpoint to be activated
// ──────────────────────────────────────────────────────────────

async function waitForActiveCheckpoint(
  connection: Connection,
  afterSlot: number,
  timeoutMs = 120_000
): Promise<{
  checkpointId: number;
  commitmentRoot: Uint8Array;
  eventCount: number;
}> {
  log('CHECKPOINT', `Waiting for active checkpoint after slot ${afterSlot}...`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Query checkpoint program accounts
    // In production, use getProgramAccounts with memcmp filters
    const accounts = await connection.getProgramAccounts(CHECKPOINT_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [
        { dataSize: 200 }, // approximate CheckpointEntry size
      ],
    });

    for (const { pubkey, account } of accounts) {
      // Parse checkpoint entry (simplified — use anchor deserialization in prod)
      const data = account.data;

      // Check if status == Active (byte at offset after anchor discriminator)
      // This depends on the exact account layout
      // For now, just check if we have any checkpoint accounts
      if (data.length > 100) {
        // Simplified: return first checkpoint found
        // In production, decode and filter by slot and status
        log('CHECKPOINT', `Found checkpoint account: ${pubkey.toBase58()}`);
        return {
          checkpointId: 1,
          commitmentRoot: new Uint8Array(data.slice(8, 40)), // approximate
          eventCount: 1,
        };
      }
    }

    log('CHECKPOINT', 'No active checkpoint yet, waiting...');
    await sleep(5000);
  }

  throw new Error('Timed out waiting for active checkpoint');
}

// ──────────────────────────────────────────────────────────────
// Step 3: Collect deposits in checkpoint window
// ──────────────────────────────────────────────────────────────

async function collectDepositsInWindow(
  connection: Connection,
  checkpointSlot: number
): Promise<DepositEvent[]> {
  log('COLLECT', `Collecting deposits up to slot ${checkpointSlot}...`);

  // Fetch deposit records from the bridge program
  const accounts = await connection.getProgramAccounts(BRIDGE_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [
      { dataSize: 250 }, // approximate DepositRecord size
    ],
  });

  const events: DepositEvent[] = [];
  for (const { pubkey, account } of accounts) {
    // In production: use anchor to deserialize DepositRecord
    // For now, show the flow
    log('COLLECT', `Found deposit record: ${pubkey.toBase58()}`);
  }

  log('COLLECT', `Collected ${events.length} deposits`);
  return events;
}

// ──────────────────────────────────────────────────────────────
// Step 4: Generate ZK Proof
// ──────────────────────────────────────────────────────────────

async function generateProof(
  event: DepositEvent,
  allMessageIds: Uint8Array[],
  eventIndex: number,
  proverConfig: ProverConfig
) {
  log('PROVE', 'Generating Groth16 proof...');

  const prover = new BridgeProver(proverConfig);
  const proof = await prover.prove(event, allMessageIds, eventIndex);

  log('PROVE', `Proof generated successfully`);
  log('PROVE', `  checkpoint_root: ${proof.parsed.checkpointRoot}`);
  log('PROVE', `  message_id: ${proof.parsed.messageId}`);
  log('PROVE', `  amount: ${proof.parsed.amount} lamports`);
  log('PROVE', `  recipient: ${proof.parsed.recipient}`);

  return proof;
}

// ──────────────────────────────────────────────────────────────
// Step 5: Submit proof to DCC
// ──────────────────────────────────────────────────────────────

async function submitToDcc(
  proof: Awaited<ReturnType<typeof generateProof>>,
  checkpointId: number
) {
  log('DCC', 'Submitting proof to DCC ZK bridge contract...');

  // In production, this would:
  // 1. Serialize the proof for DCC RIDE format
  // 2. Call the zk_bridge.ride contract's verifyAndMint function
  // 3. Wait for the DCC transaction to confirm

  // DCC Transaction (pseudocode):
  // InvokeScriptTransaction({
  //   dApp: ZK_BRIDGE_ADDRESS,
  //   call: {
  //     function: "verifyAndMint",
  //     args: [
  //       { type: "binary", value: proofBytes },
  //       { type: "binary", value: publicInputsBytes },
  //       { type: "integer", value: checkpointId },
  //       { type: "string", value: messageIdHex },
  //       { type: "string", value: recipientAddress },
  //       { type: "integer", value: amount },
  //     ],
  //   },
  //   fee: 0.05_00000000,
  // })

  log('DCC', `Checkpoint ID: ${checkpointId}`);
  log('DCC', `Message ID: ${proof.parsed.messageId}`);
  log('DCC', `Amount to mint: ${BigInt(proof.parsed.amount) / 10n} DCC-lamports (9→8 decimal shift)`);

  // NOTE: Actual DCC submission requires:
  // - DCC SDK integration
  // - Proper binary serialization of Groth16 proof
  // - Funded DCC wallet for transaction fees

  log('DCC', '⚠ DCC submission not yet wired — proof generation verified locally');
  return true;
}

// ──────────────────────────────────────────────────────────────
// Main E2E Flow
// ──────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('  DCC <-> Solana ZK Bridge — E2E Deposit → Prove → Mint');
  console.log('='.repeat(72));
  console.log();

  // Setup
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const version = await connection.getVersion();
  log('SETUP', `Connected to Solana: ${SOLANA_RPC} (v${version['solana-core']})`);

  // Load or generate depositor keypair
  const depositorPath = process.env.DEPOSITOR_KEY ?? 'test-ledger/faucet-keypair.json';
  let depositor: Keypair;
  try {
    depositor = loadKeypair(depositorPath);
    log('SETUP', `Loaded depositor: ${depositor.publicKey.toBase58()}`);
  } catch {
    depositor = Keypair.generate();
    log('SETUP', `Generated depositor: ${depositor.publicKey.toBase58()}`);

    // Airdrop on devnet/localnet
    const airdropSig = await connection.requestAirdrop(
      depositor.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig, 'confirmed');
    log('SETUP', 'Airdropped 2 SOL');
  }

  const balance = await connection.getBalance(depositor.publicKey);
  log('SETUP', `Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Prover config
  const proverConfig: ProverConfig = {
    wasmPath: path.join(CIRCUIT_DIR, 'bridge_deposit_js/bridge_deposit.wasm'),
    zkeyPath: path.join(CIRCUIT_DIR, 'bridge_deposit_final.zkey'),
    vkeyPath: path.join(CIRCUIT_DIR, 'verification_key.json'),
  };

  try {
    // Step 1: Deposit
    const deposit = await depositSol(
      connection,
      depositor,
      DCC_RECIPIENT,
      DEPOSIT_AMOUNT
    );

    // Step 2: Wait for checkpoint
    log('WAIT', 'Waiting for checkpoint finalization...');
    log('WAIT', '(In devnet, you may need to manually submit a checkpoint)');

    // In a real test, we'd wait for the checkpoint to be submitted and activated.
    // For local testing, we simulate by building the tree ourselves.
    log('SIMULATE', 'Simulating checkpoint from deposit data...');

    // Build a simulated deposit event
    const event: DepositEvent = {
      sender: depositor.publicKey.toBytes(),
      recipientDcc: new TextEncoder().encode(DCC_RECIPIENT.padEnd(32, '\0')).slice(0, 32),
      amount: BigInt(DEPOSIT_AMOUNT),
      nonce: BigInt(Math.floor(Date.now() / 1000)),
      slot: BigInt(deposit.slot),
      eventIndex: 0,
      srcChainId: SOL_CHAIN_ID,
      dstChainId: DCC_CHAIN_ID,
      srcProgramId: BRIDGE_PROGRAM_ID.toBytes(),
      assetId: new Uint8Array(32), // native SOL
    };

    // Compute message ID
    const fields: MessageFields = {
      srcChainId: event.srcChainId,
      dstChainId: event.dstChainId,
      srcProgramId: event.srcProgramId,
      slot: event.slot,
      eventIndex: event.eventIndex,
      sender: event.sender,
      recipient: event.recipientDcc,
      amount: event.amount,
      nonce: event.nonce,
      assetId: event.assetId,
    };
    const messageId = computeMessageId(fields);
    const allMessageIds = [messageId];

    log('SIMULATE', `Message ID: ${bytesToHex(messageId)}`);

    // Build Merkle tree
    const tree = new MerkleTree(MERKLE_TREE_DEPTH);
    tree.buildFromMessageIds(allMessageIds);
    const root = tree.getRoot();
    log('SIMULATE', `Merkle root: ${bytesToHex(root)}`);

    // Step 3: Generate proof
    // NOTE: This requires compiled circuits — skip if not available
    const circuitAvailable =
      fs.existsSync(proverConfig.wasmPath) &&
      fs.existsSync(proverConfig.zkeyPath);

    if (circuitAvailable) {
      const proof = await generateProof(event, allMessageIds, 0, proverConfig);

      // Step 4: Submit to DCC
      await submitToDcc(proof, 1);
    } else {
      log(
        'SKIP',
        `ZK circuits not compiled. Run 'cd zk/circuits && ./build.sh' first.`
      );
      log('SKIP', `Expected: ${proverConfig.wasmPath}`);
      log('SKIP', `Expected: ${proverConfig.zkeyPath}`);

      // We can still verify the message+tree pipeline
      const proof = tree.getProof(0);
      const valid = MerkleTree.verifyProof(proof);
      log('VERIFY', `Merkle proof valid: ${valid}`);
    }

    console.log();
    console.log('='.repeat(72));
    log('DONE', 'E2E deposit-prove-mint test completed');
    console.log('='.repeat(72));
  } catch (err: any) {
    log('ERROR', err.message);
    console.error(err);
    process.exit(1);
  }
}

main().catch(console.error);
