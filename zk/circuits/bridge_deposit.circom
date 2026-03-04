pragma circom 2.1.0;

include "keccak256.circom";
include "merkle_tree.circom";

/**
 * DCC <-> Solana ZK Bridge — Deposit Inclusion Circuit (Groth16)
 *
 * Proves:
 * 1. message_id = Keccak256(domain_sep || src_chain_id || dst_chain_id || 
 *    src_program_id || slot || event_index || sender || recipient || amount || nonce || asset_id)
 * 2. leaf = Keccak256(message_id)
 * 3. MerkleInclusion(leaf, path, siblings) == checkpoint_root
 *
 * Public Inputs:
 *   - checkpoint_root (256 bits)
 *   - message_id (256 bits)
 *   - amount (64 bits)
 *   - recipient (256 bits)
 *   - asset_id (256 bits)
 *   - src_chain_id (32 bits)
 *   - dst_chain_id (32 bits)
 *   - version (32 bits)
 *
 * Private Inputs:
 *   - domain_sep (17 bytes = 136 bits)
 *   - src_program_id (256 bits)
 *   - slot (64 bits)
 *   - event_index (32 bits)
 *   - sender (256 bits)
 *   - nonce (64 bits)
 *   - merkle_siblings[TREE_DEPTH] (each 256 bits)
 *   - merkle_path_indices[TREE_DEPTH] (each 1 bit)
 */

template BridgeDepositInclusion(TREE_DEPTH) {
    // ═══════════════════════════════════════════════════════════
    // PUBLIC INPUTS
    // ═══════════════════════════════════════════════════════════
    signal input checkpoint_root[256];  // Merkle root from checkpoint
    signal input message_id[256];       // Expected message ID
    signal input amount_bits[64];       // Transfer amount in LE bits
    signal input recipient[256];        // DCC recipient address
    signal input asset_id[256];         // Asset identifier
    signal input src_chain_id[32];      // Source chain ID (LE bits)
    signal input dst_chain_id[32];      // Destination chain ID (LE bits)
    signal input version[32];           // Bridge version (LE bits)

    // ═══════════════════════════════════════════════════════════
    // PRIVATE INPUTS
    // ═══════════════════════════════════════════════════════════
    signal input domain_sep[136];       // "DCC_SOL_BRIDGE_V1" (17 bytes)
    signal input src_program_id[256];   // Bridge program ID
    signal input slot_bits[64];         // Solana slot (LE bits)
    signal input event_index_bits[32];  // Event index (LE bits)
    signal input sender[256];           // Sender Solana pubkey
    signal input nonce_bits[64];        // Nonce (LE bits)
    signal input siblings[TREE_DEPTH][256];     // Merkle siblings
    signal input path_indices[TREE_DEPTH];       // Merkle path (0 = left, 1 = right)

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
    
    // src_chain_id (32 bits)
    for (var i = 0; i < 32; i++) {
        preimage[idx] <== src_chain_id[i];
        idx++;
    }
    
    // dst_chain_id (32 bits)
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
    
    // recipient (256 bits)
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== recipient[i];
        idx++;
    }
    
    // amount (64 bits)
    for (var i = 0; i < 64; i++) {
        preimage[idx] <== amount_bits[i];
        idx++;
    }
    
    // nonce (64 bits)
    for (var i = 0; i < 64; i++) {
        preimage[idx] <== nonce_bits[i];
        idx++;
    }
    
    // asset_id (256 bits)
    for (var i = 0; i < 256; i++) {
        preimage[idx] <== asset_id[i];
        idx++;
    }

    // Compute Keccak256(preimage) for message_id
    component msg_hasher = Keccak256Bits(PREIMAGE_BITS);
    for (var i = 0; i < PREIMAGE_BITS; i++) {
        msg_hasher.in[i] <== preimage[i];
    }

    // Verify computed message_id matches public input
    for (var i = 0; i < 256; i++) {
        msg_hasher.out[i] === message_id[i];
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Compute leaf = Keccak256(message_id)
    // ═══════════════════════════════════════════════════════════
    component leaf_hasher = Keccak256Bits(256);
    for (var i = 0; i < 256; i++) {
        leaf_hasher.in[i] <== message_id[i];
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
        merkle.root[i] === checkpoint_root[i];
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Constrain path_indices to be binary
    // ═══════════════════════════════════════════════════════════
    for (var i = 0; i < TREE_DEPTH; i++) {
        path_indices[i] * (1 - path_indices[i]) === 0;
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Version must be 1 (hardcoded check)
    // ═══════════════════════════════════════════════════════════
    // version[0] must be 1, rest 0 (LE bit representation of 1)
    version[0] === 1;
    for (var i = 1; i < 32; i++) {
        version[i] === 0;
    }
}

// Main component — Merkle tree depth 20 (1M events per checkpoint)
component main {public [
    checkpoint_root,
    message_id,
    amount_bits,
    recipient,
    asset_id,
    src_chain_id,
    dst_chain_id,
    version
]} = BridgeDepositInclusion(20);
