# Threat Model — SOL ⇄ DecentralChain Bridge

## Threat Actors

| Actor | Capability | Motivation |
|-------|-----------|------------|
| Nation-state | Unlimited compute, zero-days, supply chain attacks | Disruption, theft |
| Insider | Access to 1-2 validator keys, source code | Theft, sabotage |
| External attacker | Network access, public chain data, standard exploits | Theft |
| Compromised dependency | Supply chain poisoning | Backdoor deployment |
| Rogue validator | Single validator key, network position | Theft, disruption |

## Attack Vectors & Mitigations

### 1. Validator Key Compromise (CRITICAL)

**Attack:** Attacker obtains M-of-N validator private keys and forges attestations to mint unbacked wSOL.DCC or unlock SOL.

**Mitigations:**
- Hardware Security Modules (HSM) — keys never leave hardware
- Geographic distribution of validators across jurisdictions
- Threshold signatures (TSS) — no single key reconstruction
- Key rotation every 7 days
- Anomaly detection — supply invariant check every 30s
- Auto-pause on supply mismatch triggers within seconds

**Residual risk:** LOW — requires physical compromise of geographically distributed HSMs

---

### 2. Smart Contract Logic Bug (CRITICAL)

**Attack:** Exploit in Solana program or DCC contract allows unauthorized mint/unlock.

**Mitigations:**
- Anchor framework with built-in safety checks
- All arithmetic uses checked operations (overflow protection)
- PDA-only custody — no externally owned vault
- Multiple independent audits recommended
- Formal verification of critical invariants (future)
- Circuit breakers limit damage even if exploited
- Emergency pause stops all operations

**Residual risk:** MEDIUM — requires pre-launch audit and formal verification

---

### 3. Replay Attack (HIGH)

**Attack:** Resubmit a previously valid attestation to double-mint or double-unlock.

**Mitigations:**
- Unique transfer_id = hash(sender, nonce, slot) — collision-resistant
- ProcessedTransfers mapping rejects all duplicates permanently
- Per-user monotonic nonces prevent out-of-order replay
- Domain separation in signatures (chain_id + version prefix)
- Expiration timestamps on unlock messages

**Residual risk:** NEGLIGIBLE

---

### 4. Finality Violation / Chain Reorg (HIGH)

**Attack:** Deposit a transaction, get wSOL.DCC minted, then reorg Solana to reverse the deposit.

**Mitigations:**
- Require ≥32 Solana confirmations (finalized commitment)
- Additional reorg protection window (50 slots)
- Transaction re-verification at finalized slot
- Events invalidated if source tx disappears
- Supply invariant monitor catches discrepancies

**Residual risk:** NEGLIGIBLE — Solana with 32 confirmations is effectively final

---

### 5. Bridge Drain via Volume Attack (HIGH)

**Attack:** Rapidly deposit and withdraw to drain the vault or trigger mint/unlock bugs.

**Mitigations:**
- Per-transaction maximum amount
- Daily outflow rate limit
- Per-block rate limits
- Large withdrawal time delay (1 hour for >50 SOL)
- Hourly volume monitoring with auto-pause
- Transaction frequency anomaly detection

**Residual risk:** LOW — multiple independent rate limits constrain attack surface

---

### 6. Oracle/Event Manipulation (MEDIUM)

**Attack:** Forge or tamper with cross-chain events to trick validators.

**Mitigations:**
- Validators independently connect to Solana/DCC full nodes
- Each validator verifies events against on-chain state
- BFT consensus requires agreement from M-of-N independent nodes
- Deterministic event parsing — identical data from all validators
- Byzantine fault detection alerts on disagreements

**Residual risk:** LOW — requires compromising multiple independent full nodes

---

### 7. Denial of Service (MEDIUM)

**Attack:** Overwhelm validators, API, or chains to prevent bridge operation.

**Mitigations:**
- Rate limiting at API layer
- Multiple validator nodes with independent connectivity
- Graceful degradation — bridge pauses rather than fails unsafely
- No permanent fund locking under DoS
- Health monitoring and auto-restart

**Residual risk:** MEDIUM — DoS can halt bridge temporarily but cannot steal funds

---

### 8. Insider Threat (MEDIUM)

**Attack:** Malicious developer deploys backdoored code or a single operator abuses access.

**Mitigations:**
- All deploys require multi-sig (2-of-3)
- Code review mandatory for all changes
- Open-source code with audit trail
- No single person has M-of-N validator keys
- Guardian key separate from authority key
- Monitor is independent from validator infrastructure

**Residual risk:** LOW — M-of-N requirements prevent unilateral action

---

### 9. Supply Chain Attack (MEDIUM)

**Attack:** Compromise npm/cargo dependencies to inject malicious code.

**Mitigations:**
- Dependency pinning with lockfiles
- Audit of critical dependencies
- Minimal dependency surface
- Build reproducibility verification
- Separate build and runtime environments

**Residual risk:** MEDIUM — ongoing vigilance required

---

### 10. Front-Running/MEV (LOW)

**Attack:** Front-run bridge transactions for profit.

**Mitigations:**
- Bridge deposits are user-initiated — no arbitrage opportunity
- Vault unlocks are PDA-controlled — no front-running possible
- No price oracle dependency
- Fixed 1:1 exchange rate eliminates MEV

**Residual risk:** NEGLIGIBLE

---

## Invariant Summary

| Invariant | Enforcement | Monitoring |
|-----------|------------|------------|
| wSOL.DCC supply ≤ locked SOL | Smart contract logic | 30-second supply check |
| No duplicate transfers | ProcessedTransfers map | Alert on collision attempt |
| No mint without finality | 32-confirmation wait | Finality verification |
| No unlock without burn proof | M-of-N validator consensus | Cross-chain verification |
| Rate limits respected | On-chain enforcement | Daily limit monitoring |
| Emergency pause works | Tested circuit breaker | Health check endpoint |

## Risk Matrix

| Risk | Likelihood | Impact | Severity | Status |
|------|-----------|--------|----------|--------|
| Key compromise (all M) | Very Low | Critical | HIGH | Mitigated by HSM + geo-dist |
| Contract bug | Low | Critical | HIGH | Needs audit |
| Replay attack | Very Low | High | MEDIUM | Mitigated |
| Chain reorg | Very Low | High | MEDIUM | Mitigated |
| Volume attack | Low | Medium | MEDIUM | Mitigated |
| DoS | Medium | Low | LOW | Mitigated |
| Supply chain | Low | High | MEDIUM | Partially mitigated |
