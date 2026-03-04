/**
 * DCC <-> Solana ZK Bridge — Merkle Tree Implementation
 *
 * Binary Merkle tree using Keccak256 for the bridge checkpoint system.
 * Each checkpoint's commitment_root is the root of this tree.
 *
 * Properties:
 * - Fixed depth: 20 (supports up to 1,048,576 events per checkpoint)
 * - Hash: Keccak256(left[32] || right[32])
 * - Empty leaf: Keccak256(bytes32(0))
 * - Deterministic construction from ordered event list
 */

import {
  computeLeaf,
  computeEmptyLeaf,
  hashPair,
  bytesToHex,
} from './message.js';

export interface MerkleProof {
  /** The leaf being proven */
  leaf: Uint8Array;
  /** Sibling hashes from bottom to top */
  siblings: Uint8Array[];
  /** Path indices: 0 = leaf is left child, 1 = leaf is right child */
  pathIndices: number[];
  /** The computed root */
  root: Uint8Array;
}

export class MerkleTree {
  readonly depth: number;
  readonly emptyLeaf: Uint8Array;
  private layers: Uint8Array[][];
  private leafCount: number;

  constructor(depth: number) {
    this.depth = depth;
    this.emptyLeaf = computeEmptyLeaf();
    this.layers = [];
    this.leafCount = 0;

    // Pre-compute empty subtree hashes for each level
    this.layers = new Array(depth + 1);
    this.layers[0] = [];
  }

  /**
   * Pre-computed empty hash at each level.
   * Level 0: emptyLeaf
   * Level i: Hash(emptyHash[i-1], emptyHash[i-1])
   */
  private emptyHashes: Uint8Array[] | null = null;

  private getEmptyHashes(): Uint8Array[] {
    if (this.emptyHashes) return this.emptyHashes;

    this.emptyHashes = new Array(this.depth + 1);
    this.emptyHashes[0] = this.emptyLeaf;
    for (let i = 1; i <= this.depth; i++) {
      this.emptyHashes[i] = hashPair(this.emptyHashes[i - 1], this.emptyHashes[i - 1]);
    }
    return this.emptyHashes;
  }

  /**
   * Build the tree from an array of message IDs.
   * Each message ID is hashed to produce a leaf: leaf = Keccak256(messageId)
   */
  buildFromMessageIds(messageIds: Uint8Array[]): void {
    const maxLeaves = 1 << this.depth;
    if (messageIds.length > maxLeaves) {
      throw new Error(
        `Too many leaves: ${messageIds.length} > max ${maxLeaves}`
      );
    }

    this.leafCount = messageIds.length;
    const emptyHashes = this.getEmptyHashes();

    // Build leaf layer
    const numLeaves = maxLeaves;
    this.layers[0] = new Array(numLeaves);

    for (let i = 0; i < messageIds.length; i++) {
      this.layers[0][i] = computeLeaf(messageIds[i]);
    }
    // Fill remaining with empty leaf
    for (let i = messageIds.length; i < numLeaves; i++) {
      this.layers[0][i] = emptyHashes[0];
    }

    // Build layers bottom-up
    for (let level = 1; level <= this.depth; level++) {
      const prevLayer = this.layers[level - 1];
      const layerSize = prevLayer.length / 2;
      this.layers[level] = new Array(layerSize);

      for (let i = 0; i < layerSize; i++) {
        this.layers[level][i] = hashPair(
          prevLayer[2 * i],
          prevLayer[2 * i + 1]
        );
      }
    }
  }

  /**
   * Get the Merkle root
   */
  getRoot(): Uint8Array {
    if (this.layers.length === 0 || !this.layers[this.depth]) {
      throw new Error('Tree not built yet');
    }
    return this.layers[this.depth][0];
  }

  /**
   * Generate a Merkle proof for the leaf at the given index
   */
  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      throw new Error(`Leaf index out of range: ${leafIndex}`);
    }

    const siblings: Uint8Array[] = [];
    const pathIndices: number[] = [];
    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      pathIndices.push(isRight ? 1 : 0);
      siblings.push(this.layers[level][siblingIndex]);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leaf: this.layers[0][leafIndex],
      siblings,
      pathIndices,
      root: this.getRoot(),
    };
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(proof: MerkleProof): boolean {
    let current = proof.leaf;

    for (let i = 0; i < proof.siblings.length; i++) {
      if (proof.pathIndices[i] === 0) {
        current = hashPair(current, proof.siblings[i]);
      } else {
        current = hashPair(proof.siblings[i], current);
      }
    }

    return bytesToHex(current) === bytesToHex(proof.root);
  }

  /**
   * Get the number of real (non-empty) leaves
   */
  getLeafCount(): number {
    return this.leafCount;
  }
}
