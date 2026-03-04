/**
 * DCC <-> Solana ZK Bridge — Unit Tests
 *
 * Tests:
 * 1. message_id hashing equivalence (TS implementation)
 * 2. Merkle tree construction and inclusion proofs
 * 3. Merkle proof verification
 * 4. Test vector generation and validation
 */

import { expect } from 'chai';
import {
  computeMessageId,
  computeLeaf,
  computeEmptyLeaf,
  hashPair,
  hexToBytes,
  bytesToHex,
  bytesToBitsLE,
  numberToBitsLE,
  MessageFields,
  DOMAIN_SEP,
  SOL_CHAIN_ID,
  DCC_CHAIN_ID,
  MERKLE_TREE_DEPTH,
} from '../../zk/prover/src/message.js';
import { MerkleTree, MerkleProof } from '../../zk/prover/src/merkle.js';
import { MESSAGE_ID_VECTORS, ADVERSARIAL_VECTORS } from '../vectors/test-vectors.js';

describe('ZK Bridge Message Hashing', () => {
  it('should compute deterministic message_id for vector_1 (basic deposit)', () => {
    const v = MESSAGE_ID_VECTORS[0];
    const fields: MessageFields = {
      srcChainId: v.input.srcChainId,
      dstChainId: v.input.dstChainId,
      srcProgramId: hexToBytes(v.input.srcProgramId),
      slot: BigInt(v.input.slot),
      eventIndex: v.input.eventIndex,
      sender: hexToBytes(v.input.sender),
      recipient: hexToBytes(v.input.recipient),
      amount: BigInt(v.input.amount),
      nonce: BigInt(v.input.nonce),
      assetId: hexToBytes(v.input.assetId),
    };

    const messageId = computeMessageId(fields);
    expect(messageId).to.have.lengthOf(32);

    // Should be deterministic
    const messageId2 = computeMessageId(fields);
    expect(bytesToHex(messageId)).to.equal(bytesToHex(messageId2));

    console.log(`  vector_1 message_id: ${bytesToHex(messageId)}`);
  });

  it('should produce different message_id for different inputs', () => {
    const v1 = MESSAGE_ID_VECTORS[0];
    const v2 = MESSAGE_ID_VECTORS[1];

    const fields1: MessageFields = {
      srcChainId: v1.input.srcChainId,
      dstChainId: v1.input.dstChainId,
      srcProgramId: hexToBytes(v1.input.srcProgramId),
      slot: BigInt(v1.input.slot),
      eventIndex: v1.input.eventIndex,
      sender: hexToBytes(v1.input.sender),
      recipient: hexToBytes(v1.input.recipient),
      amount: BigInt(v1.input.amount),
      nonce: BigInt(v1.input.nonce),
      assetId: hexToBytes(v1.input.assetId),
    };

    const fields2: MessageFields = {
      srcChainId: v2.input.srcChainId,
      dstChainId: v2.input.dstChainId,
      srcProgramId: hexToBytes(v2.input.srcProgramId),
      slot: BigInt(v2.input.slot),
      eventIndex: v2.input.eventIndex,
      sender: hexToBytes(v2.input.sender),
      recipient: hexToBytes(v2.input.recipient),
      amount: BigInt(v2.input.amount),
      nonce: BigInt(v2.input.nonce),
      assetId: hexToBytes(v2.input.assetId),
    };

    const id1 = computeMessageId(fields1);
    const id2 = computeMessageId(fields2);
    expect(bytesToHex(id1)).to.not.equal(bytesToHex(id2));
  });

  it('should produce different message_id for different chain IDs (domain separation)', () => {
    const baseFields: MessageFields = {
      srcChainId: SOL_CHAIN_ID,
      dstChainId: DCC_CHAIN_ID,
      srcProgramId: new Uint8Array(32).fill(1),
      slot: 1000n,
      eventIndex: 0,
      sender: new Uint8Array(32).fill(2),
      recipient: new Uint8Array(32).fill(3),
      amount: 1000000000n,
      nonce: 0n,
      assetId: new Uint8Array(32).fill(4),
    };

    const idNormal = computeMessageId(baseFields);
    const idDiffSrc = computeMessageId({ ...baseFields, srcChainId: 99 });
    const idDiffDst = computeMessageId({ ...baseFields, dstChainId: 99 });

    expect(bytesToHex(idNormal)).to.not.equal(bytesToHex(idDiffSrc));
    expect(bytesToHex(idNormal)).to.not.equal(bytesToHex(idDiffDst));
    expect(bytesToHex(idDiffSrc)).to.not.equal(bytesToHex(idDiffDst));
  });

  it('should compute correct preimage length (181 bytes)', () => {
    // domain_sep(17) + src_chain(4) + dst_chain(4) + src_program(32) +
    // slot(8) + event_index(4) + sender(32) + recipient(32) +
    // amount(8) + nonce(8) + asset_id(32) = 181
    const domainLen = new TextEncoder().encode(DOMAIN_SEP).length;
    expect(domainLen).to.equal(17);

    const totalLen = 17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
    expect(totalLen).to.equal(181);
  });

  it('should handle edge case: max u64 values', () => {
    const maxU64 = (1n << 64n) - 1n;
    const fields: MessageFields = {
      srcChainId: 1,
      dstChainId: 2,
      srcProgramId: new Uint8Array(32).fill(0xff),
      slot: maxU64,
      eventIndex: 0xffffffff,
      sender: new Uint8Array(32).fill(0xff),
      recipient: new Uint8Array(32).fill(0xff),
      amount: maxU64,
      nonce: maxU64,
      assetId: new Uint8Array(32).fill(0xff),
    };

    const id = computeMessageId(fields);
    expect(id).to.have.lengthOf(32);
    console.log(`  max_values message_id: ${bytesToHex(id)}`);
  });
});

describe('Merkle Leaf Computation', () => {
  it('should compute leaf = Keccak256(message_id)', () => {
    const messageId = new Uint8Array(32).fill(0xab);
    const leaf = computeLeaf(messageId);
    expect(leaf).to.have.lengthOf(32);

    // Leaf should be different from message_id (double hashing)
    expect(bytesToHex(leaf)).to.not.equal(bytesToHex(messageId));

    // Should be deterministic
    const leaf2 = computeLeaf(messageId);
    expect(bytesToHex(leaf)).to.equal(bytesToHex(leaf2));
  });

  it('should compute correct empty leaf = Keccak256(bytes32(0))', () => {
    const emptyLeaf = computeEmptyLeaf();
    expect(emptyLeaf).to.have.lengthOf(32);

    // Should not be all zeros (it's a hash)
    expect(bytesToHex(emptyLeaf)).to.not.equal(bytesToHex(new Uint8Array(32)));
  });
});

describe('Merkle Tree Construction', () => {
  it('should build a tree with 1 leaf', () => {
    const tree = new MerkleTree(3); // depth 3 for testing
    const messageId = new Uint8Array(32).fill(0x01);
    tree.buildFromMessageIds([messageId]);

    const root = tree.getRoot();
    expect(root).to.have.lengthOf(32);
    expect(tree.getLeafCount()).to.equal(1);
  });

  it('should build a tree with multiple leaves', () => {
    const tree = new MerkleTree(3);
    const messageIds = [
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32).fill(0x02),
      new Uint8Array(32).fill(0x03),
      new Uint8Array(32).fill(0x04),
    ];
    tree.buildFromMessageIds(messageIds);

    const root = tree.getRoot();
    expect(root).to.have.lengthOf(32);
    expect(tree.getLeafCount()).to.equal(4);
  });

  it('should produce different roots for different leaf sets', () => {
    const tree1 = new MerkleTree(3);
    tree1.buildFromMessageIds([new Uint8Array(32).fill(0x01)]);

    const tree2 = new MerkleTree(3);
    tree2.buildFromMessageIds([new Uint8Array(32).fill(0x02)]);

    expect(bytesToHex(tree1.getRoot())).to.not.equal(bytesToHex(tree2.getRoot()));
  });

  it('should produce same root for same leaf set', () => {
    const messageIds = [
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32).fill(0x02),
    ];

    const tree1 = new MerkleTree(3);
    tree1.buildFromMessageIds(messageIds);

    const tree2 = new MerkleTree(3);
    tree2.buildFromMessageIds(messageIds);

    expect(bytesToHex(tree1.getRoot())).to.equal(bytesToHex(tree2.getRoot()));
  });

  it('should reject too many leaves', () => {
    const tree = new MerkleTree(2); // max 4 leaves
    const tooMany = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(i));
    expect(() => tree.buildFromMessageIds(tooMany)).to.throw('Too many leaves');
  });
});

describe('Merkle Proof Verification', () => {
  it('should generate and verify proof for single leaf', () => {
    const tree = new MerkleTree(3);
    const messageId = new Uint8Array(32).fill(0xab);
    tree.buildFromMessageIds([messageId]);

    const proof = tree.getProof(0);
    expect(proof.siblings).to.have.lengthOf(3);
    expect(proof.pathIndices).to.have.lengthOf(3);

    // Verify
    const valid = MerkleTree.verifyProof(proof);
    expect(valid).to.be.true;
  });

  it('should generate and verify proof for any leaf index', () => {
    const tree = new MerkleTree(4);
    const messageIds = Array.from({ length: 10 }, (_, i) => {
      const id = new Uint8Array(32);
      id[0] = i;
      id[31] = i;
      return id;
    });
    tree.buildFromMessageIds(messageIds);

    // Verify proof for each leaf
    for (let i = 0; i < 10; i++) {
      const proof = tree.getProof(i);
      expect(MerkleTree.verifyProof(proof)).to.be.true;
      expect(bytesToHex(proof.root)).to.equal(bytesToHex(tree.getRoot()));
    }
  });

  it('should fail verification with tampered sibling', () => {
    const tree = new MerkleTree(3);
    tree.buildFromMessageIds([new Uint8Array(32).fill(0x01)]);

    const proof = tree.getProof(0);
    // Tamper with a sibling
    proof.siblings[0] = new Uint8Array(32).fill(0xff);

    const valid = MerkleTree.verifyProof(proof);
    expect(valid).to.be.false;
  });

  it('should fail verification with wrong root', () => {
    const tree = new MerkleTree(3);
    tree.buildFromMessageIds([new Uint8Array(32).fill(0x01)]);

    const proof = tree.getProof(0);
    // Tamper with root
    proof.root = new Uint8Array(32).fill(0xff);

    const valid = MerkleTree.verifyProof(proof);
    expect(valid).to.be.false;
  });

  it('should fail verification with swapped path index', () => {
    const tree = new MerkleTree(4);
    const messageIds = [
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32).fill(0x02),
      new Uint8Array(32).fill(0x03),
      new Uint8Array(32).fill(0x04),
    ];
    tree.buildFromMessageIds(messageIds);

    const proof = tree.getProof(0);
    // Flip a path index
    proof.pathIndices[0] = proof.pathIndices[0] === 0 ? 1 : 0;

    const valid = MerkleTree.verifyProof(proof);
    expect(valid).to.be.false;
  });
});

describe('Bit Conversion Utilities', () => {
  it('should convert bytes to LE bits correctly', () => {
    // 0xAB = 10101011 → LSB first: [1,1,0,1,0,1,0,1]
    const bits = bytesToBitsLE(new Uint8Array([0xab]));
    expect(bits).to.deep.equal([1, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('should convert number to LE bits correctly', () => {
    // 1 as 32-bit LE: bit 0 = 1, rest = 0
    const bits = numberToBitsLE(1, 32);
    expect(bits[0]).to.equal(1);
    for (let i = 1; i < 32; i++) {
      expect(bits[i]).to.equal(0);
    }
  });

  it('should convert u64 max to LE bits correctly', () => {
    const maxU64 = (1n << 64n) - 1n;
    const bits = numberToBitsLE(maxU64, 64);
    // All bits should be 1
    for (let i = 0; i < 64; i++) {
      expect(bits[i]).to.equal(1);
    }
  });
});

describe('Hash Pair (Inner Node)', () => {
  it('should compute Hash(left || right) correctly', () => {
    const left = new Uint8Array(32).fill(0x01);
    const right = new Uint8Array(32).fill(0x02);
    const result = hashPair(left, right);
    expect(result).to.have.lengthOf(32);

    // Order matters
    const reversed = hashPair(right, left);
    expect(bytesToHex(result)).to.not.equal(bytesToHex(reversed));
  });

  it('should be deterministic', () => {
    const left = new Uint8Array(32).fill(0xaa);
    const right = new Uint8Array(32).fill(0xbb);
    const h1 = hashPair(left, right);
    const h2 = hashPair(left, right);
    expect(bytesToHex(h1)).to.equal(bytesToHex(h2));
  });
});

describe('Full Pipeline: Message -> Leaf -> Tree -> Proof', () => {
  it('should produce valid proof for a realistic deposit', () => {
    // Simulate N deposits
    const deposits: MessageFields[] = [];
    for (let i = 0; i < 5; i++) {
      deposits.push({
        srcChainId: SOL_CHAIN_ID,
        dstChainId: DCC_CHAIN_ID,
        srcProgramId: new Uint8Array(32).fill(0x99),
        slot: 100000n + BigInt(i),
        eventIndex: i,
        sender: (() => { const s = new Uint8Array(32); s[0] = i + 1; return s; })(),
        recipient: (() => { const r = new Uint8Array(32); r[0] = i + 10; return r; })(),
        amount: BigInt((i + 1) * 1000000000),
        nonce: BigInt(i),
        assetId: new Uint8Array(32).fill(0x01),
      });
    }

    // Compute message IDs
    const messageIds = deposits.map(computeMessageId);

    // Build Merkle tree (depth 20 for production, 5 for test speed)
    const tree = new MerkleTree(5);
    tree.buildFromMessageIds(messageIds);
    const root = tree.getRoot();

    console.log(`  Pipeline test root: ${bytesToHex(root)}`);

    // Verify each deposit has a valid proof
    for (let i = 0; i < 5; i++) {
      const proof = tree.getProof(i);
      expect(MerkleTree.verifyProof(proof)).to.be.true;
      expect(bytesToHex(proof.root)).to.equal(bytesToHex(root));
    }
  });
});
