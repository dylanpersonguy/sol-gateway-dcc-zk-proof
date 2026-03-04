pragma circom 2.1.0;

include "keccak256.circom";
include "merkle_tree.circom";

/**
 * DCC <-> Solana ZK Bridge — Deposit Inclusion Circuit (Groth16)
 *
 * FIX: ZK-H2/ATK-1 — Redesigned for exactly 8 field-element public inputs
 * to match RIDE's groth16Verify_8inputs built-in.
 *
 * Proves:
 * 1. message_id = Keccak256(domain_sep || src_chain_id || dst_chain_id ||
 *    src_program_id || slot || event_index || sender || recipient || amount || nonce || asset_id)
 * 2. leaf = Keccak256(0x00 || message_id)   [domain-separated leaf hash]
 * 3. MerkleInclusion(leaf, path, siblings) == checkpoint_root
 *
 * Public Inputs (8 field elements for groth16Verify_8inputs):
 *   [0] checkpoint_root_lo  — lower 128 bits of Merkle root
 *   [1] checkpoint_root_hi  — upper 128 bits of Merkle root
 *   [2] message_id_lo       — lower 128 bits of message_id
 *   [3] message_id_hi       — upper 128 bits of message_id
 *   [4] amount              — transfer amount (64-bit, fits in field element)
 *   [5] recipient_lo        — lower 128 bits of DCC recipient address
 *   [6] recipient_hi        — upper 128 bits of DCC recipient address
 *   [7] version             — bridge protocol version (32-bit)
 *
 * Note: src_chain_id, dst_chain_id, and asset_id are PRIVATE inputs.
 * They are cryptographically bound through the message_id hash:
 *   message_id = Keccak256(... || src_chain_id || dst_chain_id || ... || asset_id)
 * Altering any private field changes message_id, which is public.
 *
 * Private Inputs:
 *   - domain_sep (17 bytes = 136 bits)
 *   - src_program_id (256 bits)
 *   - slot (64 bits)
 *   - event_index (32 bits)
 *   - sender (256 bits)
 *   - nonce (64 bits)
 *   - asset_id (256 bits) — bound via message_id hash
 *   - src_chain_id (32 bits) — bound via message_id hash
 *   - dst_chain_id (32 bits) — bound via message_id hash
 *   - merkle_siblings[TREE_DEPTH] (each 256 bits)
 *   - merkle_path_indices[TREE_DEPTH] (each 1 bit)
 */

/**
 * Decompose a field element into N bits (little-endian).
 * Constrains: each bit is binary AND sum(bit_i * 2^i) == in.
 *
 * Used to convert field-element public inputs into bit arrays for Keccak.
 * Binary constraints are built-in (no separate step needed for public inputs).
 */
template Num2Bits(N) {
    signal input in;
    signal output out[N];

    var lc = 0;
    for (var i = 0; i < N; i++) {
        out[i] <-- (in >> i) & 1;
        out[i] * (1 - out[i]) === 0;
        lc += out[i] * (1 << i);
    }
    lc === in;
}

template BridgeDepositInclusion(TREE_DEPTH) {
    // ═══════════════════════════════════════════════════════════
    // PUBLIC INPUTS — 8 field elements for groth16Verify_8inputs
    // ═══════════════════════════════════════════════════════════
    signal input checkpoint_root_lo;   // lower 128 bits of Merkle root
    signal input checkpoint_root_hi;   // upper 128 bits of Merkle root
    signal input message_id_lo;        // lower 128 bits of message_id
    signal input message_id_hi;        // upper 128 bits of message_id
    signal input amount;               // transfer amount (64-bit value)
    signal input recipient_lo;         // lower 128 bits of recipient
    signal input recipient_hi;         // upper 128 bits of recipient
    signal input version;              // bridge version (32-bit value)

    // ═══════════════════════════════════════════════════════════
    // PRIVATE INPUTS
    // ═══════════════════════════════════════════════════════════
    signal input domain_sep[136];       // "DCC_SOL_BRIDGE_V1" (17 bytes)
    signal input src_program_id[256];   // Bridge program ID
    signal input slot_bits[64];         // Solana slot (LE bits)
    signal input event_index_bits[32];  // Event index (LE bits)
    signal input sender[256];           // Sender Solana pubkey
    signal input nonce_bits[64];        // Nonce (LE bits)
    signal input asset_id[256];         // Asset identifier (private, bound via hash)
    signal input src_chain_id[32];      // Source chain ID (private, bound via hash)
    signal input dst_chain_id[32];      // Destination chain ID (private, bound via hash)
    signal input siblings[TREE_DEPTH][256];     // Merkle siblings
    signal input path_indices[TREE_DEPTH];       // Merkle path (0 = left, 1 = right)

    // ═══════════════════════════════════════════════════════════
    // STEP 0: Decompose field-element public inputs into bits
    //
    // Each 256-bit hash is split into two 128-bit field elements
    // (128-bit values always fit in BN128 scalar field).
    // Num2Bits also enforces binary constraints on each bit.
    // ═══════════════════════════════════════════════════════════

    // Checkpoint root: 256 bits = lo(128) + hi(128)
    component root_lo_decomp = Num2Bits(128);
    root_lo_decomp.in <== checkpoint_root_lo;
    component root_hi_decomp = Num2Bits(128);
    root_hi_decomp.in <== checkpoint_root_hi;

    signal checkpoint_root_bits[256];
    for (var i = 0; i < 128; i++) {
        checkpoint_root_bits[i] <== root_lo_decomp.out[i];
        checkpoint_root_bits[128 + i] <== root_hi_decomp.out[i];
    }

    // Message ID: 256 bits = lo(128) + hi(128)
    component msgid_lo_decomp = Num2Bits(128);
    msgid_lo_decomp.in <== message_id_lo;
    component msgid_hi_decomp = Num2Bits(128);
    msgid_hi_decomp.in <== message_id_hi;

    signal message_id_bits[256];
    for (var i = 0; i < 128; i++) {
        message_id_bits[i] <== msgid_lo_decomp.out[i];
        message_id_bits[128 + i] <== msgid_hi_decomp.out[i];
    }

    // Amount: 64 bits
    component amount_decomp = Num2Bits(64);
    amount_decomp.in <== amount;
    signal amount_bits[64];
    for (var i = 0; i < 64; i++) {
        amount_bits[i] <== amount_decomp.out[i];
    }

    // Recipient: 256 bits = lo(128) + hi(128)
    component recip_lo_decomp = Num2Bits(128);
    recip_lo_decomp.in <== recipient_lo;
    component recip_hi_decomp = Num2Bits(128);
    recip_hi_decomp.in <== recipient_hi;

    signal recipient_bits[256];
    for (var i = 0; i < 128; i++) {
        recipient_bits[i] <== recip_lo_decomp.out[i];
        recipient_bits[128 + i] <== recip_hi_decomp.out[i];
    }

    // Version: 32 bits
    component version_decomp = Num2Bits(32);
    version_decomp.in <== version;

    // ═══════════════════════════════════════════════════════════
    // STEP 1: Compute message_id = Keccak256(preimage)
    // Preimage: domain_sep(136) || src_chain_id(32) || dst_chain_id(32) ||
    //           src_program_id(256) || slot(64) || event_index(32) ||
    //           sender(256) || recipient(256) || amount(64) || nonce(64) || asset_id(256)
    // Total: 1448 bits = 181 bytes
    // ═══════════════════════════════════════════════════════════
    
    var PREIMAGE_BITS = 1448;
    signal preimage[PREIMAGE_BITS];
    
    var idx = 0;
    
    // domain_sep (136 bits)
    for (var i = 0; i < 136; i++) {
        preimage[idx] <== domain_sep[i];
        idx++;
    }
    
    // src_chain_id (32 bits) — private, bound via message_id hash
    for (var i = 0; i < 32; i++) {
        preimage[idx] <== src_chain_id[i];
        idx++;
    }
    
    // dst_chain_id (32 bits) — private, bound via message_id hash
    for (var i = 0; i < 32; i++) {
        preimage[idx] <== dst_chain_id[i];
        idx++;
    }
    
    // src_program_id (256 bits)
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== src_program_id[i];
        idx++;
    }
    
    // slot (64 bits)
    for (var i = 0; i < 64; i++) {
        preimage[idx] <== slot_bits[i];
        idx++;
    }
    
    // event_index (32 bits)
    for (var i = 0; i < 32; i++) {
        preimage[idx] <== event_index_bits[i];
        idx++;
    }
    
    // sender (256 bits)
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== sender[i];
        idx++;
    }
    
    // recipient (256 bits) — from decomposed public input
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== recipient_bits[i];
        idx++;
    }
    
    // amount (64 bits) — from decomposed public input
    for (var i = 0; i < 64; i++) {
        preimage[idx] <== amount_bits[i];
        idx++;
    }
    
    // nonce (64 bits)
    for (var i = 0; i < 64; i++) {
        preimage[idx] <== nonce_bits[i];
        idx++;
    }
    
    // asset_id (256 bits) — private, bound via message_id hash
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== asset_id[i];
        idx++;
    }

    // Compute Keccak256(preimage) for message_id
    component msg_hasher = Keccak256Bits(PREIMAGE_BITS);
    for (var i = 0; i < PREIMAGE_BITS; i++) {
        msg_hasher.in[i] <== preimage[i];
    }

    // Verify computed message_id matches public input (bit-by-bit)
    for (var i = 0; i < 256; i++) {
        msg_hasher.out[i] === message_id_bits[i];
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Compute leaf = Keccak256(0x00 || message_id)
    // FIX: ZK-M3 — Domain-separated leaf hash (RFC 6962 §2.1)
    // 0x00 prefix = 8 zero bits distinguishes leaves from internal nodes
    // ═══════════════════════════════════════════════════════════
    component leaf_hasher = Keccak256Bits(264);  // 8 + 256 = 264 bits
    // 0x00 prefix (8 zero bits)
    for (var i = 0; i < 8; i++) {
        leaf_hasher.in[i] <== 0;
    }
    for (var i = 0; i < 256; i++) {
        leaf_hasher.in[8 + i] <== message_id_bits[i];
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Verify Merkle inclusion
    // MerkleRoot(leaf, siblings, path_indices) == checkpoint_root
    // ═══════════════════════════════════════════════════════════
    component merkle = MerkleProofVerifier(TREE_DEPTH);
    
    for (var i = 0; i < 256; i++) {
        merkle.leaf[i] <== leaf_hasher.out[i];
    }
    
    for (var i = 0; i < TREE_DEPTH; i++) {
        for (var j = 0; j < 256; j++) {
            merkle.siblings[i][j] <== siblings[i][j];
        }
        merkle.path_indices[i] <== path_indices[i];
    }

    // Verify computed root matches checkpoint_root
    for (var i = 0; i < 256; i++) {
        merkle.root[i] === checkpoint_root_bits[i];
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Binary constraints on all PRIVATE bit-level inputs
    //
    // Public inputs get binary constraints from Num2Bits decomposition.
    // Private bit-array inputs need explicit binary constraints.
    // ═══════════════════════════════════════════════════════════
    for (var i = 0; i < TREE_DEPTH; i++) {
        path_indices[i] * (1 - path_indices[i]) === 0;
    }

    for (var i = 0; i < 136; i++) {
        domain_sep[i] * (1 - domain_sep[i]) === 0;
    }
    for (var i = 0; i < 256; i++) {
        src_program_id[i] * (1 - src_program_id[i]) === 0;
        sender[i] * (1 - sender[i]) === 0;
        asset_id[i] * (1 - asset_id[i]) === 0;
    }
    for (var i = 0; i < 64; i++) {
        slot_bits[i] * (1 - slot_bits[i]) === 0;
        nonce_bits[i] * (1 - nonce_bits[i]) === 0;
    }
    for (var i = 0; i < 32; i++) {
        event_index_bits[i] * (1 - event_index_bits[i]) === 0;
        src_chain_id[i] * (1 - src_chain_id[i]) === 0;
        dst_chain_id[i] * (1 - dst_chain_id[i]) === 0;
    }
    for (var i = 0; i < TREE_DEPTH; i++) {
        for (var j = 0; j < 256; j++) {
            siblings[i][j] * (1 - siblings[i][j]) === 0;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Version must be 1 (field element check)
    // ═══════════════════════════════════════════════════════════
    version === 1;
}

// Main component — Merkle tree depth 20 (1M events per checkpoint)
// Exactly 8 public field elements for groth16Verify_8inputs
component main {public [
    checkpoint_root_lo,
    checkpoint_root_hi,
    message_id_lo,
    message_id_hi,
    amount,
    recipient_lo,
    recipient_hi,
    version
]} = BridgeDepositInclusion(20);
