/**
 * DCC <-> Solana ZK Bridge — Test Vectors
 *
 * Canonical test vectors for message_id computation, Merkle inclusion,
 * and cross-implementation verification.
 *
 * These vectors MUST produce identical results in:
 *   - TypeScript (zk/prover/src/message.ts)
 *   - Rust (programs/sol-bridge-lock/src/instructions/deposit.rs)
 *   - RIDE (dcc/contracts/bridge/zk_bridge.ride)
 *   - Circom (zk/circuits/bridge_deposit.circom)
 */

export interface TestVector {
  name: string;
  description: string;
  input: {
    domainSep: string;
    srcChainId: number;
    dstChainId: number;
    srcProgramId: string;  // hex
    slot: string;          // bigint as string
    eventIndex: number;
    sender: string;        // hex
    recipient: string;     // hex
    amount: string;        // bigint as string
    nonce: string;         // bigint as string
    assetId: string;       // hex
  };
  expected: {
    messageId: string;     // hex
    leaf: string;          // hex (Keccak256(messageId))
  };
}

export interface MerkleTestVector {
  name: string;
  description: string;
  leaves: string[];          // hex message IDs
  expectedRoot: string;      // hex
  proofIndex: number;
  expectedSiblings: string[]; // hex
  expectedPathIndices: number[];
}

/**
 * Message ID test vectors
 */
export const MESSAGE_ID_VECTORS: TestVector[] = [
  {
    name: "vector_1_basic_deposit",
    description: "Basic SOL deposit: 1 SOL, first nonce, slot 1000",
    input: {
      domainSep: "DCC_SOL_BRIDGE_V1",
      srcChainId: 1,
      dstChainId: 2,
      // Bridge program ID: 9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF
      srcProgramId: "82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302",
      slot: "1000",
      eventIndex: 0,
      // Sender: 11111111111111111111111111111111 (base58 system program)
      sender: "0000000000000000000000000000000000000000000000000000000000000000",
      // Recipient: 32 bytes of 0x01 repeated
      recipient: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "1000000000", // 1 SOL in lamports
      nonce: "0",
      // Native SOL asset: So11111111111111111111111111111111111111112
      assetId: "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    },
    expected: {
      // These will be computed and filled in by the test runner
      messageId: "",
      leaf: "",
    },
  },
  {
    name: "vector_2_large_deposit",
    description: "Large SOL deposit: 10 SOL, nonce 42, slot 500000",
    input: {
      domainSep: "DCC_SOL_BRIDGE_V1",
      srcChainId: 1,
      dstChainId: 2,
      srcProgramId: "82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302",
      slot: "500000",
      eventIndex: 5,
      sender: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      recipient: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amount: "10000000000", // 10 SOL
      nonce: "42",
      assetId: "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    },
    expected: {
      messageId: "",
      leaf: "",
    },
  },
  {
    name: "vector_3_max_values",
    description: "Edge case: maximum u64 amount, large slot and nonce",
    input: {
      domainSep: "DCC_SOL_BRIDGE_V1",
      srcChainId: 1,
      dstChainId: 2,
      srcProgramId: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      slot: "18446744073709551615",  // u64 max
      eventIndex: 4294967295,        // u32 max
      sender: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      recipient: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      amount: "18446744073709551615",
      nonce: "18446744073709551615",
      assetId: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    expected: {
      messageId: "",
      leaf: "",
    },
  },
  {
    name: "vector_4_different_chain_ids",
    description: "Test domain separation: different chain IDs produce different message_id",
    input: {
      domainSep: "DCC_SOL_BRIDGE_V1",
      srcChainId: 99,
      dstChainId: 100,
      srcProgramId: "0000000000000000000000000000000000000000000000000000000000000001",
      slot: "1",
      eventIndex: 0,
      sender: "0000000000000000000000000000000000000000000000000000000000000001",
      recipient: "0000000000000000000000000000000000000000000000000000000000000002",
      amount: "1",
      nonce: "0",
      assetId: "0000000000000000000000000000000000000000000000000000000000000001",
    },
    expected: {
      messageId: "",
      leaf: "",
    },
  },
];

/**
 * Adversarial test vectors — these MUST fail verification
 */
export interface AdversarialVector {
  name: string;
  description: string;
  attack: string;
  shouldFail: boolean;
  mutation: string; // Description of what's mutated
}

export const ADVERSARIAL_VECTORS: AdversarialVector[] = [
  {
    name: "wrong_checkpoint_root",
    description: "Proof generated with one checkpoint root but submitted with a different one",
    attack: "Replace checkpoint_root in public inputs with a different value",
    shouldFail: true,
    mutation: "checkpoint_root XOR 0x01 (flip first bit)",
  },
  {
    name: "wrong_chain_id",
    description: "Attempt to replay a proof on a different chain",
    attack: "Change src_chain_id from 1 (Solana) to 99",
    shouldFail: true,
    mutation: "src_chain_id = 99 (must be 1 for Solana)",
  },
  {
    name: "wrong_program_id",
    description: "Proof claims a different source program",
    attack: "Change src_program_id to a different value",
    shouldFail: true,
    mutation: "src_program_id changed to all-zeros",
  },
  {
    name: "replay_proof",
    description: "Submit the same valid proof twice",
    attack: "Second submission should fail because message_id is in processed set",
    shouldFail: true,
    mutation: "No mutation — exact same proof and inputs",
  },
  {
    name: "mutated_amount",
    description: "Keep valid proof but change claimed amount",
    attack: "Change amount in public inputs while keeping the proof",
    shouldFail: true,
    mutation: "amount doubled in public inputs",
  },
  {
    name: "mutated_recipient",
    description: "Keep valid proof but change claimed recipient",
    attack: "Change recipient in public inputs while keeping the proof",
    shouldFail: true,
    mutation: "recipient changed to attacker address",
  },
  {
    name: "expired_checkpoint",
    description: "Use a checkpoint that has been expired/deactivated",
    attack: "Submit proof referencing an expired checkpoint",
    shouldFail: true,
    mutation: "Checkpoint deactivated after proof generation",
  },
  {
    name: "zero_root_checkpoint",
    description: "Attempt to register a checkpoint with all-zero root",
    attack: "Zero root could allow trivial Merkle inclusion",
    shouldFail: true,
    mutation: "commitment_root = bytes32(0)",
  },
];
