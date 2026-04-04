# RELEASE_GUARD.md — Production Launch Prerequisites

> **Status:** ENFORCED at runtime when `FULL_PRODUCTION=true`
>
> This document lists every prerequisite that MUST be satisfied before the
> SOL ⇄ DCC bridge can operate in full-production mode.  The validator node's
> startup sequence checks these automatically and will **refuse to start** if
> any item is missing.

---

## Runtime-Enforced Prerequisites

| # | Env Variable | Requirement | Why |
|---|---|---|---|
| 1 | `MPC_CEREMONY_ATTESTATION_HASH` | Non-empty SHA-256 hash | Proves toxic waste from the Groth16 trusted setup ceremony was destroyed |
| 2 | `MULTISIG_AUTHORITY_ENABLED=true` | Must be `true` | Ensures upgrade authority uses M-of-N multisig, not a single keypair |
| 3 | `EXTERNAL_AUDIT_COMPLETED=true` | Must be `true` | Confirms an independent security audit has been completed and remediations applied |
| 4 | `HSM_ENABLED=true` | Must be `true` | Validator signing keys are stored in a Hardware Security Module |

If `FULL_PRODUCTION=true` and any of the above are missing, the validator
prints an error summary and exits with code 1.

---

## Additional Checklist (Manual Verification)

These are not enforced by code but MUST be completed before announcing
the bridge as production-ready.

### Security

- [ ] External audit report published (link: _______)
- [ ] All CRITICAL and HIGH findings from audit remediated
- [ ] Red team exercise completed (see `RED_TEAM_REPORT.md`)
- [ ] Formal verification report reviewed (see `FORMAL_VERIFICATION_REPORT.md`)
- [ ] All cross-language encoding test vectors pass (44 vectors in `spec/test-vectors.json`)

### Cryptographic Ceremony

- [ ] MPC ceremony completed with ≥ 3 independent participants
- [ ] Ceremony transcript published
- [ ] Attestation hash recorded in `MPC_CEREMONY_ATTESTATION_HASH`
- [ ] At least one participant has publicly attested to destroying their toxic waste

### Infrastructure

- [ ] HSM configured and tested for all validator signing keys
- [ ] Multisig upgrade authority set (min 3-of-5 recommended)
- [ ] Monitoring daemon deployed and connected to PagerDuty/Slack
- [ ] Reconciliation daemon running with 30s interval
- [ ] Prometheus + Grafana dashboards deployed
- [ ] Log aggregation configured (ELK / CloudWatch / etc.)

### Operational

- [ ] Incident response runbook reviewed by all operators
- [ ] Emergency pause tested on devnet/testnet
- [ ] Key rotation procedure tested
- [ ] Backup and disaster recovery plan documented
- [ ] Rate limits configured for production traffic levels

### Beta Caps (Remove Before Full Production)

During limited beta, the following safety caps should be active:

| Parameter | Beta Value | Production Value |
|---|---|---|
| `MAX_SINGLE_TX` | 10 SOL (10,000,000,000 lamports) | TBD by governance |
| `MAX_DAILY_OUTFLOW` | 100 SOL (100,000,000,000 lamports) | TBD by governance |
| `ZK_ONLY_THRESHOLD_LAMPORTS` | 5 SOL (5,000,000,000 lamports) | 0 (all ZK) |
| `DISABLE_ZK_PATH` | `false` | `false` |
| `MIN_VALIDATORS` | 3 | 5+ |
| `SOLANA_CONFIRMATIONS` | 32 | 32 |

---

## How to Enable Full Production

```bash
# 1. Set all prerequisites
export MPC_CEREMONY_ATTESTATION_HASH="sha256:abc123..."
export MULTISIG_AUTHORITY_ENABLED=true
export EXTERNAL_AUDIT_COMPLETED=true
export HSM_ENABLED=true

# 2. Enable full production mode
export FULL_PRODUCTION=true

# 3. Start the validator — it will verify all prerequisites
node dist/main.js
```

If any prerequisite is missing, you will see:

```
ERROR  RELEASE_GUARD FAILURE — Cannot start in FULL_PRODUCTION mode
ERROR  Missing prerequisites:
ERROR    ✗ MPC_CEREMONY_ATTESTATION_HASH
ERROR  See docs/RELEASE_GUARD.md for details
```

---

## Version History

| Date | Change |
|---|---|
| 2024-01-XX | Initial release with 4 runtime prerequisites |
