# Audit Scope — SOL ⇄ DecentralChain Bridge

**Date:** 2025-07-14
**Version:** 0.1.0
**Program ID:** `9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF`

---

## 1. In-Scope (Critical Priority)

### Solana On-Chain Program
| File | Lines | Description |
|------|-------|-------------|
| `programs/sol-bridge-lock/src/lib.rs` | 89 | Entry point — `#[program]` module |
| `programs/sol-bridge-lock/src/state.rs` | ~150 | Account state declarations (`BridgeConfig`, `DepositRecord`, `UnlockRecord`, `UserState`, `ValidatorEntry`) |
| `programs/sol-bridge-lock/src/errors.rs` | 102 | Error codes with security context |
| `programs/sol-bridge-lock/src/events.rs` | ~60 | Event types for indexer consumption |
| `programs/sol-bridge-lock/src/instructions/initialize.rs` | 98 | Bridge initialization with config validation |
| `programs/sol-bridge-lock/src/instructions/deposit.rs` | 176 | SOL deposit with rate limits, transfer ID computation |
| `programs/sol-bridge-lock/src/instructions/unlock.rs` | 415 | **MOST CRITICAL** — Ed25519 signature introspection, vault CPI transfer, circuit breakers |
| `programs/sol-bridge-lock/src/instructions/emergency.rs` | 72 | Emergency pause/resume with authority separation |
| `programs/sol-bridge-lock/src/instructions/register_validator.rs` | 80 | Validator registration |
| `programs/sol-bridge-lock/src/instructions/remove_validator.rs` | 60 | Validator removal with min-threshold guard |
| `programs/sol-bridge-lock/src/instructions/update_config.rs` | 100 | Configuration parameter updates |

**Total on-chain Rust:** ~1,200 lines

### Security-Critical Test Files
| File | Tests | Description |
|------|-------|-------------|
| `tests/e2e/bridge.test.ts` | 19 | End-to-end on-chain tests — all 8 instructions |
| `tests/security/security.test.ts` | 12 | Pure security tests — replay, signature, domain separation, PDA |

---

## 2. In-Scope (Secondary Priority)

### Off-Chain Components
| Component | Path | Description |
|-----------|------|-------------|
| Validator node | `validator/src/main.ts` | DCC↔Solana event relay, `submitUnlockToSolana()`, `submitMintToDcc()` |
| Threshold signer | `validator/src/signer/threshold-signer.ts` | M-of-N signing (HSM stubs present) |
| Monitoring | `monitoring/src/main.ts` | Supply invariant checks, chain health, emergency pause trigger |

---

## 3. Out-of-Scope / Known Limitations

### API Routes (Mock/Placeholder)
The REST API (`api/src/routes/`) returns hardcoded values. It is **not** production-ready and should NOT be deployed. The following routes contain placeholder logic:
- `deposit.ts` — returns hardcoded deposit limits
- `health.ts` — returns hardcoded health status
- `stats.ts` — returns all zeros
- `transfer.ts` — returns mock transfer objects

### DCC Side Contracts
DCC smart contracts (RIDE) at `contracts/dcc/` are pseudocode/templates. The DCC bridge controller is outside this audit scope.

### HSM Integration
`validator/src/signer/threshold-signer.ts` contains HSM stubs (`initializeHSM()`, `signWithHSM()`) that fall back to software signing. Production deployments must implement real HSM integration.

### Slashing
Validator slashing conditions described in `docs/VALIDATOR_BOOTSTRAP.md` are documented as a future feature. No implementation exists.

---

## 4. Key Design Decisions for Auditor Attention

### Transfer ID Computation
`compute_transfer_id(sender, nonce) = sha256(sender || nonce_le)`
- **Rationale:** Removed `slot` from computation because the execution slot cannot be predicted client-side, creating a race condition.
- **Collision resistance:** Guaranteed by `(sender, nonce)` uniqueness — nonces are strictly monotonic per user, enforced on-chain.

### Ed25519 Signature Verification
- Uses **instruction introspection** (not CPI) via `sysvar::instructions`
- Scans all preceding transaction instructions for Ed25519 precompile invocations
- Matches `(pubkey, signature, message)` tuples against expected values
- Supports both single-sig and multi-sig Ed25519 instructions

### Vault Transfer Mechanism
- Vault is a **System Program-owned PDA** (seeds: `[b"vault"]`)
- SOL transfers from vault use `system_program::transfer` CPI with PDA signer seeds
- The program never holds the vault's private key — custody is purely PDA-based

### Emergency Pause Separation
- Both `authority` and `guardian` can **pause** the bridge
- Only `authority` (not guardian) can **resume** — prevents compromised guardian from re-enabling operations after legitimate pause

### Large Withdrawal Delay
- Withdrawals ≥ `large_withdrawal_threshold` are **created but not executed**
- `executed` field is set to `false`, `scheduled_time` is set to `now + delay`
- **Note:** A separate "execute scheduled withdrawal" instruction does not yet exist — large withdrawals are currently only recorded

### Daily Outflow Circuit Breaker
- Tracks `current_daily_outflow` with 24-hour rolling reset
- Rejects unlocks that would push daily total above `max_daily_outflow`

---

## 5. Build & Test Instructions

```bash
# Prerequisites: Rust 1.93+, Solana CLI 2.2.x, Anchor CLI 0.31.1, Node.js 20+

# Build
anchor build

# Run all 31 tests (spins up local validator automatically)
anchor test

# Type-check tests only
npx tsc --noEmit --project tsconfig.json
```

### Known Build Workaround
After `cargo generate-lockfile`, run:
```bash
cargo +stable update blake3@1.8.3 --precise 1.5.5
cargo +stable update indexmap@2.13.0 --precise 2.11.4
sed -i '' 's/^version = 4$/version = 3/' Cargo.lock
```
This pins transitive dependencies to versions compatible with Solana's platform-tools cargo (1.79).

---

## 6. Invariants to Verify

1. **No SOL leaves vault without valid M-of-N Ed25519 attestations**
2. **Nonces per user are strictly monotonic** — no replay at the nonce level
3. **Transfer IDs are globally unique** — PDA `init` constraint prevents duplicates
4. **Bridge pause halts ALL deposits and unlocks**
5. **Validator count never drops below `min_validators`** — removal guard
6. **Daily outflow never exceeds `max_daily_outflow`** — circuit breaker
7. **Large withdrawals are delayed** (but note: execution instruction is missing)
8. **Ed25519 signatures are verified by the Solana runtime** via precompile, not by the program itself — the program only confirms the precompile was invoked with correct data
