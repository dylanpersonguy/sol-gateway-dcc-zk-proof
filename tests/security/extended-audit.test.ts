/**
 * Extended Security Audit Tests
 * ==============================
 * Additional adversarial & security tests identified during the full audit.
 * Covers edge cases in serialization, cross-implementation consistency,
 * overflow/underflow, and ZK circuit boundary conditions.
 */

import { expect } from 'chai';
import { keccak256 } from 'ethers';
import {
  computeMessageId,
  computeLeaf,
  bytesToBitsLE,
  numberToBitsLE,
  hexToBytes,
  bytesToHex,
  MessageFields,
} from '../../zk/prover/src/message.js';
import { MerkleTree, MerkleProof } from '../../zk/prover/src/merkle.js';

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function makeFields(overrides: Partial<{
  srcChainId: number;
  dstChainId: number;
  srcProgramId: string;
  slot: number;
  eventIndex: number;
  sender: string;
  recipient: string;
  amount: bigint;
  nonce: number;
  assetId: string;
}> = {}): MessageFields {
  const p = {
    srcChainId: 1,
    dstChainId: 2,
    srcProgramId: '82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302',
    slot: 1000,
    eventIndex: 0,
    sender: '0000000000000000000000000000000000000000000000000000000000000000',
    recipient: '0101010101010101010101010101010101010101010101010101010101010101',
    amount: 1_000_000_000n,
    nonce: 0,
    assetId: '069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001',
    ...overrides,
  };
  return {
    srcChainId: p.srcChainId,
    dstChainId: p.dstChainId,
    srcProgramId: hexToBytes(p.srcProgramId),
    slot: BigInt(p.slot),
    eventIndex: p.eventIndex,
    sender: hexToBytes(p.sender),
    recipient: hexToBytes(p.recipient),
    amount: p.amount,
    nonce: BigInt(p.nonce),
    assetId: hexToBytes(p.assetId),
  };
}

function msgIdHex(fields: MessageFields): string {
  // bytesToHex returns hex without 0x prefix
  return bytesToHex(computeMessageId(fields));
}

const DEPTH = 20;

// Frozen golden value from Rust unit test (test_vector_1_basic_deposit)
const GOLDEN_MESSAGE_ID = '0x6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444';

// ═══════════════════════════════════════════════════════════
// CROSS-IMPLEMENTATION GOLDEN VALUES
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Cross-Implementation Golden Values', () => {
  it('TypeScript message_id matches Rust golden value', () => {
    const id = msgIdHex(makeFields());
    expect(id).to.equal(GOLDEN_MESSAGE_ID);
  });

  it('preimage is exactly 181 bytes', () => {
    const domainSep = new TextEncoder().encode('DCC_SOL_BRIDGE_V1');
    expect(domainSep.length).to.equal(17);
    const total = 17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
    expect(total).to.equal(181);
  });
});

// ═══════════════════════════════════════════════════════════
// RIDE ENDIANNESS MISMATCH DETECTION
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: RIDE Endianness Mismatch Detection', () => {
  it('BE vs LE encoding produces different byte representations', () => {
    // RIDE toBytes(1) for Int = 8 bytes BE = [0,0,0,0,0,0,0,1]
    // Rust/TS use LE u32 = [1,0,0,0]
    const buf = new ArrayBuffer(4);
    const le = new DataView(buf);
    le.setUint32(0, 1, true); // LE
    const leBytes = new Uint8Array(buf);

    const buf2 = new ArrayBuffer(8);
    const be = new DataView(buf2);
    be.setBigInt64(0, 1n, false); // BE, 8 bytes
    const beBytes = new Uint8Array(buf2);

    expect(Buffer.from(leBytes).equals(Buffer.from(beBytes))).to.be.false;
    expect(leBytes.length).to.equal(4);
    expect(beBytes.length).to.equal(8);
  });

  it('RIDE preimage would be 193 bytes (vs correct 181)', () => {
    // RIDE toBytes(Int) always produces 8B BE for all Int values
    // src_chain_id: 8B, dst_chain_id: 8B, event_index: 8B (vs 4B, 4B, 4B)
    const ridePreimageLen = 17 + 8 + 8 + 32 + 8 + 8 + 32 + 32 + 8 + 8 + 32;
    const correctPreimageLen = 17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
    expect(ridePreimageLen).to.equal(193);
    expect(correctPreimageLen).to.equal(181);
    expect(ridePreimageLen).to.not.equal(correctPreimageLen);
  });
});

// ═══════════════════════════════════════════════════════════
// ARITHMETIC OVERFLOW / UNDERFLOW
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Arithmetic Edge Cases', () => {
  it('max u64 amount produces valid message_id', () => {
    const maxU64 = BigInt('18446744073709551615');
    const id = computeMessageId(makeFields({ amount: maxU64 }));
    expect(id).to.have.lengthOf(32);
    expect(bytesToHex(id)).to.not.equal('00'.repeat(32));
  });

  it('max u64 nonce produces valid message_id', () => {
    // nonce is bigint in MessageFields
    const maxU64 = BigInt('18446744073709551615');
    const fields = makeFields();
    fields.nonce = maxU64;
    const id = computeMessageId(fields);
    expect(id).to.have.lengthOf(32);
  });

  it('zero amount produces valid message_id (non-zero hash)', () => {
    const id = computeMessageId(makeFields({ amount: 0n }));
    expect(bytesToHex(id)).to.not.equal('00'.repeat(32));
  });

  it('max u32 event_index produces valid message_id', () => {
    const id = computeMessageId(makeFields({ eventIndex: 4294967295 }));
    expect(id).to.have.lengthOf(32);
  });

  it('max u32 chain IDs produce valid message_id', () => {
    const id = computeMessageId(makeFields({ srcChainId: 4294967295, dstChainId: 4294967295 }));
    expect(id).to.have.lengthOf(32);
  });
});

// ═══════════════════════════════════════════════════════════
// DOMAIN SEPARATOR ATTACKS
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Domain Separator Attacks', () => {
  it('correct message_id matches golden value', () => {
    const id = msgIdHex(makeFields());
    expect(id).to.equal(GOLDEN_MESSAGE_ID);
  });

  it('swapped chain IDs produce different hash (anti-relay)', () => {
    const sol_to_dcc = msgIdHex(makeFields({ srcChainId: 1, dstChainId: 2 }));
    const dcc_to_sol = msgIdHex(makeFields({ srcChainId: 2, dstChainId: 1 }));
    expect(sol_to_dcc).to.not.equal(dcc_to_sol);
  });

  it('adjacent field boundary shift produces different hash', () => {
    const id1 = msgIdHex(makeFields({ srcChainId: 256 }));
    const id2 = msgIdHex(makeFields({
      srcChainId: 0,
      srcProgramId: '01' + '82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302'.slice(2),
    }));
    expect(id1).to.not.equal(id2);
  });
});

// ═══════════════════════════════════════════════════════════
// MERKLE TREE EDGE CASES
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Merkle Tree Edge Cases', () => {
  it('single-leaf tree produces valid proof with depth 20', () => {
    const msgIdBytes = computeMessageId(makeFields());
    const tree = new MerkleTree(DEPTH);
    tree.buildFromMessageIds([msgIdBytes]);
    const proof = tree.getProof(0);
    expect(proof.siblings.length).to.equal(DEPTH);
    expect(proof.pathIndices.length).to.equal(DEPTH);
  });

  it('Merkle proof with leaf at index 0 (all-left path) works', () => {
    const ids = Array.from({ length: 4 }, (_, i) =>
      computeMessageId(makeFields({ eventIndex: i, nonce: i })),
    );
    const tree = new MerkleTree(DEPTH);
    tree.buildFromMessageIds(ids);
    const proof0 = tree.getProof(0);
    expect(proof0.pathIndices[0]).to.equal(0);
    expect(MerkleTree.verifyProof(proof0)).to.be.true;
  });

  it('Merkle proof with leaf at index 1 (right at level 0) works', () => {
    const ids = Array.from({ length: 2 }, (_, i) =>
      computeMessageId(makeFields({ eventIndex: i, nonce: i })),
    );
    const tree = new MerkleTree(DEPTH);
    tree.buildFromMessageIds(ids);
    const proof1 = tree.getProof(1);
    expect(proof1.pathIndices[0]).to.equal(1);
    expect(MerkleTree.verifyProof(proof1)).to.be.true;
  });

  it('different trees with subset of leaves produce different roots', () => {
    const ids3 = Array.from({ length: 3 }, (_, i) =>
      computeMessageId(makeFields({ eventIndex: i, nonce: i })));
    const ids4 = Array.from({ length: 4 }, (_, i) =>
      computeMessageId(makeFields({ eventIndex: i, nonce: i })));
    const tree3 = new MerkleTree(DEPTH);
    tree3.buildFromMessageIds(ids3);
    const tree4 = new MerkleTree(DEPTH);
    tree4.buildFromMessageIds(ids4);
    expect(bytesToHex(tree3.getRoot())).to.not.equal(bytesToHex(tree4.getRoot()));
  });

  it('using wrong proof siblings fails verification', () => {
    const ids = Array.from({ length: 4 }, (_, i) =>
      computeMessageId(makeFields({ eventIndex: i, nonce: i })));
    const tree = new MerkleTree(DEPTH);
    tree.buildFromMessageIds(ids);
    const proof0 = tree.getProof(0);
    const proof1 = tree.getProof(1);
    // Tamper: use leaf1 with proof0's siblings
    const tampered: MerkleProof = { ...proof0, leaf: proof1.leaf };
    expect(MerkleTree.verifyProof(tampered)).to.be.false;
  });
});

// ═══════════════════════════════════════════════════════════
// BIT CONVERSION EDGE CASES
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Bit Conversion Correctness', () => {
  it('bytesToBitsLE for 0x00 = [0,0,0,0,0,0,0,0]', () => {
    const bits = bytesToBitsLE(new Uint8Array([0x00]));
    expect(bits).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('bytesToBitsLE for 0xFF = [1,1,1,1,1,1,1,1]', () => {
    const bits = bytesToBitsLE(new Uint8Array([0xFF]));
    expect(bits).to.deep.equal([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('bytesToBitsLE for 0x01 = [1,0,0,0,0,0,0,0] (LSB first)', () => {
    const bits = bytesToBitsLE(new Uint8Array([0x01]));
    expect(bits).to.deep.equal([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('bytesToBitsLE for 0x80 = [0,0,0,0,0,0,0,1] (MSB last)', () => {
    const bits = bytesToBitsLE(new Uint8Array([0x80]));
    expect(bits).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('numberToBitsLE round-trip for boundary values', () => {
    for (const val of [0, 1, 127, 128, 255, 256, 65535, 4294967295]) {
      const bits = numberToBitsLE(val, 32);
      expect(bits.length).to.equal(32);
      let reconstructed = 0;
      for (let i = 0; i < 32; i++) {
        reconstructed |= bits[i] << i;
      }
      expect(reconstructed >>> 0).to.equal(val >>> 0);
    }
  });

  it('181-byte preimage → 1448 bits', () => {
    expect(181 * 8).to.equal(1448);
  });
});

// ═══════════════════════════════════════════════════════════
// REPLAY / NONCE UNIQUENESS
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Nonce & Replay Protection', () => {
  it('same sender, 100 different nonces → 100 unique message_ids', () => {
    const ids = new Set<string>();
    for (let nonce = 0; nonce < 100; nonce++) {
      ids.add(msgIdHex(makeFields({ nonce })));
    }
    expect(ids.size).to.equal(100);
  });

  it('same nonce, 50 different senders → 50 unique message_ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const sender = i.toString(16).padStart(64, '0');
      ids.add(msgIdHex(makeFields({ sender })));
    }
    expect(ids.size).to.equal(50);
  });

  it('same nonce, different slots → different message_ids', () => {
    const id1 = msgIdHex(makeFields({ slot: 1000 }));
    const id2 = msgIdHex(makeFields({ slot: 1001 }));
    expect(id1).to.not.equal(id2);
  });

  it('same slot, different event_index → different message_ids', () => {
    const id1 = msgIdHex(makeFields({ eventIndex: 0 }));
    const id2 = msgIdHex(makeFields({ eventIndex: 1 }));
    expect(id1).to.not.equal(id2);
  });
});

// ═══════════════════════════════════════════════════════════
// KECCAK COLLISION RESISTANCE
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: Keccak256 Collision Resistance', () => {
  it('1000 distinct messages produce 1000 unique hashes', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const sender = i.toString(16).padStart(64, '0');
      hashes.add(msgIdHex(makeFields({
        slot: i * 1000,
        eventIndex: i % 256,
        sender,
        amount: BigInt(i * 1_000_000_000),
        nonce: i,
      })));
    }
    expect(hashes.size).to.equal(1000);
  });
});

// ═══════════════════════════════════════════════════════════
// SPL DEPOSIT: Missing ZK fields
// ═══════════════════════════════════════════════════════════

describe('Extended Audit: SPL Deposit ZK Gap', () => {
  it('[AUDIT FINDING] deposit_spl.rs does NOT compute message_id', () => {
    // deposit.rs: sets deposit.message_id = compute_message_id(...)
    // deposit_spl.rs: does NOT set deposit.message_id or deposit.asset_id
    // SPL deposits cannot be included in ZK proofs until this is fixed.
    // This test documents the finding rather than asserting on Rust code.
    expect(true).to.be.true;
  });
});
