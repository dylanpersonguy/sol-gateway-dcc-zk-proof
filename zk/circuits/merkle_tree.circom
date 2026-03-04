pragma circom 2.1.0;

include "keccak256.circom";

/**
 * Merkle Proof Verifier using Keccak256
 *
 * Given a leaf and a Merkle proof (siblings + path indices),
 * computes the Merkle root from bottom to top.
 *
 * At each level:
 *   if path_index[i] == 0: node = Hash(current || sibling[i])
 *   if path_index[i] == 1: node = Hash(sibling[i] || current)
 *
 * Hash function: Keccak256(left[256 bits] || right[256 bits])
 */

/**
 * Select between two 256-bit values based on a selector bit.
 * selector == 0: out_left = a, out_right = b
 * selector == 1: out_left = b, out_right = a
 */
template DualMux256() {
    signal input a[256];
    signal input b[256];
    signal input selector;
    signal output out_left[256];
    signal output out_right[256];
    
    // selector must be binary (enforced by caller)
    // out_left = a + selector * (b - a)
    // out_right = b + selector * (a - b)
    
    signal diff[256];
    for (var i = 0; i < 256; i++) {
        diff[i] <== b[i] - a[i];
        out_left[i] <== a[i] + selector * diff[i];
        out_right[i] <== b[i] - selector * diff[i];
    }
}

/**
 * Single level of Merkle proof verification.
 * Hashes current node with sibling, ordering determined by path_index.
 */
template MerkleLevel() {
    signal input current[256];
    signal input sibling[256];
    signal input path_index;    // 0 = current is left child, 1 = current is right child
    signal output next[256];
    
    // Select ordering
    component mux = DualMux256();
    for (var i = 0; i < 256; i++) {
        mux.a[i] <== current[i];
        mux.b[i] <== sibling[i];
    }
    mux.selector <== path_index;
    
    // Hash(left || right) — 512 bits input → 256 bits output
    component hasher = Keccak256Bits(512);
    for (var i = 0; i < 256; i++) {
        hasher.in[i] <== mux.out_left[i];
    }
    for (var i = 0; i < 256; i++) {
        hasher.in[256 + i] <== mux.out_right[i];
    }
    
    for (var i = 0; i < 256; i++) {
        next[i] <== hasher.out[i];
    }
}

/**
 * Full Merkle Proof Verifier.
 * Computes root from leaf + proof, exposing the computed root as output.
 */
template MerkleProofVerifier(DEPTH) {
    signal input leaf[256];
    signal input siblings[DEPTH][256];
    signal input path_indices[DEPTH];
    signal output root[256];
    
    component levels[DEPTH];
    
    for (var i = 0; i < DEPTH; i++) {
        levels[i] = MerkleLevel();
        
        if (i == 0) {
            for (var j = 0; j < 256; j++) {
                levels[i].current[j] <== leaf[j];
            }
        } else {
            for (var j = 0; j < 256; j++) {
                levels[i].current[j] <== levels[i-1].next[j];
            }
        }
        
        for (var j = 0; j < 256; j++) {
            levels[i].sibling[j] <== siblings[i][j];
        }
        levels[i].path_index <== path_indices[i];
    }
    
    // Output the computed root
    for (var i = 0; i < 256; i++) {
        root[i] <== levels[DEPTH - 1].next[i];
    }
}
