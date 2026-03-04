/**
 * ZK Prover Service — Solana Checkpoint Watcher & Proof Generator
 *
 * This is the main entry point for the prover service. It:
 * 1. Watches Solana for finalized deposit events
 * 2. Watches the CheckpointProgram for new finalized checkpoints
 * 3. When a checkpoint activates, collects all deposits in that window
 * 4. Generates Groth16 proofs for each deposit
 * 5. Submits proofs to the DCC bridge contract for minting
 */

import { Connection, PublicKey, Commitment } from '@solana/web3.js';
import {
  computeMessageId,
  MessageFields,
  SOL_CHAIN_ID,
  DCC_CHAIN_ID,
  hexToBytes,
  bytesToHex,
} from './message.js';
import { MerkleTree } from './merkle.js';
import { BridgeProver, DepositEvent, BridgeProof, ProverConfig } from './prover.js';

export { computeMessageId, MessageFields } from './message.js';
export { MerkleTree, MerkleProof } from './merkle.js';
export { BridgeProver, BridgeProof, DepositEvent, ProverConfig } from './prover.js';
export {
  SOL_CHAIN_ID,
  DCC_CHAIN_ID,
  DOMAIN_SEP,
  BRIDGE_VERSION,
  NATIVE_SOL_ASSET,
  MERKLE_TREE_DEPTH,
  computeLeaf,
  computeEmptyLeaf,
  hashPair,
  hexToBytes,
  bytesToHex,
  bytesToBitsLE,
  numberToBitsLE,
} from './message.js';

/**
 * Prover service configuration
 */
export interface ProverServiceConfig {
  /** Solana RPC URL */
  solanaRpcUrl: string;
  /** Bridge vault program ID */
  bridgeProgramId: string;
  /** Checkpoint registry program ID */
  checkpointProgramId: string;
  /** Prover circuit config */
  proverConfig: ProverConfig;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
}

/**
 * Checkpoint data from on-chain
 */
interface CheckpointData {
  checkpointId: number;
  slot: number;
  commitmentRoot: Uint8Array;
  eventCount: number;
  status: 'Pending' | 'Active' | 'Expired';
}

/**
 * ProverService — Long-running service that generates proofs
 */
export class ProverService {
  private config: ProverServiceConfig;
  private connection: Connection;
  private prover: BridgeProver;
  private running = false;

  /** Track which checkpoints we've already processed */
  private processedCheckpoints = new Set<number>();

  constructor(config: ProverServiceConfig) {
    this.config = config;
    this.connection = new Connection(config.solanaRpcUrl, 'finalized' as Commitment);
    this.prover = new BridgeProver(config.proverConfig);
  }

  /**
   * Start the prover service
   */
  async start(): Promise<void> {
    console.log('[ProverService] Starting...');
    console.log(`[ProverService] Solana RPC: ${this.config.solanaRpcUrl}`);
    console.log(`[ProverService] Bridge Program: ${this.config.bridgeProgramId}`);
    console.log(`[ProverService] Checkpoint Program: ${this.config.checkpointProgramId}`);

    this.running = true;

    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        console.error('[ProverService] Error in tick:', error);
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * Stop the prover service
   */
  stop(): void {
    this.running = false;
    console.log('[ProverService] Stopping...');
  }

  /**
   * Single tick — check for new active checkpoints and generate proofs
   */
  private async tick(): Promise<void> {
    // In production, this would:
    // 1. Query the CheckpointProgram for recently activated checkpoints
    // 2. For each new active checkpoint, fetch all deposit events in that slot range
    // 3. Build the Merkle tree
    // 4. Generate proofs for each deposit
    // 5. Submit proofs to DCC

    // For now, this is a skeleton that shows the flow
    console.log('[ProverService] Tick — checking for new checkpoints...');
  }

  /**
   * Process a specific checkpoint — generate proofs for all deposits
   */
  async processCheckpoint(
    checkpoint: CheckpointData,
    deposits: DepositEvent[]
  ): Promise<BridgeProof[]> {
    console.log(
      `[ProverService] Processing checkpoint #${checkpoint.checkpointId} with ${deposits.length} deposits`
    );

    // Compute all message IDs
    const messageIds = deposits.map((d) => {
      const fields: MessageFields = {
        srcChainId: d.srcChainId,
        dstChainId: d.dstChainId,
        srcProgramId: d.srcProgramId,
        slot: d.slot,
        eventIndex: d.eventIndex,
        sender: d.sender,
        recipient: d.recipientDcc,
        amount: d.amount,
        nonce: d.nonce,
        assetId: d.assetId,
      };
      return computeMessageId(fields);
    });

    // Build Merkle tree
    const tree = new MerkleTree(20);
    tree.buildFromMessageIds(messageIds);
    const computedRoot = tree.getRoot();

    // Verify computed root matches checkpoint
    if (bytesToHex(computedRoot) !== bytesToHex(checkpoint.commitmentRoot)) {
      throw new Error(
        `Merkle root mismatch: computed=${bytesToHex(computedRoot)}, checkpoint=${bytesToHex(
          checkpoint.commitmentRoot
        )}`
      );
    }

    // Generate proofs for each deposit
    const proofs: BridgeProof[] = [];
    for (let i = 0; i < deposits.length; i++) {
      console.log(
        `[ProverService] Generating proof ${i + 1}/${deposits.length} for checkpoint #${checkpoint.checkpointId}`
      );
      const proof = await this.prover.prove(deposits[i], messageIds, i);
      proofs.push(proof);
    }

    this.processedCheckpoints.add(checkpoint.checkpointId);
    console.log(
      `[ProverService] Checkpoint #${checkpoint.checkpointId} done — ${proofs.length} proofs generated`
    );

    return proofs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
