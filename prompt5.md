You are a Waves/Ride smart contract engineer and protocol security engineer.

This repository implements a ZK bridge between:
- Solana (Rust/Anchor programs)
- DCC (Waves-style Ride dApp)
- Off-chain prover/indexer/relayer

Your task is to adapt the bridge verification + message encoding system to REAL Ride constraints,
so the DCC dApp can safely verify messages and ZK proofs without relying on unsupported operations.

The result must be:
- secure (fail closed)
- deterministic
- cross-language consistent
- compatible with Ride limits (script complexity, function availability)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — ENUMERATE RIDE CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Inspect the current Ride script(s) and list constraints that matter for verification:

- available hash functions in Ride (e.g., blake2b256, sha256, keccak256 if available)
- bytevector operations and limits
- string/bytes conversions
- maximum complexity and how close we are
- storage patterns (data entries) and key size limits
- bn256Groth16Verify input packing constraints (types, ordering, sizes)

If any function used by the protocol is not available or too expensive in Ride, flag it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — CHOOSE A RIDE-FRIENDLY MESSAGE ID STRATEGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

We need a message_id that binds all critical fields and is used consistently in:
- Solana program
- prover service
- ZK circuit public inputs
- Ride dApp replay protection + audit trail

Choose ONE of these strategies and implement it end-to-end:

STRATEGY A (Preferred if feasible):
- message_id = blake2b256(canonical_message_bytes)
- canonical_message_bytes defined in /spec/encoding.md
- Ride recomputes blake2b256 and checks equality

STRATEGY B (If Ride cannot recompute full bytes reliably/cheaply):
- message_id is provided as a public input (from proof)
- Ride does NOT recompute full message hash
- Instead Ride enforces a “binding check” by recomputing a cheaper commitment:
  - binding_commit = blake2b256(version||chain_ids||asset_id||amount||nonce||recipient_bytes_fixed)
- binding_commit must be included inside ZK proof statement AND stored on-chain for replay protection
- This ensures attacker cannot change recipient/amount without breaking proof binding

You MUST pick the safest feasible strategy for Ride and document the tradeoffs.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — DEFINE RIDE-CANONICAL ADDRESS ENCODING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Ride addresses/public keys often appear as base58 strings externally.

Define canonical binary encoding rules:
- Solana pubkey: 32 raw bytes
- Ride recipient: either 26-byte address bytes OR 32-byte public key bytes (choose one and stick to it)
- No base58 inside hashes

Implement helper functions in Ride to:
- validate recipient encoding length
- reject malformed encodings (fail closed)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — ZK VERIFICATION INPUT PACKING FOR RIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement a single function in Ride like:

verifyAndMint(proof, publicInputs)

Where:
- publicInputs include:
  checkpoint_root
  message_id (or binding_commit)
  amount
  recipient_bytes
  asset_id
  src_chain_id, dst_chain_id, version
  expiry
- The order and packing must match the verifier key and circuit exactly.

Implement:
- strict length checks on proof and public input arrays
- strict bounds checks for amount, nonce, expiry
- chain id checks and domain separation checks

If any check fails: REJECT.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — REPLAY PROTECTION & STORAGE SCHEMA (RIDE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Design a storage schema that cannot be reset or collided:

- processed::<message_id_hex> = true
- processed_at::<message_id_hex> = timestamp
- minted_amount::<message_id_hex> = amount

Also store rolling counters for caps:
- cap_hour::<hour_bucket> = total_minted
- cap_day::<day_bucket> = total_minted

Enforce:
- if processed exists -> reject
- update processed BEFORE minting if possible (or ensure atomicity within the transaction model)
- never allow admin to delete processed entries

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — PAUSE + GOVERNANCE SAFETY (RIDE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement pause controls:
- paused = true/false
- only admin can pause/unpause
- unpause must be timelocked (store requested_unpause_at, enforce delay)
- while paused, mint/release operations must fail closed

Prevent “Nomad-class accept-all” states:
- disallow setting verifier key to empty
- disallow setting chain ids/domain sep to empty
- disallow wildcard checkpoint root acceptance

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7 — CROSS-LANGUAGE TEST VECTORS (RIDE INCLUDED)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Add Ride tests (or harness scripts) that:
- load /spec/test-vectors.json
- for each vector:
  - ensure Ride’s computed message_id/binding_commit matches expected
  - ensure Ride rejects mutated vectors (amount/recipient changed)

If Ride cannot run external tests natively, implement a CLI runner that:
- prints Ride-computed hashes using same logic (or a reference JS mirror of Ride logic)
- compares to vectors in CI

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 8 — OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deliver:
1) Updated /spec/encoding.md with Ride-specific constraints called out
2) Updated /spec/test-vectors.json including Ride-focused cases
3) Ride dApp code implementing verifyAndMint + replay + caps + pause
4) Unit tests / harness for Ride equivalence checks
5) A short security note: what Ride verifies directly vs what is guaranteed by ZK proof

DO NOT hand-wave.
If Ride limitations force a weaker approach, implement compensating controls:
- tighter caps
- delays for large mints
- more public inputs bound in proof
- mandatory expiry
- automatic pause on anomalies