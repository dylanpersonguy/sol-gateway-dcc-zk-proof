# DCC <-> Solana ZK Bridge Specification

**Version:** 1.0.0  
**Domain Separator:** `DCC_SOL_BRIDGE_V1`  
**Proof System:** Groth16 (BN128)  
**Date:** 2026-03-04  

---

## 1. Overview

This bridge enables trustless transfer of SOL between Solana and DecentralChain (DCC) using zero-knowledge proofs as the security root. No multisig authority controls minting or releasing — the destination chain accepts messages **only** if a ZK proof verifies.

### Supported Flows
- **Solana → DCC:** Deposit SOL on Solana → ZK proof of deposit → Mint wSOL on DCC
- **DCC → Solana:** Burn wSOL on DCC → ZK proof of burn → Release SOL on Solana

### Design Principle
Strict 1:1 backing at all times. The total wSOL supply on DCC must never exceed the SOL locked in the Solana vault.

---

## 2. Architecture Components

### 2.1 Solana Programs

#### A) BridgeVaultProgram (`programs/bridge_vault`)
- Holds SOL in a PDA vault (`seeds = [b"vault"]`)
- Emits `DepositEvent(sender, amount, dst_dcc_addr, nonce, asset_id, message_id)`
- On withdraw (Phase 2): releases SOL only after verifying a valid Groth16 proof of a DCC BurnEvent
- Phase 1 reverse (DCC→SOL): uses committee signatures + timelock + strict caps until Solana on-chain Groth16 verifier is complete
- Enforces replay protection (PDA per `message_id`), rate caps, emergency pause

#### B) CheckpointProgram (`programs/checkpoint_registry`)
- Stores a registry of finalized checkpoints:
  ```
  CheckpointEntry {
      checkpoint_id: u64,
      slot: u64,
      commitment_root: [u8; 32],   // Merkle root of deposit events in this window
      timestamp: i64,
      status: Active | Expired,
  }
  ```
- Only accepts checkpoints meeting finalized criteria:
  - Slot must be finalized per Solana RPC "finalized" commitment level
  - Additional safety margin of N slots (configurable, default 32) must have elapsed
  - Phase 1: t-of-n committee posts checkpoints with collective signatures + 10-minute timelock
  - Phase 2: remove committee dependency by proving checkpoint validity via independent data sources
- Emits `CheckpointEvent(checkpoint_id, slot, commitment_root)`
- Cannot accept wildcard (all-zero) roots
- Checkpoints expire after `CHECKPOINT_TTL` slots (configurable, default 216000 ≈ 24h)

### 2.2 DCC Contracts

#### A) DCCBridgeContract (`dcc/contracts/bridge`)
- `verifyAndMint(proof, publicInputs)`:
  - Calls `groth16Verify(verifyingKey, proof, publicInputs)`
  - Mints wSOL only if proof verifies AND `message_id` not in `processed_message_ids`
  - Stores `message_id → true` for replay protection
- `burn(solRecipient)`:
  - Burns wSOL attached as payment
  - Emits `BurnEvent(user, amount, sol_recipient, nonce, message_id)` via state entries
- Rate limits: per-hour and per-day caps for minting
- Large mint delay: amounts above threshold require N-block delay
- Emergency pause with timelocked enable/disable

#### B) DCCCheckpointRegistry
- Embedded within DCCBridgeContract
- Stores Solana checkpoint roots mirrored to DCC:
  ```
  checkpoint_{id}_root = commitment_root (ByteVector)
  checkpoint_{id}_slot = slot (Int)
  checkpoint_{id}_active = true/false (Boolean)
  ```
- Checkpoint roots are used as public inputs to the Groth16 proof

### 2.3 ZK Prover Service (`zk/prover`)

TypeScript service that:
1. Fetches the Solana checkpoint root + deposit event data from on-chain
2. Builds a Merkle inclusion witness (siblings + path indices)
3. Generates a Groth16 proof that:
   - (i) `message_id = Keccak256(domain_sep || src_chain_id || dst_chain_id || src_program_id || slot || event_index || sender || recipient || amount || nonce || asset_id)`
   - (ii) Event leaf is included in the Merkle event tree whose root == `commitment_root`
   - (iii) `commitment_root` matches the on-chain committed checkpoint root (public input)
4. Outputs: `proof` (A, B, C points) + `publicInputs`

### 2.4 ZK Circuits (`zk/circuits`)

Groth16 circuit (Circom) proving:
- **Message ID computation:** Keccak hash of domain-separated fields matches claimed `message_id`
- **Merkle inclusion:** Leaf computed from message is at a valid path in the Merkle tree with root `commitment_root`
- **Domain separation:** Immutable `src_chain_id`, `dst_chain_id`, `version` in public inputs

### 2.5 Verifier Implementations

- **DCC:** `groth16Verify` (native RIDE v5 built-in for BN128 curve)
- **Solana (Phase 2):** On-chain Groth16 verifier using `alt_bn128` precompile
- **Phase 1:** Solana→DCC is ZK-complete; DCC→Solana uses committee+delay+caps

---

## 3. Message & Hashing Specification

### 3.1 Domain Separation
```
DOMAIN_SEP = "DCC_SOL_BRIDGE_V1"
SOL_CHAIN_ID = 1
DCC_CHAIN_ID = 2
VERSION = 1
```

### 3.2 Message ID
```
message_id = Keccak256(
    DOMAIN_SEP          ||  // 17 bytes, UTF-8
    src_chain_id        ||  // 4 bytes, LE u32
    dst_chain_id        ||  // 4 bytes, LE u32
    src_program_id      ||  // 32 bytes
    slot                ||  // 8 bytes, LE u64
    event_index         ||  // 4 bytes, LE u32
    sender              ||  // 32 bytes
    recipient           ||  // 32 bytes (DCC address padded to 32)
    amount              ||  // 8 bytes, LE u64
    nonce               ||  // 8 bytes, LE u64
    asset_id            ||  // 32 bytes (SPL mint or sentinel)
)
```
Total preimage: 181 bytes

### 3.3 Merkle Leaf
```
leaf = Keccak256(message_id)
```

### 3.4 Merkle Tree
- Binary Merkle tree, depth 20 (supports up to 1,048,576 events per checkpoint)
- Hash function: Keccak256
- Empty leaf: `Keccak256(bytes32(0))`
- Inner node: `Keccak256(left || right)`

### 3.5 Public Inputs for Proof
| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `checkpoint_root` | bytes32 | Merkle root from checkpoint |
| 1 | `message_id` | bytes32 | Computed message ID |
| 2 | `amount` | uint64 | Transfer amount |
| 3 | `recipient` | bytes32 | DCC recipient address |
| 4 | `asset_id` | bytes32 | Asset identifier |
| 5 | `src_chain_id` | uint32 | Source chain (1 = Solana) |
| 6 | `dst_chain_id` | uint32 | Destination chain (2 = DCC) |
| 7 | `version` | uint32 | Bridge version (1) |

---

## 4. State Machine

```
DEPOSITED ──[prover generates proof]──> PROVEN ──[DCC verifies proof]──> MINTED
                                                                            │
                                                                            v
RELEASED <──[vault verifies proof]──── PROVEN_BURN <──[prover]──── BURNED
```

### States
| State | Location | Description |
|-------|----------|-------------|
| DEPOSITED | Solana | SOL locked in vault, event emitted |
| PROVEN | Off-chain | ZK proof generated for deposit |
| MINTED | DCC | wSOL minted after proof verification |
| BURNED | DCC | wSOL burned, burn event emitted |
| PROVEN_BURN | Off-chain | ZK proof generated for burn |
| RELEASED | Solana | SOL released from vault after proof verification |

---

## 5. Finality Model

### 5.1 Checkpoint-Based Finality
The ZK proof does not prove Solana consensus directly. Instead:

1. A **CheckpointProgram** on Solana stores finalized state commitments
2. Checkpoints are posted by a committee (Phase 1) with guardrails:
   - Referenced slot must have `finalized` commitment (31+ confirmations)
   - Additional safety margin of N=32 slots after finalization
   - t-of-n signatures from committee members (3-of-5 minimum)
   - 10-minute timelock before checkpoint becomes active
   - Cannot accept all-zero roots
3. The ZK circuit proves deposit inclusion under a committed checkpoint
4. DCC verifies the proof and checks the checkpoint root is valid

### 5.2 Trust Assumptions (Phase 1)
- **Checkpoint committee:** Trusted to only post valid checkpoints (t-of-n honest majority needed)
- **Timelock:** 10-minute window allows monitoring and emergency intervention
- **Caps:** Even if committee is compromised, rate limits bound losses
- **Progression:** Phase 2 eliminates committee by adding independent checkpoint verification

### 5.3 Trust Reduction Roadmap
| Phase | Checkpoints | SOL→DCC | DCC→SOL |
|-------|-------------|---------|---------|
| 1 | Committee (3/5) + timelock | ZK proof | Committee + delay + caps |
| 2 | Independent sources / light client proof | ZK proof | ZK proof |

---

## 6. Replay Protection

### 6.1 Per-Chain Protection
- **Solana:** PDA per `message_id` (`seeds = [b"processed", message_id]`) — account creation fails if duplicate
- **DCC:** `processed_{message_id} = true` storage entry — checked before mint

### 6.2 Nonce Tracking
- Per-sender monotonic nonce on both chains
- Global message ID set (accounts on Solana, key-value on DCC)

### 6.3 Checkpoint Expiry
- Checkpoints expire after TTL (default 216000 slots ≈ 24h)
- Proofs referencing expired checkpoints are rejected
- Prevents indefinite proof replay windows

---

## 7. Safety Controls

### 7.1 Rate Limits
| Control | Solana (Release) | DCC (Mint) |
|---------|-----------------|------------|
| Per-hour cap | 100 SOL | 100 SOL equivalent |
| Per-day cap | 1000 SOL | 1000 SOL equivalent |
| Max single tx | 50 SOL | 50 SOL equivalent |
| Min single tx | 0.01 SOL | 0.01 SOL equivalent |

### 7.2 Large Withdrawal Delay
- Threshold: 10 SOL
- Delay: 60 minutes (Solana) / 60 blocks (DCC)
- Can be cancelled by guardian during delay period

### 7.3 Emergency Pause
- Pausable by guardian OR admin
- Resumable by admin only
- Timelocked resume (cannot bounce pause/resume rapidly)
- All deposits, mints, burns, and releases halt when paused

### 7.4 Circuit Breaker
- If `total_minted - total_burned > total_locked` → automatic pause
- If daily outflow exceeds max → halt releases/mints
- If checkpoint root doesn't match any known checkpoint → reject proof

### 7.5 Immutable Parameters
- Domain separator: `DCC_SOL_BRIDGE_V1` (hardcoded, not upgradeable)
- Chain IDs: Solana=1, DCC=2 (hardcoded)
- Groth16 verifying key: set once, not upgradeable (new key = new contract deployment)

---

## 8. Threat Model

### 8.1 Threats & Mitigations

| # | Threat | Impact | Mitigation |
|---|--------|--------|------------|
| T1 | Forged ZK proof | Unlimited minting | Groth16 soundness (computational, 128-bit security) |
| T2 | Replay proof | Double-mint | `processed_message_ids` mapping + PDA uniqueness |
| T3 | Compromised checkpoint committee | False checkpoint → theft | Timelock (10min) + rate caps + monitoring + Phase 2 removal |
| T4 | Wrong chain ID in proof | Cross-chain replay | Immutable domain separation in circuit public inputs |
| T5 | Mutated amount/recipient | Steal funds | message_id covers all fields; proof binds to public inputs |
| T6 | Expired checkpoint usage | Stale proofs | Checkpoint TTL enforced on-chain |
| T7 | Oracle manipulation | Price manipulation | ZK proof relies ONLY on on-chain committed checkpoint; NO price feeds |
| T8 | Reentrancy | Double-spend | Anchor CPI guard; RIDE execution is atomic |
| T9 | Vault insolvency | Cannot redeem | Circuit breaker: pause if minted > locked |
| T10 | Admin key compromise | Parameter changes | Guardian separate from admin; timelocked operations; immutable critical params |

### 8.2 Security Invariants

1. `∀ t: wSOL_supply(t) ≤ vault_balance(t)` — DCC supply never exceeds locked SOL
2. `∀ m: processed(m) → ¬processable(m)` — No message can be processed twice
3. `∀ p: verify(p) → ∃ checkpoint c: root(c) = p.checkpoint_root ∧ active(c)` — Every verified proof references an active checkpoint
4. `∀ leaf: inTree(leaf, root) → ∃ deposit d: leaf = Hash(messageId(d))` — Every included leaf corresponds to a real deposit
5. `messageId(d) = H(domainSep || fields(d))` — Message IDs are deterministic and domain-separated

---

## 9. Deliverables

| Path | Description |
|------|-------------|
| `/programs/bridge_vault/` | Solana BridgeVaultProgram (Anchor/Rust) |
| `/programs/checkpoint_registry/` | Solana CheckpointProgram (Anchor/Rust) |
| `/dcc/contracts/bridge/` | DCC ZK bridge contract (RIDE) |
| `/zk/circuits/` | Groth16 circuit (Circom) |
| `/zk/prover/` | Prover service (TypeScript) |
| `/spec/bridge-spec.md` | This document |
| `/tests/` | Test vectors, unit tests, E2E scripts |

---

## 10. Proof System Details

### 10.1 Groth16 on BN128
- Curve: BN128 (alt_bn128)
- Security level: ~128 bits
- Proof size: 3 group elements (A ∈ G1, B ∈ G2, C ∈ G1) = 256 bytes
- Verification: 1 pairing check
- DCC native support: `groth16Verify_*inputs(vk, proof, inputs)`

### 10.2 Circuit Specification
- Framework: Circom 2.x
- Trusted setup: Powers of Tau ceremony + circuit-specific Phase 2
- Constraint count: ~50,000 (Keccak256 + Merkle tree depth 20)
- Public inputs: 8 field elements
- Private inputs: Merkle siblings (20 × 256 bits) + path indices (20 bits) + message fields

### 10.3 Verifying Key
- Generated during trusted setup
- Stored on DCC as base64-encoded state entries
- Immutable once deployed (changing VK = new contract deployment)
