/**
 * DCC <-> Solana ZK Bridge — Groth16 Prover Service
 *
 * This service:
 * 1. Takes a deposit event + checkpoint root as input
 * 2. Builds a Merkle inclusion witness
 * 3. Generates a Groth16 proof that:
 *    (i) message_id = Keccak256(domain_sep || fields)
 *    (ii) leaf = Keccak256(message_id) is in the Merkle tree with the given root
 *    (iii) root == checkpoint_root (public input)
 * 4. Returns proof + public inputs for DCC verification
 *
 * Proof System: Groth16 on BN128 via snarkjs
 */

import * as snarkjs from 'snarkjs';
import * as fs from 'fs';
import * as path from 'path';
import {
  MessageFields,
  computeMessageId,
  bytesToBitsLE,
  numberToBitsLE,
  bytesToHex,
  hexToBytes,
  DOMAIN_SEP,
  MERKLE_TREE_DEPTH,
} from './message.js';
import { MerkleTree, MerkleProof } from './merkle.js';

/**
 * Deposit event data from Solana on-chain
 */
export interface DepositEvent {
  sender: Uint8Array;       // 32 bytes — Solana pubkey
  recipientDcc: Uint8Array; // 32 bytes — DCC address
  amount: bigint;           // lamports
  nonce: bigint;
  slot: bigint;
  eventIndex: number;
  srcChainId: number;
  dstChainId: number;
  srcProgramId: Uint8Array; // 32 bytes
  assetId: Uint8Array;      // 32 bytes
}

/**
 * Proof output — ready for DCC on-chain verification
 */
export interface BridgeProof {
  /** Groth16 proof (A, B, C curve points) */
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  /** Public inputs as field element strings */
  publicInputs: string[];
  /** Parsed public inputs for convenience */
  parsed: {
    checkpointRoot: string;
    messageId: string;
    amount: string;
    recipient: string;
    assetId: string;
    srcChainId: number;
    dstChainId: number;
    version: number;
  };
}

/**
 * Prover configuration
 */
export interface ProverConfig {
  /** Path to compiled circuit WASM */
  wasmPath: string;
  /** Path to Groth16 proving key (zkey) */
  zkeyPath: string;
  /** Path to verification key JSON */
  vkeyPath: string;
}

/**
 * The BridgeProver class generates Groth16 proofs for deposit events.
 */
export class BridgeProver {
  private config: ProverConfig;
  private vkey: any | null = null;

  constructor(config: ProverConfig) {
    this.config = config;
  }

  /**
   * Load the verification key (for local proof verification before submission)
   */
  async loadVkey(): Promise<any> {
    if (!this.vkey) {
      const raw = fs.readFileSync(this.config.vkeyPath, 'utf-8');
      this.vkey = JSON.parse(raw);
    }
    return this.vkey;
  }

  /**
   * Generate a Groth16 proof for a deposit event.
   *
   * @param event        The deposit event data
   * @param allMessageIds All message IDs in the checkpoint window (for tree building)
   * @param eventIdx      Index of this event's message_id in the allMessageIds array
   * @returns BridgeProof ready for DCC submission
   */
  async prove(
    event: DepositEvent,
    allMessageIds: Uint8Array[],
    eventIdx: number
  ): Promise<BridgeProof> {
    // 1. Compute message fields
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

    // 2. Build Merkle tree and get proof
    const tree = new MerkleTree(MERKLE_TREE_DEPTH);
    tree.buildFromMessageIds(allMessageIds);
    const merkleProof = tree.getProof(eventIdx);
    const checkpointRoot = tree.getRoot();

    // 3. Convert all data to circuit input format (bit arrays)
    const circuitInput = this.buildCircuitInput(
      fields,
      messageId,
      checkpointRoot,
      merkleProof
    );

    // 4. Generate Groth16 proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      this.config.wasmPath,
      this.config.zkeyPath
    );

    // 5. Optionally verify locally
    const vkey = await this.loadVkey();
    const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!isValid) {
      throw new Error('Local proof verification failed — circuit witness error');
    }

    return {
      proof,
      publicInputs: publicSignals,
      parsed: {
        checkpointRoot: bytesToHex(checkpointRoot),
        messageId: bytesToHex(messageId),
        amount: event.amount.toString(),
        recipient: bytesToHex(event.recipientDcc),
        assetId: bytesToHex(event.assetId),
        srcChainId: event.srcChainId,
        dstChainId: event.dstChainId,
        version: 1,
      },
    };
  }

  /**
   * Build the circuit input (all signals as arrays of bits/field elements)
   */
  private buildCircuitInput(
    fields: MessageFields,
    messageId: Uint8Array,
    checkpointRoot: Uint8Array,
    merkleProof: MerkleProof
  ): Record<string, any> {
    const domainSepBytes = new TextEncoder().encode(DOMAIN_SEP);

    return {
      // Public inputs
      checkpoint_root: bytesToBitsLE(checkpointRoot),
      message_id: bytesToBitsLE(messageId),
      amount_bits: numberToBitsLE(fields.amount, 64),
      recipient: bytesToBitsLE(fields.recipient),
      asset_id: bytesToBitsLE(fields.assetId),
      src_chain_id: numberToBitsLE(fields.srcChainId, 32),
      dst_chain_id: numberToBitsLE(fields.dstChainId, 32),
      version: numberToBitsLE(1, 32),

      // Private inputs
      domain_sep: bytesToBitsLE(domainSepBytes),
      src_program_id: bytesToBitsLE(fields.srcProgramId),
      slot_bits: numberToBitsLE(fields.slot, 64),
      event_index_bits: numberToBitsLE(fields.eventIndex, 32),
      sender: bytesToBitsLE(fields.sender),
      nonce_bits: numberToBitsLE(fields.nonce, 64),
      siblings: merkleProof.siblings.map((s) => bytesToBitsLE(s)),
      path_indices: merkleProof.pathIndices,
    };
  }
}

/**
 * Verify a Groth16 proof given the verification key
 */
export async function verifyProof(
  vkeyPath: string,
  proof: any,
  publicSignals: string[]
): Promise<boolean> {
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/**
 * Export verification key to Solidity calldata format
 * (useful for testing/debugging)
 */
export async function proofToCalldata(
  proof: any,
  publicSignals: string[]
): Promise<string> {
  return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
