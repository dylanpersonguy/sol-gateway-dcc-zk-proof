pragma circom 2.1.0;

/**
 * ZK Bridge Test Circuit — Simplified Deposit Proof
 * 
 * Proves knowledge of private inputs (a, b) such that:
 *   public_hash == (a * b) + a + b    (simplified "hash")
 *   amount == a                        (amount binding)
 *   recipient == b                     (recipient binding)
 *
 * This tests the same structural pattern as the full bridge circuit:
 *   - Private witness (secret knowledge)
 *   - Public inputs (verifiable outputs)
 *   - Constraint satisfaction
 *
 * In the real circuit, the "hash" is Keccak256 and there's
 * a Merkle tree, but the Groth16 pipeline is identical.
 */
template BridgeTestProof() {
    // Public inputs (like checkpoint_root, message_id, amount, recipient)
    signal input public_hash;
    signal input amount;
    signal input recipient;
    signal input version;

    // Private inputs (like sender, nonce, merkle_siblings)
    signal input secret_a;
    signal input secret_b;

    // Constraint 1: Compute hash from private inputs
    signal ab;
    ab <== secret_a * secret_b;
    signal computed_hash;
    computed_hash <== ab + secret_a + secret_b;

    // Constraint 2: Computed hash must match public input
    public_hash === computed_hash;

    // Constraint 3: Amount must match private input a
    amount === secret_a;

    // Constraint 4: Recipient must match private input b
    recipient === secret_b;

    // Constraint 5: Version must be 1 (like the real circuit)
    version === 1;
}

component main {public [public_hash, amount, recipient, version]} = BridgeTestProof();
