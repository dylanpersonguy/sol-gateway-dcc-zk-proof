# FORMAL VERIFICATION REPORT

## SOL-Gateway-DCC ZK Bridge — Protocol Invariant Analysis

**Date:** March 5, 2026  
**Scope:** Full cross-chain state machine: Solana programs, DCC RIDE contracts, ZK circuits, validator consensus  
**Method:** Manual formal verification — state extraction, transition modeling, invariant checking, symbolic attack analysis  
**Classification:** 1 NEW INVARIANT VIOLATION FOUND (Serialization Mismatch), 7/8 invariants HOLD under stated assumptions

---

## TABLE OF CONTENTS

1. [System State Model](#1-system-state-model)
2. [State Transitions](#2-state-transitions)
3. [Invariant Verification](#3-invariant-verification)
4. [Edge Case Analysis](#4-edge-case-analysis)
5. [Symbolic Attack Analysis](#5-symbolic-attack-analysis)
6. [Serialization Consistency](#6-serialization-consistency)
7. [Property-Based Tests](#7-property-based-tests)
8. [Findings & Required Fixes](#8-findings--required-fixes)
9. [Assumptions](#9-assumptions)
10. [Additional Invariants](#10-additional-invariants)

---

## 1. SYSTEM STATE MODEL

### 1.1 Solana — Bridge Vault (`sol-bridge-lock`)

#### BridgeConfig (PDA: `[b"bridge_config"]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `authority` | Pubkey | Controls config updates |
| `guardian` | Pubkey | Emergency pause authority |
| `paused` | bool | Global kill switch — blocks deposits and unlocks |
| `global_nonce` | u64 | Monotonic counter — used for event_index on deposit |
| `total_locked` | u64 | Cumulative SOL locked (lamports) — incremented on deposit, decremented on unlock |
| `total_unlocked` | u64 | Cumulative SOL unlocked (lamports) |
| `validator_count` | u8 | Number of registered validators |
| `min_validators` | u8 | Minimum signatures required for unlock (enforced ≥ 3) |
| `max_validators` | u8 | Maximum validator slots |
| `min_deposit` / `max_deposit` | u64 | Deposit bounds |
| `max_daily_outflow` | u64 | Circuit breaker ceiling |
| `current_daily_outflow` | u64 | Rolling outflow counter (resets per aligned 24h window) |
| `last_daily_reset` | i64 | Timestamp of last window boundary |
| `max_unlock_amount` | u64 | Per-tx unlock ceiling |
| `large_withdrawal_delay` | i64 | Timelock seconds for large unlocks (enforced ≥ 300) |
| `large_withdrawal_threshold` | u64 | Amount threshold for "large" classification |
| `dcc_chain_id` / `solana_chain_id` | u32 | Domain separation identifiers |
| `resume_requested_at` | i64 | 2-phase resume timelock timestamp |
| `resume_delay_seconds` | i64 | Required delay for resume (≥ 300s) |
| `pending_authority` | Pubkey | HIGH-3 fix: staged authority change |
| `authority_transfer_requested_at` | i64 | Timestamp of pending authority proposal |

#### DepositRecord (PDA: `[b"deposit", transfer_id]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `transfer_id` | [u8; 32] | Unique per-deposit identifier (hash of sender ‖ nonce) |
| `message_id` | [u8; 32] | Keccak256 of canonical preimage — links to ZK circuit |
| `sender` | Pubkey | Depositor |
| `recipient_dcc` | [u8; 32] | DCC destination address |
| `amount` | u64 | Deposit amount in lamports |
| `nonce` | u64 | Per-user monotonic nonce |
| `slot` | u64 | Solana slot at deposit time |
| `event_index` | u64 | Global event counter (LOW-1: widened from u32) |
| `timestamp` | i64 | Unix timestamp |
| `asset_id` | Pubkey | SPL mint or native SOL sentinel |
| `processed` | bool | Whether minted on DCC |

#### UnlockRecord (PDA: `[b"unlock", transfer_id]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `transfer_id` | [u8; 32] | From DCC burn event |
| `recipient` | Pubkey | Solana recipient |
| `amount` | u64 | Unlock amount |
| `executed` | bool | Whether SOL has been transferred |
| `scheduled_time` | i64 | For large withdrawals: earliest execution time |
| `burn_tx_hash` | [u8; 32] | DCC burn transaction hash |

#### UserState (PDA: `[b"user_state", user_pubkey]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `next_nonce` | u64 | Strictly monotonic — guarantees unique transfer_ids |
| `total_deposited` | u64 | Lifetime deposit counter |

#### ValidatorEntry (PDA: `[b"validator", validator_pubkey]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `pubkey` | Pubkey | Signing key |
| `active` | bool | Whether currently in active set |

### 1.2 Solana — Checkpoint Registry (`checkpoint_registry`)

#### CheckpointConfig (PDA: `[b"checkpoint_config"]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `paused` | bool | Blocks checkpoint submissions |
| `next_checkpoint_id` | u64 | Monotonic checkpoint counter |
| `last_checkpoint_slot` | u64 | Ordering constraint — new checkpoints must reference later slots |
| `min_signatures` | u8 | Required committee signatures for checkpoint submission |
| `timelock_seconds` | i64 | Delay before checkpoint becomes active |
| `checkpoint_ttl_slots` | u64 | Checkpoint expiry duration |
| `resume_requested_at` | i64 | MED-2 fix: 2-phase resume |

#### CheckpointEntry (PDA: `[b"checkpoint", checkpoint_id.to_le_bytes()]`)

| Variable | Type | Security Role |
|----------|------|---------------|
| `commitment_root` | [u8; 32] | Merkle root of deposit events |
| `status` | Pending/Active/Expired | Lifecycle state |
| `activates_at` | i64 | Timelock expiry time |
| `expires_at_slot` | u64 | Expiry slot |
| `signature_count` | u8 | Committee signatures collected |

### 1.3 DCC — ZK Bridge (`zk_bridge.ride`)

| Key Pattern | Type | Security Role |
|-------------|------|---------------|
| `admin` | String | Admin address |
| `guardian` | String | Emergency authority |
| `paused` | Boolean | Global kill switch |
| `sol_asset_id` | String | wSOL DCC asset ID |
| `total_minted` | Integer | Cumulative wrapped tokens minted (DCC 8-decimals) |
| `total_burned` | Integer | Cumulative wrapped tokens burned |
| `global_nonce` | Integer | Monotonic counter |
| `processed_{messageId}` | Boolean | Replay protection — **IMMUTABLE** (no DataTransaction) |
| `burn_{burnId}` | String | Burn record (sender, recipient, amount, height, timestamp) |
| `burn_nonce_{address}` | Integer | Per-user burn nonce |
| `hourly_minted` / `daily_minted` | Integer | Rate limit counters |
| `hourly_reset_height` / `daily_reset_height` | Integer | Window boundaries |
| `pending_large_{messageId}` | Boolean | Pending large tx flag |
| `pending_large_height_{messageId}` | Integer | Queue time for delay |
| `pending_recipient_{messageId}` | String | Recipient for pending mint |
| `pending_amount_{messageId}` | Integer | Amount for pending mint |
| `committee_{addr}` | Boolean | Committee member flag |
| `committee_size` | Integer | Number of committee members |
| `approval_threshold` | Integer | Required signature count |
| `unpause_requested_at` | Integer | 2-phase unpause height |

### 1.4 DCC — ZK Verifier (`zk_verifier.ride`)

| Key Pattern | Type | Security Role |
|-------------|------|---------------|
| `groth16_vk` | Binary | Verifying key — **IMMUTABLE** after first set (HIGH-7 fix) |
| `groth16_vk_set` | Boolean | Set once, never reset |
| `bridge_core_address` | String | Contract A address — **IMMUTABLE** after init (HIGH-8 fix) |
| `checkpoint_{id}_root` | Binary | Merkle root |
| `checkpoint_{id}_active` | Boolean | Whether checkpoint is usable |
| `checkpoint_{id}_height` | Integer | Registration height (for freshness) |
| `zk_processed_{messageId}` | Boolean | ZK-specific replay protection |
| `proposal_{id}_*` | Various | Checkpoint proposal state |
| `next_checkpoint_id` | Integer | Monotonic counter |

### 1.5 DCC — Bridge Controller (`bridge_controller.ride`)

| Key Pattern | Type | Security Role |
|-------------|------|---------------|
| `processed_{transferId}` | Boolean | Replay protection for committee-signed mints |
| `total_minted` / `total_burned` | Integer | Global supply counters (HIGH-6 fix) |
| `token_{splMint}_total_minted` | Integer | Per-token supply counters |
| `token_{splMint}_total_burned` | Integer | Per-token burn counters |
| `validator_active_{pubkey}` | Boolean | Validator registry |
| `validator_count` / `min_validators` | Integer | Validator management |
| `daily_minted` / `daily_reset_height` | Integer | Rate limit |
| `pending_large_{transferId}` | Boolean | Large tx delay |
| `burn_{burnId}` | String | Burn records (VULN-13 fix: checked before write) |

### 1.6 Validator (Off-Chain State)

| Variable | Location | Security Role |
|----------|----------|---------------|
| `processedTransfers` | `engine.ts` Set<string> | Local replay dedup (capped at 100K, VAL-10) |
| `pendingConsensus` | `engine.ts` Map<string, PendingConsensus> | Active consensus rounds |
| `registeredValidators` | `engine.ts` Set<string> | Whitelist for attestation acceptance |
| `dailyOutflow` | `rate-limiter.ts` bigint | Disk-persisted daily counter (VAL-3 fix) |
| `windowStart` | `rate-limiter.ts` number | Window start timestamp |
| `peers` | `transport.ts` Map | Authenticated peer connections |

---

## 2. STATE TRANSITIONS

### 2.1 Deposit Flow (SOL → DCC)

```
T1: DEPOSIT(sender, amount, recipient_dcc)
  Pre:   !paused ∧ min_deposit ≤ amount ≤ max_deposit ∧ recipient_dcc ≠ 0
  Post:  vault_balance += amount
         total_locked += amount
         global_nonce += 1
         DepositRecord[transfer_id] created
         UserState.next_nonce += 1
         BridgeDeposit event emitted
```

### 2.2 Checkpoint Submission

```
T2: SUBMIT_CHECKPOINT(commitment_root, slot, signatures[])
  Pre:   !paused ∧ slot > last_checkpoint_slot ∧ signatures.len ≥ min_signatures
         ∧ all signatures valid ∧ validator PDAs validated (CRIT-1/2 fix)
  Post:  CheckpointEntry[next_id] created (status=Pending, activates_at=now+timelock)
         next_checkpoint_id += 1
         last_checkpoint_slot = slot
```

### 2.3 ZK Proof Verification & Mint (Phase 2)

```
T3: VERIFY_AND_MINT(proof, inputs, checkpointId, ...)
  Pre:   !paused ∧ vk_set ∧ checkpoint[id].active ∧ checkpoint fresh
         ∧ !zk_processed[messageId]
         ∧ localMessageId == proofMessageId (RIDE recomputes)
         ∧ proofAmount == amount ∧ proofRecipient == recipient
         ∧ proofRoot == storedRoot ∧ proofVersion == 1
         ∧ groth16Verify(vk, proof, inputs) == true
         ∧ recipientAddress matches proof recipient (CRIT-3 fix)
  Post:  zk_processed[messageId] = true
         Cross-contract invoke → zkMintAuthorized(...)
         totalMinted += mintAmount
         hourly/daily counters updated
         wSOL Reissued & transferred (or queued if large)
```

### 2.4 Committee Mint (Phase 1)

```
T4: COMMITTEE_MINT(transferId, recipient, amount, solSlot, signatures[], pubkeys[])
  Pre:   !paused ∧ !processed[transferId] ∧ amount in [min, max]
         ∧ no duplicate pubkeys (CRIT-4 fix)
         ∧ validSigs ≥ threshold ∧ each signer is committee member
         ∧ hourly/daily limits not exceeded
  Post:  processed[transferId] = true
         totalMinted += mintAmount
         wSOL Reissued & transferred (or queued if large, with totalMinted updated per HIGH-5)
```

### 2.5 Burn (DCC → SOL direction, DCC side)

```
T5: BURN(solRecipient)
  Pre:   !paused ∧ payment is wSOL ∧ amount ≥ minMintAmount
  Post:  wSOL burned (supply decreases)
         totalBurned += amount (HIGH-6 fix: global counter updated)
         burn_nonce[caller] += 1
         burnRecord[burnId] created (VULN-13: replay checked)
         processed[burnMessageId] = true
```

### 2.6 Unlock (SOL release on Solana after DCC burn)

```
T6: UNLOCK(transfer_id, recipient, amount, attestations[])
  Pre:   !paused ∧ dcc_chain_id matches ∧ !expired
         ∧ amount ≤ max_unlock_amount
         ∧ attestations.len ≥ min_validators ∧ no dup validators
         ∧ each validator PDA validated (CRIT-1 fix)
         ∧ ed25519 signatures verified via introspection
         ∧ daily_outflow + amount ≤ max_daily_outflow
  Post:  if large: scheduled (daily_outflow committed per HIGH-1 fix), return
         else: vault_balance -= amount
               total_unlocked += amount
               total_locked -= amount (LOW-2 fix)
               UnlockRecord[transfer_id] created (executed=true)
```

### 2.7 Execute Scheduled Unlock

```
T7: EXECUTE_SCHEDULED_UNLOCK(transfer_id)
  Pre:   !paused ∧ !already_executed ∧ now ≥ scheduled_time
         ∧ daily_outflow + amount ≤ max_daily_outflow (HIGH-2 fix)
  Post:  vault_balance -= amount
         total_unlocked += amount
         total_locked -= amount (LOW-2 fix)
         current_daily_outflow += amount
         executed = true
```

### 2.8 Emergency Pause

```
T8: EMERGENCY_PAUSE()
  Pre:   caller is admin OR guardian
  Post:  paused = true
```

### 2.9 Timelocked Resume

```
T9a: REQUEST_RESUME()
  Pre:   caller is admin ∧ paused
  Post:  resume_requested_at = now

T9b: EXECUTE_RESUME()
  Pre:   caller is admin ∧ paused ∧ now - resume_requested_at ≥ delay
  Post:  paused = false ∧ resume_requested_at deleted
```

### 2.10 Configuration Updates

```
T10: UPDATE_CONFIG(params)
  Pre:   caller is authority
  Post:  config fields updated with guards:
         min_validators ≥ 3 (MED-5)
         large_withdrawal_delay ≥ 300 (MED-4)
         new_authority → pending + 24h timelock (HIGH-3)
```

### 2.11 Auto-Pause (Anomaly Detection)

```
T11: AUTO_PAUSE (triggered within T3/T4)
  Pre:   hourlyMinted > anomalyThresholdPerHour
  Post:  paused = true (atomically within mint tx)
```

---

## 3. INVARIANT VERIFICATION

### INVARIANT 1: Wrapped Supply ≤ Locked Assets

**Statement:** `totalMinted_DCC - totalBurned_DCC ≤ vault_balance_SOL`

**Analysis:**

For this invariant, we must track all paths that increment `totalMinted` and all paths that decrement `vault_balance`.

**Minting paths (increase outstanding):**
- `committeeMint` (T4): increments `totalMinted` by `mintAmount = amount / 10` (decimal conversion 9→8)
- `zkMintAuthorized` (via T3): same formula
- Both paths update `totalMinted` even for pending large mints (HIGH-5 fix)

**Unlocking paths (decrease vault):**
- Immediate unlock (T6): decreases vault via CPI transfer
- Scheduled unlock (T7): same

**Correctness conditions:**
1. Each mint MUST correspond to a real deposit (enforced by committee signatures or ZK proof)
2. Each unlock MUST correspond to a real burn (enforced by validator attestations)
3. Deposits lock SOL atomically (T1: CPI transfer → total_locked increment in same tx)
4. The decimal conversion is consistent: Solana 9 decimals → DCC 8 decimals (÷10)

**Potential violation paths:**
- ~~CRIT-1 (forged validators) → FIXED: PDA validation~~ ✅
- ~~CRIT-3 (front-running ZK mints) → FIXED: recipient binding~~ ✅
- ~~CRIT-4/5 (duplicate pubkeys) → FIXED: dedup check~~ ✅
- Re-minting with same message: blocked by `processed_` / `zk_processed_` entries
- VK replacement (backdoor proofs): blocked by `vk_frozen` immutability (HIGH-7)
- DataTransaction state corruption: blocked by `@Verifier` (CRIT-6)

**Verdict: HOLDS** under the assumption that:
- (A-1) Groth16 trusted setup is secure
- (A-2) BN128 curve is secure
- (A-3) Fewer than `min_validators` validators are compromised
- (A-4) Admin keys are not compromised (for committee mint path)

**Residual risk:** The `cancelPendingMint` function on DCC deletes the pending records but does NOT decrement `totalMinted` (which was pre-incremented per HIGH-5). This means cancelling a pending large mint permanently inflates `totalMinted` by the cancelled amount, making `outstanding = totalMinted - totalBurned` larger than the actual circulating supply. This does NOT violate the invariant (the vault still has the locked SOL), but it makes the invariant check less tight.

---

### INVARIANT 2: Each Message ID Processed At Most Once

**Statement:** `∀ messageId: processed(messageId) never transitions from true → false`

**Analysis:**

Replay protection storage:
- **Solana DepositRecord PDA:** `seeds = [b"deposit", transfer_id]` — Anchor `init` constraint fails if PDA exists
- **Solana UnlockRecord PDA:** `seeds = [b"unlock", transfer_id]` — same `init` guard
- **DCC zk_bridge:** `processed_{messageId}` boolean entry, checked before mint
- **DCC zk_verifier:** `zk_processed_{messageId}` boolean entry, checked before verify
- **DCC bridge_controller:** `processed_{transferId}` boolean entry, checked before mint
- **DCC burn records:** `burn_{burnId}` string entry existence check (VULN-13 fix)

**Can processed entries be reset?**
- **Solana:** PDA-based, cannot be re-initialized (Anchor discriminator + init)
- **DCC:** `@Verifier` blocks ALL DataTransactions on all three RIDE contracts → entries cannot be deleted

**Validator off-chain dedup:**
- `processedTransfers` Set in engine.ts — capped at 100K (VAL-10), oldest evicted
- This is a performance optimization only; on-chain replay protection is the ultimate guard

**Verdict: HOLDS** ✅  
The PDA-based replay protection on Solana is unforgeable. The `@Verifier`-protected boolean entries on DCC are immutable. Even if the validator's in-memory Set evicts old entries, re-processing is blocked on-chain.

---

### INVARIANT 3: Withdrawal Only After Valid Burn Proof

**Statement:** `∀ unlock: a valid DCC burn event preceded it`

**Analysis:**

The unlock flow (T6) requires:
1. M-of-N validator Ed25519 signatures over the canonical unlock message
2. Each validator must be an active, PDA-validated entry (CRIT-1 fix)
3. The message includes `burn_tx_hash` binding the unlock to a specific DCC burn
4. The unlock creates a PDA `[b"unlock", transfer_id]` preventing replay

Validators sign unlocks only after observing the burn event on DCC:
- `dcc-watcher.ts` monitors the DCC chain for burn events
- Event discriminator validation: SHA-256 discriminator check (VAL-8 fix)
- Multi-node verification for DCC events (VAL-7 fix)

**Can an unlock occur without a burn?**
Only if ≥ `min_validators` (≥ 3) collude to sign a fabricated burn_tx_hash. The on-chain contract has no way to independently verify the DCC burn occurred — it relies entirely on validator attestations.

**Verdict: HOLDS** under assumption A-3 (honest majority among validators)

---

### INVARIANT 4: Invalid ZK Proofs Must Never Change Contract State

**Statement:** `∀ proof: ¬groth16Verify(vk, proof, inputs) ⟹ no state change`

**Analysis:**

In `verifyAndMint` (zk_verifier.ride):
1. All pre-checks (paused, vk_set, checkpoint active, checkpoint fresh, replay) execute first
2. RIDE recomputes `localMessageId` from caller parameters
3. Extracts proof values from public inputs
4. Cross-validates: localMessageId == proofMessageId, amounts match, recipients match, root matches
5. **Only then** calls `bn256Groth16Verify_8inputs(vk, proof, inputs)`
6. **Only if verification passes** does the cross-contract `invoke` to `zkMintAuthorized` occur
7. The only state change in the verifier itself is `zk_processed_[messageId] = true`, which occurs AFTER proof verification

**RIDE atomicity guarantee:** If `groth16Verify` returns false → `throw()` → entire transaction reverts, including any changes made before the throw.

**Verdict: HOLDS** ✅  
RIDE's atomic transaction model guarantees complete rollback on any failure in the callable chain.

---

### INVARIANT 5: Checkpoint Roots Cannot Be Substituted

**Statement:** `∀ checkpoint: root was committed by ≥ threshold committee members before becoming active`

**Analysis:**

**DCC checkpoint flow** (zk_verifier.ride):
1. `proposeCheckpoint`: committee member creates proposal, records root + slot
2. `approveCheckpoint`: additional members approve; at threshold, checkpoint activates
3. Both proposeCheckpoint and approveCheckpoint check `isCommitteeMember(callerPublicKey)`
4. Committee member identity uses `callerPublicKey` (DCC runtime-provided, cannot be spoofed)
5. Double-approval prevention: `keyProposalApproved(proposalId, addr)` checked per-member

**Solana checkpoint flow** (checkpoint_registry):
1. Same pattern with `submit_checkpoint` requiring committee signatures
2. CRIT-2 fix: `remaining_accounts` validated as legitimate committee member PDAs

**Can an attacker substitute a root?**
- They would need to compromise ≥ threshold committee members' signing keys
- Or forge committee member PDAs on Solana (blocked by CRIT-2 fix)
- DataTransaction root corruption blocked by `@Verifier` on DCC

**Verdict: HOLDS** under assumption that fewer than `threshold` committee members are compromised

---

### INVARIANT 6: Replay Protection Survives Restarts and Upgrades

**Statement:** Replay protection state persists across process restarts and contract upgrades

**Analysis:**

**On-chain (permanent):**
- Solana PDA accounts persist until explicitly closed (none of the instructions close deposit/unlock PDAs)
- DCC data entries persist in account state and cannot be deleted (DataTransaction blocked by @Verifier)

**Off-chain validator:**
- `processedTransfers` persisted to disk file (loaded on startup) — VAL-3 fix
- Rate limiter state persisted to disk — VAL-3 fix
- Even if disk file is lost, on-chain replay protection (PDAs, boolean entries) prevents double-processing

**Upgrade scenarios:**
- Solana program upgrade: PDAs persist (account data is independent of program bytecode)
- DCC contract upgrade (`SetScriptTransaction`): data entries persist (RIDE data storage is separate from script)
- But: a SetScript could deploy a new contract that reads stored data differently. Mitigated by `@Verifier` requiring deployer signature for SetScript.

**Verdict: HOLDS** ✅  
On-chain replay protection is persistent and independent of bytecode. Off-chain persistence is a defense-in-depth measure.

---

### INVARIANT 7: Paused Bridge Blocks All Mint and Withdraw Operations

**Statement:** `paused = true ⟹ no mint, burn, unlock, or checkpoint submission succeeds`

**Analysis:**

**Functions that check `paused`:**
| Function | Contract | Pause Check |
|----------|----------|-------------|
| `deposit` | sol-bridge-lock | `require!(!config.paused)` ✅ |
| `unlock` | sol-bridge-lock | `require!(!config.paused)` ✅ |
| `execute_scheduled_unlock` | sol-bridge-lock | `require!(!config.paused)` ✅ |
| `committeeMint` | zk_bridge.ride | `if (isPaused()) then throw` ✅ |
| `zkMintAuthorized` | zk_bridge.ride | `if (isPaused()) then throw` ✅ |
| `executePendingMint` | zk_bridge.ride | `if (isPaused()) then throw` ✅ |
| `burn` | zk_bridge.ride | `if (isPaused()) then throw` ✅ |
| `verifyAndMint` | zk_verifier.ride | `if (isPaused()) then throw` ✅ |
| `proposeCheckpoint` | zk_verifier.ride | `if (isPaused()) then throw` ✅ |
| `approveCheckpoint` | zk_verifier.ride | `if (isPaused()) then throw` ✅ |
| `mint` / `mintToken` | bridge_controller.ride | `if (isPaused()) then throw` ✅ |
| `burnToken` / `burn` | bridge_controller.ride | `if (isPaused()) then throw` ✅ |
| `executePendingMint` | bridge_controller.ride | `if (isPaused()) then throw` ✅ |

**Resume requires timelock:**
- Solana: `request_resume` then wait `resume_delay_seconds ≥ 300`
- DCC (zk_bridge, zk_verifier, bridge_controller): `requestUnpause/requestResume` then wait `unpauseDelayBlocks = 100`

**Verdict: HOLDS** ✅  
All value-moving functions check the pause flag. Resume is timelocked on all chains.

---

### INVARIANT 8: Rate Limits Cap Maximum Extractable Value Per Window

**Statement:** `∀ time_window: outflow(window) ≤ max_daily_outflow`

**Analysis:**

**Solana unlock path:**
- Immediate unlocks: `current_daily_outflow += amount`, checked against `max_daily_outflow`
- Scheduled unlocks: `current_daily_outflow` committed at queue time (HIGH-1 fix)
- Execution: re-checked at execution time (HIGH-2 fix) with aligned window reset (LOW-3 fix)

**DCC mint path:**
- Hourly: `hourlyMinted + amount ≤ maxHourlyMint` (100 SOL equiv)
- Daily: `dailyMinted + amount ≤ maxDailyMint` (1000 SOL equiv)
- Single tx: `amount ≤ maxSingleMint` (50 SOL equiv)
- Auto-pause: `hourlyMinted > anomalyThresholdPerHour (200 SOL)` → paused = true

**Validator rate limiter:**
- `canConsume()` check before consensus (VAL-5 fix: no budget consumed pre-consensus)
- `consume()` only after consensus succeeds
- State persisted to disk (VAL-3 fix)

**Window boundary attack (LOW-3):**
- Fixed via aligned window reset: `last_daily_reset += (elapsed / day_seconds) * day_seconds`
- This prevents double-counting at window boundaries

**Can rate limits be bypassed?**
- Config update can change `max_daily_outflow` — requires authority signature
- DCC rate limits are compiled into the contract (constants), not admin-updatable
- But DCC `maxDailyMint` in bridge_controller is admin-updatable via `updateMaxDailyMint`

**Verdict: HOLDS** ✅ under assumption A-4 (admin keys secure)  
The circuit breaker is checked on both immediate and scheduled paths. Window boundaries are properly aligned.

---

## 4. EDGE CASE ANALYSIS

### E-1: Simultaneous Transactions

**Scenario:** Two deposits submitted in the same Solana slot.

**Analysis:** Each deposit uses a unique `transfer_id = hash(sender, nonce)`. Nonces are per-user and monotonically increasing. Even if two users deposit simultaneously, their transfer_ids differ. Same user submitting twice would fail: the second `init` PDA would find the PDA already exists.

**Result:** No invariant violated ✅

### E-2: Replay Attempts

**Scenario:** Attacker resubmits a previously successful mint/unlock transaction.

**Analysis:**
- Solana: PDA `[b"unlock", transfer_id]` already exists → `init` fails
- DCC: `processed_{messageId}` is `true` → `throw("Already processed")`
- ZK path: `zk_processed_{messageId}` is `true` → `throw("Already ZK-processed")`

**Result:** No invariant violated ✅

### E-3: Proof Submission Race Condition

**Scenario:** Two parties submit the same ZK proof simultaneously on DCC.

**Analysis:** DCC processes transactions sequentially per account. The first transaction sets `zk_processed_{messageId} = true`. The second finds it already set and reverts.

**Result:** No invariant violated ✅

### E-4: Mutated Message Payloads

**Scenario:** Attacker modifies fields of a valid mint message.

**Analysis:**
- Committee mint: message is `transferId|recipient|amount|solSlot` — signature verification fails if any byte changes
- ZK mint: message_id is Keccak256 of all fields — changing any field changes the hash, which won't match the proof

**Result:** No invariant violated ✅

### E-5: Expired Checkpoints

**Scenario:** Attacker uses an expired checkpoint to verify a proof.

**Analysis:** `verifyAndMint` checks `height - cpHeight > maxCheckpointAge (10080 blocks)`. Expired checkpoints are rejected. Additionally, `deactivateCheckpoint` can be called by anyone once `checkpointExpiryBlocks (1440)` have elapsed.

**Result:** No invariant violated ✅

### E-6: Partial System Failure — Validator Node Restart

**Scenario:** A validator restarts mid-consensus.

**Analysis:**
- `processedTransfers` loaded from disk on startup (if file exists)
- `rateLimiter` state loaded from disk (within 24h window)
- Pending consensus rounds in memory are lost → those transfers require re-initiation
- On-chain replay protection prevents double-processing if the transfer was already submitted

**Result:** No invariant violated ✅ (liveness temporarily degraded, safety preserved)

### E-7: Corrupted Relayer Inputs

**Scenario:** Malicious relayer provides fabricated deposit events.

**Analysis:**
- Solana watcher verifies event discriminators (VAL-8 fix: SHA-256 discriminator)
- Events are read from on-chain account data, not from untrusted off-chain sources
- DCC watcher uses multi-node verification (VAL-7 fix)
- Validators reach consensus before acting — single corrupted input is outvoted

**Result:** No invariant violated ✅ under assumption A-3

### E-8: cancelPendingMint After HIGH-5 Fix

**Scenario:** Admin cancels a pending large mint after `totalMinted` was pre-incremented.

**Analysis:**
- `cancelPendingMint` deletes pending records but does NOT decrement `totalMinted`
- This permanently inflates `totalMinted` by the cancelled amount
- The wSOL was never Reissued/transferred, so actual circulating supply is correct
- But `outstanding = totalMinted - totalBurned` overstates reality

**Risk Level:** Low. Does not enable theft (vault still holds the SOL). Creates accounting inaccuracy.

**Recommendation:** `cancelPendingMint` should decrement `totalMinted` by the cancelled amount.

---

## 5. SYMBOLIC ATTACK ANALYSIS

### Attacker Model

The attacker controls:
- Relayer/prover inputs (can submit arbitrary proofs)
- Transaction ordering (can front-run, sandwich, timing attacks)
- One or more (but < min_validators) validator nodes
- DCC mempool observation

### Attack 1: Forge Validator Accounts (CRIT-1)

**Pre-fix:** Attacker creates accounts with matching pubkey/active fields but not owned by program.  
**Post-fix:** PDA validation requires `acc.owner == program_id` AND `Pubkey::find_program_address` match AND discriminator match AND `active == true`.  
**Result:** ❌ BLOCKED. Attacker cannot create accounts at the correct PDA address without the program's private key.

### Attack 2: Front-Run ZK Mint (CRIT-3)

**Pre-fix:** Watch DCC mempool for `verifyAndMint`, copy proof, change `recipientAddress`.  
**Post-fix:** `recipientAddress` must match `recipient` bytes embedded in the ZK proof.  
**Result:** ❌ BLOCKED. The proof cryptographically binds the recipient. Changing the address violates the equality check.

### Attack 3: Duplicate Pubkey Signature Multiplication (CRIT-4/5)

**Pre-fix:** Submit same pubkey N times to meet M-of-N threshold with 1 key.  
**Post-fix:** FOLD-based pairwise duplicate detection rejects repeated keys.  
**Result:** ❌ BLOCKED.

### Attack 4: DataTransaction State Corruption (CRIT-6)

**Pre-fix:** Deployer key sends DataTransaction to delete `processed_` entries.  
**Post-fix:** `@Verifier` returns `false` for all DataTransactions on all three DCC contracts.  
**Result:** ❌ BLOCKED.

### Attack 5: Eclipse Attack via P2P Injection (VAL-2)

**Pre-fix:** Inject fake peer addresses to isolate validator.  
**Post-fix:** `peer_list` requires sender to be in authenticated `this.peers` map, capped at 50, address length < 256.  
**Result:** ❌ BLOCKED for unauthenticated peers. Partially mitigated for compromised authenticated peers (still capped at 50).

### Attack 6: Consensus Timestamp Manipulation (CRIT-7)

**Pre-fix:** `Date.now()` at submission ≠ `request.timestamp` at consensus → signature mismatch.  
**Post-fix:** `result.requestTimestamp` used consistently in both consensus and submission.  
**Result:** ❌ BLOCKED.

### Attack 7: Rate Limit Budget Drain (VAL-5)

**Pre-fix:** Flood valid-looking requests that consume rate limit during consensus, even if consensus fails.  
**Post-fix:** `canConsume()` (read-only) before consensus; `consume()` (mutating) only after success.  
**Result:** ❌ BLOCKED.

### Attack 8: nodeId Spoofing in Consensus (VAL-6)

**Pre-fix:** Attacker sends attestations with spoofed nodeIds.  
**Post-fix:** `receiveAttestation` verifies `nodeId === pubkeyHex`. Mismatch → rejected + `byzantine_detected`.  
**Result:** ❌ BLOCKED.

---

## 6. SERIALIZATION CONSISTENCY

### ⚠️ CRITICAL FINDING: event_index Width Mismatch (Post LOW-1 Fix)

The LOW-1 fix widened `event_index` from `u32` to `u64` in the Solana program. This introduced a **serialization inconsistency** across the three components that compute `message_id`:

| Component | event_index encoding | Preimage size |
|-----------|---------------------|---------------|
| **Solana** `deposit.rs` `compute_message_id` | `event_index.to_le_bytes()` = **8 bytes** (u64) | **185 bytes** |
| **DCC** `zk_verifier.ride` `computeMessageId` | `intToLE4(eventIndex)` = **4 bytes** | **181 bytes** |
| **ZK Circuit** `bridge_deposit.circom` | `event_index_bits[32]` = **4 bytes** (32 bits) | **181 bytes** (1448 bits) |

**Impact:** The Solana on-chain `message_id` computed after the LOW-1 fix uses a 185-byte preimage (8-byte event_index), while the RIDE verifier and ZK circuit both use 181-byte preimages (4-byte event_index). These produce **different Keccak256 hashes** even for identical input values.

**Consequence:**
- **Phase 2 (ZK minting) is BROKEN** for any deposit made after the LOW-1 fix deployment. The verifier's `localMessageId ≠ proofMessageId` check will always fail because the preimage sizes differ.
- **Phase 1 (committee minting) is UNAFFECTED** because `committeeMint` uses `transferId|recipient|amount|solSlot` message format, not `computeMessageId`.

**Stale test:** The Solana unit test at deposit.rs L295-299 asserts `total = 181` using `event_index(4)`, but the actual code writes 8 bytes. The test only checks arithmetic, not actual hash output.

**Required fix:** Either:
1. Update RIDE `computeMessageId` and ZK circuit to use 8-byte (64-bit) event_index encoding, OR
2. Revert Solana `compute_message_id` to use 4-byte LE for event_index in the preimage (keep storage as u64 but truncate for hashing)

### Other Serialization Fields — Consistent ✅

| Field | Solana | RIDE | ZK Circuit |
|-------|--------|------|------------|
| domain_sep | 17 bytes (`"DCC_SOL_BRIDGE_V1"`) | 17 bytes (`toBytes(domainSeparator)`) | 136 bits (17 bytes) |
| src_chain_id | 4 bytes LE (u32) | `intToLE4(srcChainId)` | 32 bits |
| dst_chain_id | 4 bytes LE (u32) | `intToLE4(dstChainId)` | 32 bits |
| src_program_id | 32 bytes | 32 bytes (param validated) | 256 bits |
| slot | 8 bytes LE (u64) | `intToLE8(slot)` | 64 bits |
| sender | 32 bytes | 32 bytes (param validated) | 256 bits |
| recipient | 32 bytes | 32 bytes (param validated) | 256 bits |
| amount | 8 bytes LE (u64) | `intToLE8(amount)` | 64 bits |
| nonce | 8 bytes LE (u64) | `intToLE8(nonce)` | 64 bits |
| asset_id | 32 bytes | 32 bytes (param validated) | 256 bits |

All fields are consistent across all three components EXCEPT `event_index`.

---

## 7. PROPERTY-BASED TESTS

The following property-based test suite verifies invariants under randomized adversarial inputs. See `tests/property-based-invariants.test.ts` for the runnable implementation.

```typescript
// Property-based test summary:
// - 10,000 simulations × 1,000 operations each = 10M operations
// - Random actions: deposit, mint, burn, unlock, replay attempts,
//   pause/resume, window resets, invalid amounts
// - Checked after every operation:
//   INV-1: outstanding_DCC * 10 ≤ vault_balance
//   INV-2: no transfer processed twice (Set enforcement)
//   INV-7: paused ⟹ all state-changing ops return false
//   INV-8: daily_outflow ≤ max_daily_outflow
```

### Test Categories

| Category | Operations | Invariants Checked |
|----------|-----------|-------------------|
| Random deposit/burn sequences | Deposit + mint, burn + unlock | INV-1 (supply conservation) |
| Replay attempts | Re-deposit same transfer_id, re-unlock same id | INV-2 (uniqueness) |
| Invalid proof simulation | Zero amounts, negative values, overflow | INV-4 (no state change) |
| Checkpoint mutation | Expired checkpoints, forged roots | INV-5 (integrity) |
| Pause toggling | Random pause/resume during operations | INV-7 (pause blocks all) |
| Extreme values | u64 max amounts, zero amounts | INV-1, INV-8 (bounds) |
| Window boundary | Reset daily counter mid-sequence | INV-8 (rate limits) |

---

## 8. FINDINGS & REQUIRED FIXES

### NEW Finding: Serialization Mismatch (event_index Width)

| Attribute | Value |
|-----------|-------|
| **Severity** | HIGH (breaks ZK minting path entirely) |
| **Component** | Solana `deposit.rs`, DCC `zk_verifier.ride`, ZK `bridge_deposit.circom` |
| **Root Cause** | LOW-1 fix widened event_index to u64 in Solana `compute_message_id` but not in RIDE/ZK |
| **Impact** | Phase 2 ZK minting produces mismatched message_ids → all ZK verifications fail |
| **Status** | OPEN — requires fix |

**Recommended Fix Options:**

**Option A (Preferred):** Update RIDE and ZK circuit to use 8-byte event_index:
- `zk_verifier.ride`: Change `intToLE4(eventIndex)` → `intToLE8(eventIndex)` in `computeMessageId`
- `bridge_deposit.circom`: Change `event_index_bits[32]` → `event_index_bits[64]`, update `PREIMAGE_BITS` from 1448 to 1480
- Requires recompiling the ZK circuit and generating a new trusted setup

**Option B:** Keep RIDE/ZK at 4 bytes, truncate in Solana:
- `deposit.rs`: Change `&event_index.to_le_bytes()` → `&(event_index as u32).to_le_bytes()` in `compute_message_id` only
- Storage stays u64 (no truncation risk for ~4B events), only preimage encoding uses 4 bytes
- No circuit recompilation needed

### Existing Fix: cancelPendingMint Accounting

| Attribute | Value |
|-----------|-------|
| **Severity** | LOW |
| **Component** | `zk_bridge.ride`, `bridge_controller.ride` |
| **Issue** | `cancelPendingMint` does not decrement `totalMinted` after HIGH-5 pre-increment |
| **Impact** | Cancelled large mints permanently inflate `totalMinted` (no funds at risk) |
| **Status** | OPEN — cosmetic accounting bug |

---

## 9. ASSUMPTIONS

The following assumptions MUST remain true for invariants to hold:

| # | Assumption | Required By | If Violated |
|---|-----------|-------------|-------------|
| A-1 | Groth16 trusted setup toxic waste destroyed | INV-1, INV-4, INV-5 | Attacker forges proofs → unlimited minting |
| A-2 | BN128 curve computationally secure | INV-1, INV-4, INV-5 | All ZK proofs breakable |
| A-3 | < `min_validators` validators compromised | INV-1, INV-3 | Colluding validators approve fake burns/mints |
| A-4 | Admin/authority keys not compromised | INV-7, INV-8 | Config manipulation, limited by timelocks |
| A-5 | DCC deployer key is secure | INV-6 | SetScript could replace contract logic |
| A-6 | Solana/DCC nodes honest (or multi-node) | INV-3 | Fabricated events bypass validators |
| A-7 | P2P network not fully partitioned | Liveness | Bridge halts (safety preserved) |
| A-8 | Clocks approximately synchronized | INV-3 | Timestamp-based checks may fail |
| A-9 | Circom/snarkjs compiler is correct | INV-4 | Circuit-level soundness bugs |
| A-10 | `min_validators ≥ 3` (enforced on-chain) | INV-1 | Collusion barrier reduced |

---

## 10. ADDITIONAL INVARIANTS THAT SHOULD BE ENFORCED

### PROPOSED INV-9: Monotonic Nonce Invariant

**Statement:** `∀ user: UserState.next_nonce is strictly monotonically increasing`

**Current status:** Enforced via `checked_add(1)` — cannot overflow due to u64 range. ✅

### PROPOSED INV-10: Checkpoint Ordering Invariant

**Statement:** `∀ checkpoint[i], checkpoint[j]: i < j ⟹ slot[i] < slot[j]`

**Current status:** Enforced via `last_checkpoint_slot` ordering check. ✅

### PROPOSED INV-11: Total Locked ≥ Total Unlocked (Solana)

**Statement:** `total_locked ≥ total_unlocked` (no negative vault obligation)

**Current status:** `total_locked` uses `saturating_sub` which can reach 0 but never underflow. If a deployment occurred where unlocks happened before the LOW-2 fix, pre-existing state could have inverted accounting. ⚠️

### PROPOSED INV-12: Cross-Chain Supply Conservation

**Statement:** `vault_balance_SOL / 10 ≥ totalMinted_DCC - totalBurned_DCC`

**Current enforcement:** None — no cross-chain verification compares Solana vault balance to DCC outstanding supply in real-time. The `checkInvariant()` function on DCC only reads local state.

**Recommendation:** Implement a periodic cross-chain invariant check: validators should compare Solana vault balance to DCC outstanding supply and trigger emergency pause if they diverge by more than a safety margin.

### PROPOSED INV-13: VK Immutability

**Statement:** Once `groth16_vk_set = true`, the VK binary MUST never change.

**Current status:** Enforced — `setVerifyingKey` rejects if `isVkSet()`. No `resetVerifyingKey` exists (HIGH-7 fix). ✅

### PROPOSED INV-14: Event Index Serialization Consistency

**Statement:** `event_index` encoding width MUST be identical across Solana, RIDE, and ZK circuit.

**Current status:** **VIOLATED** — see Section 6. Solana uses 8 bytes, RIDE/ZK use 4 bytes.

---

## CONCLUSION

### Invariant Summary

| Invariant | Status | Confidence |
|-----------|--------|------------|
| INV-1: Supply ≤ Locked | **HOLDS** | High (under A-1, A-2, A-3, A-4) |
| INV-2: Single Processing | **HOLDS** | Very High (PDA + @Verifier) |
| INV-3: Withdrawal After Burn | **HOLDS** | High (under A-3, A-6) |
| INV-4: Invalid Proofs → No State Change | **HOLDS** | Very High (RIDE atomicity) |
| INV-5: Checkpoint Integrity | **HOLDS** | High (under A-3) |
| INV-6: Replay Persistence | **HOLDS** | Very High (on-chain storage) |
| INV-7: Pause Blocks Operations | **HOLDS** | Very High (exhaustive check) |
| INV-8: Rate Limits Enforced | **HOLDS** | High (under A-4) |

### New Findings

1. **HIGH — event_index Serialization Mismatch:** The LOW-1 fix introduced a cross-chain encoding inconsistency that breaks Phase 2 ZK minting entirely. **Requires immediate fix** before ZK path deployment.

2. **LOW — cancelPendingMint Accounting:** Cancelled pending mints permanently inflate `totalMinted` counters. No funds at risk but creates inaccurate supply tracking.

### Overall Assessment

7 of 8 core invariants hold unconditionally under the stated assumptions. The 8th (rate limits) holds under the admin key security assumption. One new serialization inconsistency was discovered that blocks the ZK minting path. The Phase 1 (committee-based) minting path is fully functional and secure.

---

*Formal verification performed March 5, 2026. This analysis is based on source code review and formal reasoning. All findings should be verified independently.*