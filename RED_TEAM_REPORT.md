# RED TEAM SECURITY REPORT

## SOL-Gateway-DCC ZK Bridge

**Date:** 2025  
**Classification:** CONFIDENTIAL — Critical vulnerabilities documented  
**Methodology:** Adversarial red team analysis — full repository audit  
**Scope:** Solana programs, RIDE/DCC contracts, ZK circuits, validator/consensus, API, infrastructure  

---

## EXECUTIVE SUMMARY

This bridge has **7 CRITICAL**, **11 HIGH**, **13 MEDIUM**, and **7 LOW** severity findings. Multiple critical vulnerabilities allow **complete vault drain**, **unlimited token minting**, and **theft of in-flight deposits**. The bridge is **NOT safe for production use** in its current state.

The most devastating finding is that an attacker can drain 100% of the Solana vault by forging validator accounts in `remaining_accounts` (CRIT-1). A second critical finding allows front-running any ZK-path deposit to steal the minted tokens (CRIT-3). A third critical finding means all DCC→SOL unlocks are nondeterministically broken due to timestamp mismatch in the consensus engine (CRIT-7).

---

## ATTACK CATEGORY RESULTS

### Category 1: Cross-Chain Message Forgery — ⚠️ EXPLOITABLE

**Attack:** Forge a bridge message that mints wrapped assets on DCC or releases SOL on Solana without a legitimate deposit.

**Finding CRIT-1 (Solana — Forged Validator Accounts):**
The `unlock` instruction in `programs/sol-bridge-lock/src/instructions/unlock.rs` lines ~145-160 accepts validator accounts via Anchor's `remaining_accounts` with **ZERO validation** — no owner check, no PDA derivation verification, no account discriminator check.

**Exploit:**
1. Attacker generates N fresh Ed25519 keypairs (where N ≥ `min_validators`)
2. Creates accounts owned by ANY program (not the bridge program)
3. Signs the canonical unlock message with all N keys
4. Submits unlock instruction with forged accounts as `remaining_accounts`
5. On-chain Ed25519 verification passes because the signatures match the provided pubkeys
6. **Result: Attacker drains the ENTIRE vault**

**Finding CRIT-3 (DCC — Unbound Recipient in ZK Minting):**
In `zk_verifier.ride`, the `verifyAndMint` callable accepts a `recipientAddress` string parameter that is **NEVER cross-validated** against the ZK proof's `recipient` public input field. The proof verifies correctly, but tokens are minted to whatever address the caller specifies.

**Exploit:**
1. Victim submits a legitimate ZK mint transaction to the DCC mempool
2. Attacker observes the transaction, extracts the proof bytes
3. Attacker submits an identical transaction but replaces `recipientAddress` with their own address
4. Attacker's transaction gets included first (front-running)
5. Proof verifies, tokens mint to attacker's address
6. Victim's transaction fails (replay protection marks messageId as used)
7. **Result: Attacker steals every ZK-path deposit**

**Finding CRIT-6 (DCC — Missing @Verifier in Bridge Controller):**
`bridge_controller.ride` has NO `@Verifier` annotation. In RIDE, this means the account accepts raw DataTransactions signed by the deployer key. This allows:
- Resetting replay protection (`processed_` entries)
- Adding malicious validator public keys
- Transferring admin rights
- Deleting pending mints
- **Result: Deployer key compromise = total bridge compromise**

---

### Category 2: Replay Attacks — ⚠️ EXPLOITABLE

**Finding CRIT-4 (DCC — Duplicate Public Key in Signatures):**
`zk_bridge.ride` lines ~240-260 `committeeMint` signature verification loop does **NOT deduplicate public keys**. The same key can appear multiple times in the `pubkeys` array, each incrementing `validCount`.

**Exploit:**
1. Compromise a SINGLE committee member key
2. Submit `committeeMint` with the same public key repeated N times (where N ≥ threshold)
3. Each signature verification passes (same key, same message)
4. `validCount` reaches threshold
5. **Result: Single key compromise breaks the entire multi-sig, unlimited minting**

**Finding CRIT-5 (DCC — Identical Bug in Bridge Controller):**
`bridge_controller.ride` lines ~173-200 has the exact same duplicate pubkey vulnerability in its validator signature verification loop.

**Replay Protection Assessment:**
- Solana: `processed_messages` HashMap prevents double-unlock — **PASS**
- DCC Contract A: `processed_` key prefix prevents double-mint via committee path — **PASS**
- DCC Contract B: `processed_zk_` key prevents double-mint via ZK path — **PASS**
- Bridge Controller: replay protection can be reset via DataTransaction (see CRIT-6) — **FAIL**

---

### Category 3: ZK Proof Manipulation — ⚠️ PARTIALLY EXPLOITABLE

**Finding HIGH-7 (DCC — Admin Can Replace Verification Key):**
The admin of Contract B (`zk_verifier.ride`) can call `updateVerifyingKey` to replace the VK at any time. A compromised or malicious admin can install a backdoored VK that accepts proofs for arbitrary recipients and amounts.

**Finding HIGH-8 (DCC — Admin Can Redirect Cross-Contract Calls):**
Admin can update configuration to redirect `verifyAndMint` invocations to a different contract, bypassing the legitimate verifier.

**Finding ZK-HIGH-1 (Custom Keccak-256 Implementation):**
The ZK circuits use a custom `keccak256.circom` implementation rather than an audited library (e.g., vocdoni). The implementation was manually verified as correct during this audit, but it represents a large unaudited attack surface (~3.5M constraints).

**ZK Circuit Analysis — What Passed:**
- Recipient address is a **public input** → cannot be changed without invalidating proof ✅
- Amount is a **public input** → cannot be changed without invalidating proof ✅
- Message ID is computed deterministically from all deposit fields ✅
- Merkle proof verification correctly constrained with domain separation ✅
- Keccak padding follows Keccak-256 spec (not SHA-3) ✅
- Field element truncation is safe ✅

**However:** The ZK circuit's protection of `recipient` is **undermined** by CRIT-3 (the contract ignores the proof's recipient and uses a separate parameter).

---

### Category 4: Merkle Tree Exploits — ⛔ NOT DIRECTLY EXPLOITABLE (but see CRIT-2)

**Finding CRIT-2 (Solana — Forged Checkpoint Submission):**
`checkpoint_registry/src/instructions/submit_checkpoint.rs` lines ~124-137 has the identical `remaining_accounts` forgery vulnerability as CRIT-1. An attacker can submit **arbitrary Merkle roots** as valid checkpoints.

**Exploit:**
1. Forge committee member accounts (same technique as CRIT-1)
2. Submit a checkpoint with an attacker-controlled Merkle root
3. The Merkle root contains a fabricated deposit event
4. Use this fake checkpoint to prove a non-existent deposit via the ZK path
5. **Result: Fabricated deposits can be proven and minted**

**Merkle Tree Implementation Analysis:**
- Leaf encoding uses Keccak-256 with proper domain separation ✅
- Sibling ordering is index-based (correct) ✅
- Tree depth is fixed at 20 levels ✅
- No duplicate leaf vulnerability found ✅

The Merkle tree implementation itself is sound, but the checkpoint submission that anchors it is fatally compromised.

---

### Category 5: Checkpoint / Finality Attacks — ⚠️ EXPLOITABLE (via CRIT-2)

**Via CRIT-2:** An attacker can post arbitrary checkpoint roots by forging committee member accounts. This means:
- Fake Merkle roots can be registered as finalized
- Any event can be "proven" against a malicious root
- The entire ZK verification path can be subverted at the checkpoint layer

**Finding MED-2 (Resume Checkpoint — No Timelock):**
Checkpoint resume after a pause has no timelock. An admin who pauses the system to investigate an issue could be front-run when they unpause.

**Finality Assessment:**
- Checkpoints require committee signatures — but committee accounts are forgeable (CRIT-2)
- Slot-based finality checks exist in the checkpoint registry — **PASS** (if committee is not forged)
- Old checkpoint replay is prevented by monotonic slot numbers — **PASS**

---

### Category 6: Vault Drain Attacks — ⚠️ EXPLOITABLE

**Finding CRIT-1 (Complete Vault Drain):** Full exploit described in Category 1. Forged validator accounts bypass all verification. The attacker can drain 100% of locked SOL.

**Finding HIGH-1 (Circuit Breaker Bypass — Scheduled Unlocks):**
`unlock.rs` lines ~186-210: When a large unlock is scheduled (above threshold), the daily outflow counter is **NOT incremented** because the function returns early before the state update. The circuit breaker is completely ineffective for large withdrawals.

**Finding HIGH-2 (No Circuit Breaker on Execute):**
`execute_scheduled_unlock_handler` in `unlock.rs` lines ~475-537 performs **zero circuit breaker checks**. Multiple previously-scheduled large unlocks can all execute on the same day, far exceeding the intended daily limit.

**Exploit Chain (if CRIT-1 is patched):**
1. Submit many unlock requests just below the large withdrawal threshold
2. Each passes the circuit breaker individually
3. Execute them all in rapid succession
4. Daily outflow counter may not catch up (depending on slot timing)
5. Or: schedule multiple large withdrawals on different days, execute them all on the same day

**Finding LOW-2 (total_locked Never Decremented):**
The `total_locked` field in the vault state is incremented on deposit but never decremented on unlock. This causes the supply invariant tracking to drift over time.

---

### Category 7: Supply Invariant Violations — ⚠️ EXPLOITABLE

**Target Invariant:** `Total wrapped supply ≤ Total locked assets`

**Finding CRIT-4 + CRIT-5 (Unlimited Minting via Pubkey Duplication):**
Both `committeeMint` (Contract A) and bridge controller signature verification allow duplicate public keys. A single compromised key can mint unlimited wrapped tokens, immediately violating the supply invariant.

**Finding HIGH-5 (totalMinted Not Updated for Pending Mints):**
When large mints are queued (pending approval), `totalMinted` is NOT incremented. If the mint is later executed, the tracking is incorrect.

**Finding HIGH-6 (totalBurned Not Updated for Multi-Token Burns):**
Multi-token burn operations may not correctly update `totalBurned`, causing drift between actual and tracked supply.

**Finding LOW-2 (Solana total_locked Never Decremented):**
As noted above, the Solana side never decrements its lock counter. Over time:
- Solana thinks more SOL is locked than actually is
- DCC supply tracking diverges from reality
- Accounting invariant becomes meaningless

---

### Category 8: State Corruption / Storage Attacks — ⚠️ EXPLOITABLE

**Finding CRIT-6 (DataTransaction State Manipulation):**
Without a `@Verifier` annotation in `bridge_controller.ride`, the deployer can issue arbitrary DataTransactions to:
- Delete `processed_` replay protection entries (enabling replay attacks)
- Overwrite validator lists
- Reset rate limits
- Corrupt any storage key

**Finding MED-3 (Permanent Member Bricking):**
In the checkpoint registry, removed committee members permanently occupy their PDA slot index. If all slots are used and removed, the committee cannot be reconstituted.

**Finding MED-4 (Zero Delay Allowed):**
`large_withdrawal_delay` can be set to 0, effectively disabling the timelock on large withdrawals.

**Finding MED-5 (min_validators Can Be 1):**
The minimum validator count can be set to 1, converting the multi-sig into a single-sig and eliminating the security benefit of distributed validation.

**Finding LOW-1 (event_index Truncation):**
`event_index` is stored as `u32` but used as `u64` in some contexts. After ~4 billion events, truncation could cause index collisions.

---

### Category 9: Denial of Service — ⚠️ EXPLOITABLE

**Finding CRIT-7 (All DCC→SOL Unlocks Broken):**
In the validator code, the consensus engine (`engine.ts` line ~462) computes the unlock message using `request.timestamp`, but `submitUnlockToSolana` (`main.ts` line ~614) recomputes the message using `Date.now()`. These produce **different timestamps** → **different message bytes** → **Ed25519 signatures don't match on-chain**.

**Impact:** ALL unlocks from DCC→Solana are nondeterministically broken. If any time passes between consensus and submission (which is inevitable in practice), the signatures will not verify. This is a **systematic bridge failure**, not a theoretical DoS.

**Finding HIGH-VAL-2 (Eclipse Attack via P2P Peer Injection):**
`transport.ts` lines ~256-268: The `peer_list` message is accepted without authentication. An attacker can:
1. Connect to a validator node
2. Send a `peer_list` message with attacker-controlled IPs
3. The validator adds these as peers and may disconnect from legitimate peers
4. **Result: Validator is isolated, cannot participate in consensus, bridge halted**

**Finding MED-VAL-5 (Rate Limiter Budget Drain):**
The rate limiter deducts budget BEFORE consensus completes. An attacker can:
1. Submit many valid-looking unlock requests
2. Each request consumes rate limit budget during consensus
3. Even if consensus fails, the budget is consumed
4. Legitimate requests are blocked until the daily limit resets

**Finding MED-VAL-6 (nodeId Spoofing):**
Consensus attestations do not cryptographically bind `nodeId` to the attesting validator's identity. An attacker can spoof attestations with fake nodeIds, degrading consensus liveness.

**Finding MED-VAL-8 (Missing Event Discriminator):**
Solana watcher does not check event discriminators, potentially processing non-bridge events. Mitigated by PDA derivation checks.

**Finding VAL-10 (Unbounded processedTransfers):**
The `processedTransfers` Set grows without bound. Over time, memory usage increases linear with transaction count, eventually causing OOM and validator crash.

---

### Category 10: Economic Attacks — ⚠️ EXPLOITABLE

**Finding CRIT-3 (Front-Running ZK Mints):**
As described in Category 1, the `verifyAndMint` function's unbound `recipientAddress` parameter enables **guaranteed front-running** of every ZK-path deposit. This is not probabilistic — the attacker can observe the mempool and always steal the deposit.

**Finding HIGH-VAL-4 (Fee Calculation Consensus Break):**
The fee calculator uses `BigInt(Math.floor(Number(amountLamports) * feeRate))` — converting a `BigInt` to `Number` (lossy for values > 2^53), multiplying by a float, then converting back. Different validators may compute different fee amounts for the same transaction due to floating-point non-determinism, breaking consensus.

**Finding LOW-3 (Rolling 24h Window Edge Case):**
The daily outflow circuit breaker uses a rolling 24-hour window. Transactions near the window boundary could be counted twice or not at all, allowing slightly more outflow than intended.

**Finding HIGH-VAL-3 (Rate Limiter State Lost on Restart):**
Rate limiter state is stored in memory only. Restarting a validator node resets all daily limits to zero, allowing the restarted validator to approve transactions that exceed the intended daily rate.

---

## FINDINGS BY SEVERITY

### 🔴 CRITICAL — Funds Can Be Stolen (7 findings)

| ID | Component | Finding | Impact |
|----|-----------|---------|--------|
| CRIT-1 | Solana `unlock.rs` | Unvalidated `remaining_accounts` — forged validator accounts | **100% vault drain** |
| CRIT-2 | Solana `submit_checkpoint.rs` | Same forged accounts bug in checkpoint submission | Arbitrary Merkle roots, fake deposits proven |
| CRIT-3 | DCC `zk_verifier.ride` | `recipientAddress` not bound to ZK proof's `recipient` | Front-run any ZK deposit, steal tokens |
| CRIT-4 | DCC `zk_bridge.ride` | Duplicate pubkeys in `committeeMint` signature loop | Single key compromise → unlimited minting |
| CRIT-5 | DCC `bridge_controller.ride` | Same duplicate pubkey bug in validator signatures | Single key compromise → bridge takeover |
| CRIT-6 | DCC `bridge_controller.ride` | Missing `@Verifier` annotation | Deployer key can rewrite all state |
| CRIT-7 | Validator `main.ts` / `engine.ts` | Timestamp mismatch in unlock message | All DCC→SOL unlocks broken |

### 🟠 HIGH — Significant Vulnerabilities (11 findings)

| ID | Component | Finding | Impact |
|----|-----------|---------|--------|
| HIGH-1 | Solana `unlock.rs` | Daily outflow not committed for scheduled unlocks | Circuit breaker bypassed |
| HIGH-2 | Solana `unlock.rs` | `execute_scheduled_unlock` has no circuit breaker | Multiple large unlocks same day |
| HIGH-3 | Solana `update_config.rs` | Instant authority transfer, no timelock | Admin key theft → instant takeover |
| HIGH-5 | DCC `zk_bridge.ride` | `totalMinted` not updated for pending mints | Supply tracking incorrect |
| HIGH-6 | DCC `bridge_controller.ride` | `totalBurned` not updated for multi-token burns | Supply tracking incorrect |
| HIGH-7 | DCC `zk_verifier.ride` | Admin can replace verification key (VK) | Backdoored VK accepts any proof |
| HIGH-8 | DCC `zk_verifier.ride` | Admin can redirect cross-contract calls | Bypass legitimate verifier |
| ZK-1 | `keccak256.circom` | Custom unaudited Keccak-256 (3.5M constraints) | Potential soundness issue |
| VAL-2 | Validator `transport.ts` | P2P peer_list injection without auth | Eclipse attack → consensus halt |
| VAL-3 | Validator rate limiter | State stored in memory only | Restart resets daily limits |
| VAL-4 | Validator fee calculator | Lossy BigInt↔Number↔float conversion | Cross-validator fee disagreement |

### 🟡 MEDIUM — Notable Issues (13 findings)

| ID | Component | Finding |
|----|-----------|---------|
| MED-1 | Solana `deposit.rs` | SPL deposit missing DCC address validation |
| MED-2 | Solana checkpoint | Resume after pause has no timelock |
| MED-3 | Solana checkpoint | Removed members permanently brick PDA slots |
| MED-4 | Solana `update_config.rs` | `large_withdrawal_delay` can be set to 0 |
| MED-5 | Solana `update_config.rs` | `min_validators` can be set to 1 |
| VULN-9 | DCC Contract B + Controller | No timelock on unpause |
| VULN-10 | DCC contracts | Single-step admin transfer (no 2-phase) |
| VULN-11 | DCC `wsol_token.ride` | Verifier address/pubkey format ambiguity |
| VULN-12 | DCC utils | `intToLE8` integer overflow for negative values |
| VAL-5 | Validator rate limiter | Budget consumed before consensus completes |
| VAL-6 | Validator consensus | nodeId spoofing in attestations |
| VAL-7 | Validator DCC watcher | Trusts single node (no multi-node verification) |
| VAL-8 | Validator Solana watcher | Missing event discriminator check |

### 🟢 LOW — Minor Issues (7 findings)

| ID | Component | Finding |
|----|-----------|---------|
| LOW-1 | Solana vault | `event_index` u32 truncation after ~4B events |
| LOW-2 | Solana vault | `total_locked` never decremented on unlock |
| LOW-3 | Solana vault | Rolling 24h window boundary double-count |
| VULN-13 | DCC `bridge_controller.ride` | Burn replay protection is write-only (unchecked) |
| VULN-14 | DCC utils | `fieldElementToInt32` identical to `fieldElementToInt` |
| VAL-9 | Validator transport | No TLS on P2P connections by default |
| VAL-10 | Validator | `processedTransfers` Set grows unbounded → OOM |

---

## THEORETICAL ATTACK VECTORS

### T-1: Trusted Setup Compromise (Groth16)
The ZK system uses Groth16 which requires a trusted setup ceremony. If the toxic waste from the phase-1 or phase-2 ceremony was not properly destroyed, an attacker with the toxic waste can forge proofs for arbitrary public inputs. **Mitigation:** The ceremony must have been performed with sufficiently many independent participants.

### T-2: BN128 Curve Weakness
The ZK proofs operate on the BN128 (alt_bn128) curve. While currently considered secure, the estimated security level is ~100 bits rather than 128 bits due to advances in NFS attacks on the embedding degree. A well-funded nation-state attacker in the future may be able to break BN128 proofs directly.

### T-3: Validator Collusion
If `min_validators` validators collude, they can approve arbitrary unlocks on Solana or arbitrary mints on DCC. This is by design (threshold trust assumption), but the fact that `min_validators` can be set to 1 (MED-5) dramatically reduces the collusion barrier.

### T-4: Solana Reorganization
A deep Solana reorganization could revert a finalized deposit event after the bridge has already minted wrapped tokens on DCC. The bridge would then have minted tokens backed by a reverted deposit. **Mitigation:** Wait for sufficient slot confirmations before bridging.

### T-5: DCC Node Compromise
The DCC watcher trusts a single node (VAL-7). If that node is compromised, it can feed fabricated burn events to the validator, causing the validator to initiate unlocks for burns that never happened.

### T-6: Time-of-Check to Time-of-Use (TOCTOU)
Between the time a validator checks a deposit on Solana and the time it signs an attestation, the Solana state could change (e.g., account closed). The bridge does not re-verify at execution time.

---

## HARDENING RECOMMENDATIONS

### Priority 1 — Must Fix Before Production (Critical)

**R-1: Validate `remaining_accounts` On-Chain (CRIT-1, CRIT-2)**
```rust
// In unlock.rs and submit_checkpoint.rs:
for account in ctx.remaining_accounts.iter() {
    // Verify account is owned by the bridge program
    require!(account.owner == ctx.program_id, BridgeError::InvalidValidatorAccount);
    
    // Deserialize and verify the account discriminator
    let data = account.try_borrow_data()?;
    require!(data.len() >= 8, BridgeError::InvalidAccountData);
    require!(&data[..8] == ValidatorRecord::DISCRIMINATOR, BridgeError::InvalidDiscriminator);
    
    // Verify the validator is in the active set
    let validator = ValidatorRecord::try_deserialize(&mut &data[..])?;
    require!(validator.is_active, BridgeError::ValidatorNotActive);
    
    // Verify PDA derivation
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[b"validator", validator.pubkey.as_ref()],
        ctx.program_id,
    );
    require!(account.key() == expected_pda, BridgeError::InvalidValidatorPDA);
}
```

**R-2: Bind `recipientAddress` to ZK Proof (CRIT-3)**
```ride
# In zk_verifier.ride verifyAndMint:
let proofRecipient = publicInputs[RECIPIENT_INDEX]  # extract from proof
let callerRecipient = toBytes(recipientAddress)
if (proofRecipient != callerRecipient) then throw("recipient mismatch") else ...
```

**R-3: Deduplicate Public Keys in Signature Loops (CRIT-4, CRIT-5)**
```ride
# Before the signature verification loop:
func hasDuplicates(keys: List[ByteVector]) = {
    let unique = removeDuplicates(keys)  # or manual set check
    size(unique) != size(keys)
}
if (hasDuplicates(pubkeys)) then throw("duplicate public key") else ...
```

**R-4: Add `@Verifier` to Bridge Controller (CRIT-6)**
```ride
@Verifier(tx)
func verify() = {
    match tx {
        case inv: InvokeScriptTransaction => true  # Only allow invocation, not DataTransaction
        case _ => sigVerify(tx.bodyBytes, tx.proofs[0], adminPublicKey)
    }
}
```

**R-5: Fix Timestamp Mismatch in Unlock Flow (CRIT-7)**
```typescript
// In submitUnlockToSolana — use the SAME timestamp from consensus:
const message = buildUnlockMessage({
    ...request,
    timestamp: request.timestamp,  // NOT Date.now()
});
```

### Priority 2 — Should Fix (High)

**R-6:** Update circuit breaker to increment daily outflow counter when scheduling large unlocks (HIGH-1).

**R-7:** Add circuit breaker check to `execute_scheduled_unlock_handler` (HIGH-2).

**R-8:** Implement 2-step authority transfer with timelock (HIGH-3): `propose_authority` → wait 48h → `accept_authority`.

**R-9:** Replace admin-updatable VK with an immutable or timelocked VK contract (HIGH-7, HIGH-8).

**R-10:** Authenticate P2P peer_list messages with validator signatures (VAL-2).

**R-11:** Persist rate limiter state to disk or use a shared store (VAL-3).

**R-12:** Fix fee calculation to use pure integer arithmetic (VAL-4):
```typescript
// Instead of: BigInt(Math.floor(Number(amountLamports) * feeRate))
// Use: (amountLamports * BigInt(feeRateBps)) / BigInt(10000)
```

**R-13:** Replace custom Keccak-256 with audited vocdoni circomlib implementation, or add NIST FIPS-202 test vectors (ZK-1).

### Priority 3 — Should Improve (Medium)

**R-14:** Add DCC address format validation on Solana deposits (MED-1).
**R-15:** Add timelock to checkpoint resume and unpause operations (MED-2, VULN-9).
**R-16:** Enforce minimum `large_withdrawal_delay` > 0 and `min_validators` ≥ 3 (MED-4, MED-5).
**R-17:** Implement 2-phase admin transfer across all contracts (VULN-10).
**R-18:** Add multi-node verification for DCC watcher (VAL-7).
**R-19:** Add event discriminator checks to Solana watcher (VAL-8).
**R-20:** Bind nodeId to validator signing key in consensus (VAL-6).

---

## SECURITY ASSUMPTIONS THAT MUST REMAIN TRUE

| # | Assumption | If Violated |
|---|-----------|-------------|
| A-1 | Groth16 trusted setup toxic waste was destroyed | Attacker can forge arbitrary ZK proofs |
| A-2 | BN128 curve remains computationally secure | All ZK proofs can be broken |
| A-3 | Fewer than `min_validators` validators are compromised | Attacker controls unlock/minting |
| A-4 | Admin/authority keys are not compromised | VK replacement, config changes, state corruption |
| A-5 | DCC deployer key is secure | Complete bridge state manipulation via DataTransactions |
| A-6 | Solana and DCC nodes are honest (or sufficient redundancy) | Fake events injected into bridge |
| A-7 | P2P network is not fully partitioned | Consensus halts, bridge stops |
| A-8 | System clocks are approximately synchronized | Timestamp mismatches break signatures |
| A-9 | `min_validators` is set to ≥ 3 | Single point of failure |
| A-10 | Circuit breaker thresholds are set to meaningful values | Large withdrawals unrestricted |

---

## EXPLOIT PRIORITIZATION — ATTACKER'S PLAYBOOK

If I were attacking this bridge today, I would execute in this order:

1. **CRIT-1 — Vault Drain (10 minutes):** Generate fake validator accounts, forge signatures, submit unlock. Drain the entire Solana vault. Cost: ~0.01 SOL in transaction fees.

2. **CRIT-3 — Front-Run ZK Mints (ongoing):** Set up a mempool watcher on DCC. Intercept every `verifyAndMint` transaction. Replace recipient. Steal every future ZK-path deposit indefinitely.

3. **CRIT-4 — Unlimited DCC Minting (if any committee key leaked):** Use a single compromised committee key repeated N times to mint unlimited wrapped tokens. Sell on DEX before anyone notices.

4. **CRIT-6 — Bridge Controller Takeover (if deployer key available):** Issue DataTransactions to add attacker as validator, reset replay protection, mint unlimited tokens.

5. **CRIT-2 — Forge Checkpoints (10 minutes):** Submit fake Merkle roots. Combined with the ZK path, create proofs for deposits that never happened.

---

## CONCLUSION

This bridge contains **multiple independently exploitable critical vulnerabilities**, any one of which results in total loss of funds. The most severe (CRIT-1) requires no special access or key compromise — any anonymous attacker can drain the entire vault in a single transaction.

**The bridge must NOT handle real funds until at minimum CRIT-1 through CRIT-7 are patched, tested, and independently audited.**

Additional recommendations:
- Engage a professional Solana security auditor (Neodyme, OtterSec, or equivalent) for the Anchor programs
- Engage a RIDE/Waves specialist auditor for the DCC contracts
- Conduct a fresh trusted setup ceremony with public participation for the Groth16 circuit
- Implement a bug bounty program before mainnet launch
- Deploy with conservative circuit breaker limits and admin multisig (not single key)

---

*Report generated by red team security analysis. All findings should be verified independently before remediation.*
