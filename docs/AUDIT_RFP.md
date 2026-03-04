# Request for Proposal — External Security Audit

## Project: SOL-Gateway-DCC ZK Bridge

**Date:** June 2025  
**Contact:** [team@sol-gateway-dcc.io]  
**Repository:** https://github.com/dylanpersonguy/sol-gateway-dcc-zk-proof  
**License:** MIT  

---

## 1. Project Summary

SOL-Gateway-DCC is a cross-chain bridge that allows SOL and SPL tokens (SOL, USDC, USDT)
to move between Solana and the DecentralChain (DCC) network. The bridge uses:

- **Solana Program (Anchor/Rust):** Vault that locks/unlocks SOL and SPL tokens  
- **DCC Smart Contract (RIDE v6):** Mints/burns wrapped tokens on DecentralChain  
- **ZK Proof System (Groth16/BN128):** Deposit inclusion proofs using circom  
- **Validator Network:** Off-chain relay with Ed25519 multi-signature consensus  
- **Monitoring Service:** Independent anomaly detection with auto-pause capability  

## 2. Scope of Audit

### 2.1 In-Scope Components

| Component | Language | Lines | Location |
|-----------|----------|-------|----------|
| Solana Bridge Program | Rust/Anchor | ~2,500 | `programs/sol-bridge-lock/` |
| DCC Bridge Controller | RIDE v6 | ~1,000 | `dcc/contracts/bridge/zk_bridge.ride` |
| ZK Circuit (Groth16) | Circom | ~500 | `zk/circuits/` |
| ZK Prover Service | TypeScript | ~800 | `zk/prover/` |
| Validator/API Service | TypeScript | ~3,000 | `api/` |
| Encoding Library (Rust) | Rust | ~600 | `libs/encoding-rust/` |
| Encoding Library (TS) | TypeScript | ~500 | `libs/encoding-ts/` |
| Monitoring Service | TypeScript | ~700 | `monitoring/` |
| Deploy Scripts | JS/TS | ~800 | `scripts/`, `deploy-*.mjs` |

**Total: ~10,400 LOC**

### 2.2 Out-of-Scope

- Frontend UI (`frontend/`)
- Telegram bot (`telegram-bot/`)
- Test infrastructure (`tests/`, `test-ledger/`)
- Third-party dependencies (unless specific vulnerability found)

### 2.3 Focus Areas (Priority Order)

1. **Fund Safety:** Can funds be drained, locked permanently, or double-spent?
2. **ZK Soundness:** Is the Groth16 circuit sound? Can proofs be forged?
3. **Cross-Chain Invariant:** `dccMinted - dccBurned ≤ solVaultBalance` always holds?
4. **Access Control:** Authority, guardian, validator privilege escalation
5. **Replay/Reorg:** Transfer ID uniqueness, reorg handling on both chains
6. **Denial of Service:** Can the bridge be griefed without economic cost?
7. **Cryptographic Correctness:** Ed25519 signature aggregation, hash collision
8. **Emergency Mechanisms:** Pause/resume, timelock, two-step resume
9. **Upgrade Safety:** Can a malicious upgrade drain the vault?

## 3. Existing Security Work

We have conducted extensive internal security analysis:

- **6 internal audit reports** covering formal verification, cryptographic attacks,
  ZK soundness, catastrophic failure scenarios, and threat modeling
- **475+ automated tests** (227 RIDE, 236 TypeScript, 12 Rust)
- **Formal verification report** with invariant proofs
- **Consolidated report:** `FINALAUDIT.md` in the repository

These are provided for reference — the external audit should be independent.

## 4. Deliverables Expected

1. **Findings Report** — Categorized by severity (Critical/High/Medium/Low/Info)
2. **Fix Verification** — Re-review of all fixes applied
3. **Executive Summary** — Non-technical overview for stakeholders
4. **ZK Circuit Review** — Specific analysis of the circom circuit's soundness
5. **Formal Verification Opinion** — Review of our invariant proofs

## 5. Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Kickoff | 1 day | Repository access, architecture walkthrough |
| Review | 2-3 weeks | Main audit period |
| Draft Report | 1 week | Initial findings delivery |
| Fix Period | 1 week | Team addresses findings |
| Re-Review | 3-5 days | Auditor verifies fixes |
| Final Report | 2 days | Publication-ready report |
| **Total** | **5-6 weeks** | |

## 6. Auditor Requirements

### Must Have
- Prior experience auditing **Solana Anchor programs**
- Prior experience auditing **ZK circuits (Groth16/PLONK)**
- Published audit reports for cross-chain bridges
- At least 2 auditors assigned to the engagement

### Nice to Have
- Experience with RIDE smart contracts (Waves/DecentralChain ecosystem)
- Formal verification expertise (Certora, Halmos, etc.)
- Published CVEs or bug bounty findings in DeFi protocols

## 7. Preferred Firms

We welcome proposals from any qualified firm. The following have relevant experience:

| Firm | Specialization | Website |
|------|---------------|---------|
| **OtterSec** | Solana, ZK | https://osec.io |
| **Neodyme** | Solana, Rust | https://neodyme.io |
| **Trail of Bits** | General, formal verification | https://trailofbits.com |
| **Zellic** | ZK, bridges | https://zellic.io |
| **Halborn** | Cross-chain, Solana | https://halborn.com |
| **Sec3 (now Otter)** | Solana-specific | https://sec3.dev |

## 8. Budget Range

**$80,000 – $150,000 USD** depending on scope depth and firm.

Payment milestones:
- 30% at kickoff
- 40% at draft report delivery
- 30% at final report delivery

## 9. Proposal Submission

Please include:
1. Team composition and relevant experience
2. Methodology description
3. Timeline estimate
4. Fixed-price quote
5. Sample report (redacted is fine)
6. References from prior bridge/ZK audits

Submit proposals to: **[team@sol-gateway-dcc.io]**  
Deadline: **[TBD — 2 weeks from distribution]**

## 10. Repository Access

The repository is public at:
```
https://github.com/dylanpersonguy/sol-gateway-dcc-zk-proof
```

Build instructions:
```bash
# Solana program
anchor build

# ZK circuits
cd zk/circuits && ./build.sh

# Tests
npm ci && npm test
```

## 11. Architecture Reference

See `docs/ARCHITECTURE.md` for the full system design.  
See `docs/THREAT_MODEL.md` for our threat analysis.  
See `FINALAUDIT.md` for the consolidated internal audit.
