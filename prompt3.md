You are an incident-response engineer and adversarial systems tester for a ZK-proof-based cross-chain bridge between:
- Solana
- DecentralChain (Ride/Waves style)

Your job is to simulate CATASTROPHIC FAILURE SCENARIOS and verify the system remains safe (fails closed, preserves funds, invariants hold).

Do NOT do a normal code review.
You must actively simulate disasters: compromised keys, corrupted checkpoints, bad proofs, serialization mismatches, partial outages, and transaction ordering attacks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — DEFINE “SAFETY” (MUST HOLD)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

These invariants must never be violated, even during incidents:

1) No asset duplication: wrapped supply on DCC <= SOL locked in Solana vault
2) No unauthorized mint/unlock: invalid proofs or fake events cannot mint/unlock
3) No replay: message_id processed at most once
4) Fail closed: uncertain verification must reject or hold, never approve
5) Paused state blocks all mint/unlock operations
6) Rate limits cap maximum loss per time window even if some component fails

If any scenario can violate an invariant, explain EXACTLY how and provide a fix.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — CATASTROPHIC SCENARIOS TO SIMULATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For each scenario:
- Describe the attack/failure path
- Identify which components are impacted
- Show the exact transaction sequence / calls an attacker would make
- Determine whether funds can be stolen or supply can inflate
- Confirm which guardrail stops it (or why it fails)

SCENARIO A — “NOMAD-CLASS” ACCEPT-ALL BUG
Simulate a configuration/upgrade mistake where verification becomes permissive:
- checkpoint root set to zero/wildcard
- domain separation disabled
- replay set reset
Ensure the system cannot enter an accept-all state, or that emergency mechanisms stop it.

SCENARIO B — CHECKPOINT CORRUPTION / MALICIOUS ROOTS
Assume a malicious or buggy checkpoint root is posted:
- root doesn’t correspond to real Solana events
- root is old but reused
- root is from another chain/program
Verify ZK proof cannot be used to mint/unlock from a malicious checkpoint, or if checkpoints are trusted, quantify max loss via caps+delays.

SCENARIO C — PROVER COMPROMISE
Assume the prover service is fully compromised:
- attacker can generate arbitrary proofs (attempt)
- attacker can change public inputs
Verify on-chain verifier rejects any proof not matching the pinned verifying key and public inputs.
Confirm compromised prover cannot mint/unlock without a valid witness under the correct checkpoint root.

SCENARIO D — RELAYER COMPROMISE
Assume relayer is malicious:
- withholds proofs
- reorders submissions
- spams invalid proofs
Verify relayer has ZERO authority.
Verify DoS resistance and that invalid proof spam cannot alter state.

SCENARIO E — SERIALIZATION / HASH MISMATCH
Assume one component hashes message_id differently (endianness, padding, string bytes):
- prover uses different encoding than Solana program
- Ride uses different encoding than prover
Determine whether this causes:
- stuck funds (liveness failure)
- or worse: acceptance of wrong message (safety failure)
Add mitigation: shared test vectors and strict canonical encoding.

SCENARIO F — REPLAY AT SCALE
Attempt:
- submit same proof twice
- submit proof with same message_id but different metadata
- cross-chain replay (different chain ids)
Ensure processed_message_id is enforced on both sides and cannot be reset or collided.

SCENARIO G — TIME / FINALITY CONFUSION
Attempt to use:
- non-finalized slot
- stale checkpoint past expiry
- future slot
Ensure finality policy + expiry are enforced and fail closed.

SCENARIO H — VAULT DRAIN VIA WITHDRAW PATH
Attempt:
- withdraw without burn
- burn proof referencing different recipient
- partial rounding / integer overflow exploitation
Ensure withdrawal requires valid burn proof bound to recipient + amount + message_id.

SCENARIO I — GOVERNANCE / UPGRADE TAKEOVER
Assume attacker gains admin capability:
- tries to upgrade verifier key
- disables pause
- changes caps
Verify timelock + veto + emergency freeze prevents immediate draining.
Quantify worst-case loss if admin is fully compromised.

SCENARIO J — PARTIAL OUTAGE / PARTITION
Assume:
- Solana RPC unreliable
- checkpoint posting delayed
- DCC node disagreement
Ensure system doesn’t “guess” and mint.
Must hold funds until proofs/verification are valid.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — AUTOMATED SIMULATION TESTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement an automated simulation harness that:
- models bridge state machine
- executes randomized sequences of actions
- injects scenario faults (bad checkpoints, replay, malformed proofs, pausing, upgrade attempts)
- checks invariants after every step

Include:
- property-based tests (fuzz)
- negative tests
- concurrency/ordering tests

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Produce a “CATASTROPHIC FAILURE REPORT” containing:
1) Scenario-by-scenario results (PASS/FAIL)
2) If FAIL, exact exploit path + patch
3) Which guardrails stopped the attack (if PASS)
4) Worst-case loss bounds under partial trust assumptions
5) Actionable hardening checklist
6) Required monitoring/alerts for early detection

Be ruthless. Assume subtle bugs exist.
If uncertain, treat as FAIL and propose a concrete fix.

Start by creating /security/simulations/ and implement the harness first