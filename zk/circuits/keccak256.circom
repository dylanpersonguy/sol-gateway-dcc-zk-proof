pragma circom 2.1.0;

/**
 * Keccak256 for Circom — Wrapper for the keccak256 hash function
 * operating on bit arrays.
 *
 * This is a simplified Keccak256 implementation for Groth16 circuits.
 * In production, use the audited keccak256-circom library from:
 * https://github.com/vocdoni/keccak256-circom
 *
 * For now, we implement the core Keccak-f[1600] permutation and sponge
 * construction needed for the bridge circuit.
 */

/**
 * XOR gate for 2 inputs
 */
template Xor2() {
    signal input a;
    signal input b;
    signal output out;
    
    out <== a + b - 2 * a * b;
}

/**
 * XOR gate for 5 inputs (used in Keccak theta step)
 */
template Xor5() {
    signal input in[5];
    signal output out;
    
    component x01 = Xor2();
    x01.a <== in[0];
    x01.b <== in[1];
    
    component x012 = Xor2();
    x012.a <== x01.out;
    x012.b <== in[2];
    
    component x0123 = Xor2();
    x0123.a <== x012.out;
    x0123.b <== in[3];
    
    component x01234 = Xor2();
    x01234.a <== x0123.out;
    x01234.b <== in[4];
    
    out <== x01234.out;
}

/**
 * AND-NOT gate: a AND (NOT b) = a * (1 - b)
 */
template AndNot() {
    signal input a;
    signal input b;
    signal output out;
    
    out <== a * (1 - b);
}

/**
 * Keccak-f[1600] round constants (24 rounds, each 64 bits)
 * Represented as arrays of 64 bits (LSB first)
 */
function keccak_rc(round) {
    var rc[24][64];
    
    // RC[0] = 0x0000000000000001
    rc[0][0] = 1;
    // RC[1] = 0x0000000000008082  
    rc[1][1] = 1; rc[1][7] = 1; rc[1][15] = 1;
    // RC[2] = 0x800000000000808a
    rc[2][1] = 1; rc[2][3] = 1; rc[2][7] = 1; rc[2][15] = 1; rc[2][63] = 1;
    // RC[3] = 0x8000000080008000
    rc[3][15] = 1; rc[3][31] = 1; rc[3][63] = 1;
    // RC[4] = 0x000000000000808b
    rc[4][0] = 1; rc[4][1] = 1; rc[4][3] = 1; rc[4][7] = 1; rc[4][15] = 1;
    // ... (remaining constants follow standard Keccak spec)
    // For brevity, only first 5 shown; full implementation uses lookup table
    
    return rc[round];
}

/**
 * Keccak256 operating on a bit array of arbitrary length.
 * 
 * Input: N bits (the preimage)
 * Output: 256 bits (the hash)
 *
 * This uses the sponge construction with:
 * - Rate r = 1088 bits (136 bytes) 
 * - Capacity c = 512 bits (64 bytes)
 * - State width = 1600 bits
 *
 * For the bridge circuit, input sizes are:
 * - message_id computation: 1448 bits (181 bytes) → 2 absorb blocks (pad to 2*1088)
 * - leaf computation: 256 bits (32 bytes) → 1 absorb block (pad to 1088)
 */
template Keccak256Bits(N) {
    signal input in[N];
    signal output out[256];

    // Pad the input to a multiple of 1088 bits (rate)
    var RATE = 1088;
    var num_blocks = (N + 1 + 1 + RATE - 1) \ RATE; // ceiling division after padding
    if (num_blocks == 0) { num_blocks = 1; }
    var PADDED_LEN = num_blocks * RATE;
    
    signal padded[PADDED_LEN];
    
    // Copy input bits
    for (var i = 0; i < N; i++) {
        padded[i] <== in[i];
    }
    
    // Keccak padding: append 1, then zeros, then 1 at end of rate block
    // The "0x06...80" domain sep for Keccak-256
    // Bit-level: input || 0x06 padding || ... || 0x80
    if (N < PADDED_LEN) {
        // After input: 0x06 = 00000110 in bits (LSB first: 0,1,1,0,0,0,0,0)
        padded[N] <== 0;      // bit 0 of 0x06
        if (N + 1 < PADDED_LEN) { padded[N+1] <== 1; }     // bit 1
        if (N + 2 < PADDED_LEN) { padded[N+2] <== 1; }     // bit 2
        // Fill zeros
        for (var i = N + 3; i < PADDED_LEN - 1; i++) {
            padded[i] <== 0;
        }
        // Last bit of last rate block = 1 (0x80 = 10000000, LSB first: 0,0,0,0,0,0,0,1)
        padded[PADDED_LEN - 1] <== 1;
    }

    // ═══════════════════════════════════════════════════════════
    // Keccak Sponge: absorb blocks then squeeze
    // ═══════════════════════════════════════════════════════════
    
    // State: 5×5 matrix of 64-bit lanes = 1600 bits
    // For the circuit, we track state as 1600 individual bit signals
    
    // Initialize state to zeros
    signal state_init[1600];
    for (var i = 0; i < 1600; i++) {
        state_init[i] <== 0;
    }

    // Process each block: XOR with state rate portion, then permute
    // Due to Circom's constraints, we unroll the absorption loop
    
    // For simplicity in the bridge use case, we handle the specific sizes:
    // N=256 (1 block) and N=1448 (2 blocks)
    
    // Block 1: XOR padded[0..1088] with state[0..1088]
    signal after_absorb_1[1600];
    component xor_absorb_1[RATE];
    for (var i = 0; i < RATE; i++) {
        xor_absorb_1[i] = Xor2();
        xor_absorb_1[i].a <== state_init[i];
        xor_absorb_1[i].b <== padded[i];
        after_absorb_1[i] <== xor_absorb_1[i].out;
    }
    // Capacity portion unchanged
    for (var i = RATE; i < 1600; i++) {
        after_absorb_1[i] <== state_init[i];
    }

    // Apply Keccak-f[1600] permutation (24 rounds)
    component perm_1 = KeccakF1600();
    for (var i = 0; i < 1600; i++) {
        perm_1.in[i] <== after_absorb_1[i];
    }

    // If we have more blocks, absorb them
    signal final_state[1600];
    
    if (num_blocks == 1) {
        for (var i = 0; i < 1600; i++) {
            final_state[i] <== perm_1.out[i];
        }
    } else {
        // Block 2
        signal after_absorb_2[1600];
        component xor_absorb_2[RATE];
        for (var i = 0; i < RATE; i++) {
            xor_absorb_2[i] = Xor2();
            xor_absorb_2[i].a <== perm_1.out[i];
            if (RATE + i < PADDED_LEN) {
                xor_absorb_2[i].b <== padded[RATE + i];
            } else {
                xor_absorb_2[i].b <== 0;
            }
            after_absorb_2[i] <== xor_absorb_2[i].out;
        }
        for (var i = RATE; i < 1600; i++) {
            after_absorb_2[i] <== perm_1.out[i];
        }
        
        component perm_2 = KeccakF1600();
        for (var i = 0; i < 1600; i++) {
            perm_2.in[i] <== after_absorb_2[i];
        }
        
        for (var i = 0; i < 1600; i++) {
            final_state[i] <== perm_2.out[i];
        }
    }

    // Squeeze: extract first 256 bits of state
    for (var i = 0; i < 256; i++) {
        out[i] <== final_state[i];
    }
}

/**
 * Keccak-f[1600] permutation — 24 rounds
 * State: 1600 bits (5×5 matrix of 64-bit lanes, stored as flat bit array)
 *
 * Lane indexing: state[64*(5*x + y) + z] for lane (x,y) bit z
 */
template KeccakF1600() {
    signal input in[1600];
    signal output out[1600];
    
    // 24 rounds of the Keccak-f permutation
    var NUM_ROUNDS = 24;
    
    signal round_state[NUM_ROUNDS + 1][1600];
    
    // Initialize
    for (var i = 0; i < 1600; i++) {
        round_state[0][i] <== in[i];
    }
    
    // Each round: θ, ρ, π, χ, ι
    component rounds[NUM_ROUNDS];
    for (var r = 0; r < NUM_ROUNDS; r++) {
        rounds[r] = KeccakRound(r);
        for (var i = 0; i < 1600; i++) {
            rounds[r].in[i] <== round_state[r][i];
        }
        for (var i = 0; i < 1600; i++) {
            round_state[r + 1][i] <== rounds[r].out[i];
        }
    }
    
    for (var i = 0; i < 1600; i++) {
        out[i] <== round_state[NUM_ROUNDS][i];
    }
}

/**
 * Single Keccak round: θ → ρ → π → χ → ι
 */
template KeccakRound(ROUND) {
    signal input in[1600];
    signal output out[1600];
    
    // ── θ (theta) step ──
    // C[x] = A[x,0] ⊕ A[x,1] ⊕ A[x,2] ⊕ A[x,3] ⊕ A[x,4]  (column parity)
    // D[x] = C[x-1] ⊕ rot(C[x+1], 1)
    // A'[x,y] = A[x,y] ⊕ D[x]
    
    // Column parity: 5 columns × 64 bits each
    component col_parity[5][64];
    signal C[5][64];
    
    for (var x = 0; x < 5; x++) {
        for (var z = 0; z < 64; z++) {
            col_parity[x][z] = Xor5();
            for (var y = 0; y < 5; y++) {
                col_parity[x][z].in[y] <== in[64*(5*x + y) + z];
            }
            C[x][z] <== col_parity[x][z].out;
        }
    }
    
    // D[x][z] = C[(x-1)%5][z] ⊕ C[(x+1)%5][(z-1)%64]
    component d_xor[5][64];
    signal D[5][64];
    
    for (var x = 0; x < 5; x++) {
        for (var z = 0; z < 64; z++) {
            d_xor[x][z] = Xor2();
            d_xor[x][z].a <== C[(x + 4) % 5][z];
            d_xor[x][z].b <== C[(x + 1) % 5][(z + 63) % 64]; // rot by 1
            D[x][z] <== d_xor[x][z].out;
        }
    }
    
    // Apply theta: A'[x,y,z] = A[x,y,z] ⊕ D[x,z]
    component theta_xor[5][5][64];
    signal after_theta[1600];
    
    for (var x = 0; x < 5; x++) {
        for (var y = 0; y < 5; y++) {
            for (var z = 0; z < 64; z++) {
                theta_xor[x][y][z] = Xor2();
                theta_xor[x][y][z].a <== in[64*(5*x + y) + z];
                theta_xor[x][y][z].b <== D[x][z];
                after_theta[64*(5*x + y) + z] <== theta_xor[x][y][z].out;
            }
        }
    }
    
    // ── ρ (rho) and π (pi) steps combined ──
    // B[y, 2x+3y] = rot(A'[x,y], rotation_offsets[x][y])
    signal after_rho_pi[1600];
    
    // Rotation offsets per (x,y)
    // Standard Keccak rotation table
    var rot_offsets[5][5];
    rot_offsets[0][0] = 0;  rot_offsets[1][0] = 1;  rot_offsets[2][0] = 62; rot_offsets[3][0] = 28; rot_offsets[4][0] = 27;
    rot_offsets[0][1] = 36; rot_offsets[1][1] = 44; rot_offsets[2][1] = 6;  rot_offsets[3][1] = 55; rot_offsets[4][1] = 20;
    rot_offsets[0][2] = 3;  rot_offsets[1][2] = 10; rot_offsets[2][2] = 43; rot_offsets[3][2] = 25; rot_offsets[4][2] = 39;
    rot_offsets[0][3] = 41; rot_offsets[1][3] = 45; rot_offsets[2][3] = 15; rot_offsets[3][3] = 21; rot_offsets[4][3] = 8;
    rot_offsets[0][4] = 18; rot_offsets[1][4] = 2;  rot_offsets[2][4] = 61; rot_offsets[3][4] = 56; rot_offsets[4][4] = 14;
    
    for (var x = 0; x < 5; x++) {
        for (var y = 0; y < 5; y++) {
            var new_x = y;
            var new_y = (2 * x + 3 * y) % 5;
            var rot = rot_offsets[x][y];
            for (var z = 0; z < 64; z++) {
                // Rotation: new_z = (z - rot) mod 64
                var src_z = (z + 64 - rot) % 64;
                after_rho_pi[64*(5*new_x + new_y) + z] <== after_theta[64*(5*x + y) + src_z];
            }
        }
    }
    
    // ── χ (chi) step ──
    // A''[x,y] = B[x,y] ⊕ ((NOT B[x+1,y]) AND B[x+2,y])
    component chi_andnot[5][5][64];
    component chi_xor[5][5][64];
    signal after_chi[1600];
    
    for (var x = 0; x < 5; x++) {
        for (var y = 0; y < 5; y++) {
            for (var z = 0; z < 64; z++) {
                chi_andnot[x][y][z] = AndNot();
                chi_andnot[x][y][z].a <== after_rho_pi[64*(5*((x+2)%5) + y) + z];
                chi_andnot[x][y][z].b <== after_rho_pi[64*(5*((x+1)%5) + y) + z];
                
                chi_xor[x][y][z] = Xor2();
                chi_xor[x][y][z].a <== after_rho_pi[64*(5*x + y) + z];
                chi_xor[x][y][z].b <== chi_andnot[x][y][z].out;
                after_chi[64*(5*x + y) + z] <== chi_xor[x][y][z].out;
            }
        }
    }
    
    // ── ι (iota) step ──
    // A'''[0,0] = A''[0,0] ⊕ RC[round]
    // Only lane (0,0) is affected
    
    // Round constants for Keccak-f[1600]
    // Full 24 round constants (64-bit each, LSB-first bit arrays)
    var RC[24][64];
    // RC[0] = 0x0000000000000001
    RC[0][0] = 1;
    // RC[1] = 0x0000000000008082
    RC[1][1] = 1; RC[1][7] = 1; RC[1][15] = 1;
    // RC[2] = 0x800000000000808A
    RC[2][1] = 1; RC[2][3] = 1; RC[2][7] = 1; RC[2][15] = 1; RC[2][63] = 1;
    // RC[3] = 0x8000000080008000
    RC[3][15] = 1; RC[3][31] = 1; RC[3][63] = 1;
    // RC[4] = 0x000000000000808B
    RC[4][0] = 1; RC[4][1] = 1; RC[4][3] = 1; RC[4][7] = 1; RC[4][15] = 1;
    // RC[5] = 0x0000000080000001
    RC[5][0] = 1; RC[5][31] = 1;
    // RC[6] = 0x8000000080008081
    RC[6][0] = 1; RC[6][7] = 1; RC[6][15] = 1; RC[6][31] = 1; RC[6][63] = 1;
    // RC[7] = 0x8000000000008009
    RC[7][0] = 1; RC[7][3] = 1; RC[7][15] = 1; RC[7][63] = 1;
    // RC[8] = 0x000000000000008A
    RC[8][1] = 1; RC[8][3] = 1; RC[8][7] = 1;
    // RC[9] = 0x0000000000000088
    RC[9][3] = 1; RC[9][7] = 1;
    // RC[10] = 0x0000000080008009
    RC[10][0] = 1; RC[10][3] = 1; RC[10][15] = 1; RC[10][31] = 1;
    // RC[11] = 0x000000008000000A
    RC[11][1] = 1; RC[11][3] = 1; RC[11][31] = 1;
    // RC[12] = 0x000000008000808B
    RC[12][0] = 1; RC[12][1] = 1; RC[12][3] = 1; RC[12][7] = 1; RC[12][15] = 1; RC[12][31] = 1;
    // RC[13] = 0x800000000000008B
    RC[13][0] = 1; RC[13][1] = 1; RC[13][3] = 1; RC[13][7] = 1; RC[13][63] = 1;
    // RC[14] = 0x8000000000008089
    RC[14][0] = 1; RC[14][3] = 1; RC[14][7] = 1; RC[14][15] = 1; RC[14][63] = 1;
    // RC[15] = 0x8000000000008003
    RC[15][0] = 1; RC[15][1] = 1; RC[15][15] = 1; RC[15][63] = 1;
    // RC[16] = 0x8000000000008002
    RC[16][1] = 1; RC[16][15] = 1; RC[16][63] = 1;
    // RC[17] = 0x8000000000000080
    RC[17][7] = 1; RC[17][63] = 1;
    // RC[18] = 0x000000000000800A
    RC[18][1] = 1; RC[18][3] = 1; RC[18][15] = 1;
    // RC[19] = 0x800000008000000A
    RC[19][1] = 1; RC[19][3] = 1; RC[19][31] = 1; RC[19][63] = 1;
    // RC[20] = 0x8000000080008081
    RC[20][0] = 1; RC[20][7] = 1; RC[20][15] = 1; RC[20][31] = 1; RC[20][63] = 1;
    // RC[21] = 0x8000000000008080
    RC[21][7] = 1; RC[21][15] = 1; RC[21][63] = 1;
    // RC[22] = 0x0000000080000001
    RC[22][0] = 1; RC[22][31] = 1;
    // RC[23] = 0x8000000080008008
    RC[23][3] = 1; RC[23][15] = 1; RC[23][31] = 1; RC[23][63] = 1;

    component iota_xor[64];
    for (var z = 0; z < 64; z++) {
        if (RC[ROUND][z] == 1) {
            iota_xor[z] = Xor2();
            iota_xor[z].a <== after_chi[z]; // lane (0,0), bit z
            iota_xor[z].b <== 1;
            out[z] <== iota_xor[z].out;
        } else {
            out[z] <== after_chi[z];
        }
    }
    
    // Copy remaining lanes unchanged
    for (var i = 64; i < 1600; i++) {
        out[i] <== after_chi[i];
    }
}
