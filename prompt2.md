You are acting as a formal verification engineer specializing in blockchain protocol security.

Your task is to verify that the core SAFETY INVARIANTS of this cross-chain ZK bridge can NEVER be violated under any sequence of valid or malicious transactions.

Treat the system as a state machine and reason about ALL possible transitions.

Do NOT assume the code is correct. Attempt to prove whether invariants always hold.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYSTEM OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This repository implements a ZK-proof-based cross-chain bridge between:

• Solana
• DecentralChain (Ride / Waves style)

Architecture components include:

• Solana vault program
• Solana checkpoint registry
• Ride / DCC bridge dApp
• ZK circuits
• prover service
• relayer/indexer
• event Merkle tree
• message hashing
• replay protection
• mint / burn logic

Assets are locked on Solana and wrapped tokens are minted on DCC.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — IDENTIFY STATE VARIABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Extract all state variables that affect security including:

• vault balances
• wrapped token supply
• processed message IDs
• checkpoint roots
• nonces
• replay protection storage
• mint / burn counters
• rate limits
• pause flags

Create a clear list of the full bridge state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — MODEL STATE TRANSITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Identify every operation that can change state:

Examples:

• deposit event emitted on Solana
• checkpoint committed
• ZK proof submitted
• mint wrapped tokens
• burn wrapped tokens
• release SOL from vault
• replay protection update
• admin pause / resume
• configuration updates

Represent these as state transitions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — DEFINE SECURITY INVARIANTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Verify the following invariants always hold.

INVARIANT 1
Total wrapped token supply on DCC must never exceed total locked assets in the Solana vault.

INVARIANT 2
Each message_id can be processed at most once.

INVARIANT 3
A withdrawal must only occur after a valid burn proof.

INVARIANT 4
Invalid ZK proofs must never change contract state.

INVARIANT 5
Checkpoint roots cannot be substituted to produce valid proofs for events that did not occur.

INVARIANT 6
Replay protection must survive across restarts and upgrades.

INVARIANT 7
Paused bridge must block all mint and withdraw operations.

INVARIANT 8
Rate limits must always cap the maximum possible value extracted per time window.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — EXPLORE EDGE CASES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyze extreme scenarios such as:

• simultaneous transactions
• replay attempts
• proof submission race conditions
• mutated message payloads
• expired checkpoints
• partial system failure
• corrupted relayer inputs

Check if any edge case breaks an invariant.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — SYMBOLIC ATTACK ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Assume an attacker can control:

• relayer inputs
• prover requests
• proof submission order
• transaction ordering
• timing of checkpoints

Determine if any attacker-controlled sequence of actions could violate an invariant.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — SERIALIZATION CONSISTENCY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Verify that message hashing and encoding are identical across:

• Solana program
• ZK circuit
• prover code
• Ride verifier

If serialization differs in any component, identify potential invariant violations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7 — AUTOMATED PROPERTY TESTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generate property-based tests that randomly simulate thousands of bridge operations including adversarial inputs.

Verify that invariants never break.

Examples:

• random deposit / burn sequences
• replay attempts
• invalid proofs
• checkpoint mutation
• extreme numeric values

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Produce a FORMAL VERIFICATION REPORT containing:

1. System state model
2. List of all state transitions
3. Verified invariants
4. Any invariant violations discovered
5. Potential theoretical violations
6. Required fixes
7. Additional invariants that should be enforced

If invariants appear to hold, clearly list the assumptions required for that to remain true.

Do not rely on informal reasoning. Treat this as a formal protocol verification exercise.