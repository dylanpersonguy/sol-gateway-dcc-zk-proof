# Validator Bootstrap Plan

## Overview

The bridge requires a minimum of 3-of-5 validators (Byzantine fault tolerant
with f=1 tolerance) for production operation. This document describes how to
bootstrap the validator network from zero.

---

## Phase 1: Genesis Validators (Week 1)

### Selection Criteria
- Independent operators in different jurisdictions
- Experience running blockchain infrastructure
- Willingness to use HSM hardware
- Staking commitment (future slashing mechanism)
- 24/7 monitoring capability

### Initial Set (3 validators)

| Validator | Location | Provider | HSM |
|-----------|----------|----------|-----|
| validator-1 | US East | AWS | YubiHSM2 |
| validator-2 | EU West | GCP | CloudHSM |
| validator-3 | APAC | Azure | Managed HSM |

### Key Generation Ceremony

1. Each validator generates key pair in their HSM
2. Public keys exchanged via authenticated channel
3. Key ceremony recorded and hashed
4. Public keys registered on-chain by bridge authority

```bash
# On each validator's secure machine:
ts-node scripts/generate-validator-key.ts \
  --hsm-enabled true \
  --hsm-slot 0

# Authority registers each validator:
ts-node scripts/register-validator.ts \
  --validator-pubkey <PUBKEY>
```

---

## Phase 2: Network Formation (Week 2)

### Peer Discovery

```bash
# Validator 1 starts first
BOOTSTRAP_PEERS="" yarn start

# Validator 2 joins
BOOTSTRAP_PEERS="validator-1:9000" yarn start

# Validator 3 joins
BOOTSTRAP_PEERS="validator-1:9000,validator-2:9000" yarn start
```

### Consensus Test

1. Submit test deposit on Solana devnet
2. Verify all 3 validators detect the event
3. Verify consensus reached (3-of-3)
4. Verify mint executed on DCC

### Health Verification

```bash
# Check all validators are healthy
for i in 1 2 3; do
  curl http://validator-${i}:8080/health
done
```

---

## Phase 3: Expansion to 5 Validators (Week 3-4)

### Add Validators 4 and 5

```bash
# Register new validators on-chain
ts-node scripts/register-validator.ts \
  --validator-pubkey <VALIDATOR_4_PUBKEY>

ts-node scripts/register-validator.ts \
  --validator-pubkey <VALIDATOR_5_PUBKEY>
```

### Update Consensus Threshold

```bash
# Update min_validators from 2 to 3 (for 3-of-5)
ts-node scripts/update-config.ts \
  --min-validators 3
```

### Verification

- Run full end-to-end test with 5 validators
- Test with 1 validator offline (should still reach consensus)
- Test with 2 validators offline (should fail gracefully)

---

## Phase 4: Ongoing Operations

### Monitoring

Each validator instance exposes:
- `/health` — overall health status
- `/metrics` — Prometheus metrics

Monitoring stack:
- **Prometheus** scrapes all validator metrics
- **Grafana** dashboards for real-time visibility
- **AlertManager** for on-call alerts

### Key Rotation Schedule

| Frequency | Action |
|-----------|--------|
| Weekly | Rotate validator signing keys |
| Monthly | Rotate HSM wrapper keys |
| Quarterly | Security review of validator infrastructure |
| Annually | Full key ceremony with new key generation |

### Validator Replacement Procedure

1. Deploy new validator node
2. Generate new key pair in HSM
3. Register new validator on-chain
4. Verify new validator joins consensus
5. Deregister old validator
6. Securely destroy old HSM key material

### Slashing Conditions (Future)

Validators will be slashed for:
- Signing conflicting messages (equivocation)
- Extended downtime (>24 hours)
- Signing messages for invalid events
- Failing to participate in consensus repeatedly

---

## Emergency Procedures

### Validator Compromise

1. Immediately pause bridge (guardian key)
2. Remove compromised validator from active set
3. Investigate scope of compromise
4. If M-of-N threshold still met, resume with reduced set
5. Deploy replacement validator
6. Post-mortem and incident report

### Complete Network Failure

1. Bridge auto-pauses (no consensus possible)
2. Funds remain safe in PDA vault (no external key)
3. Restore validators from backups
4. Re-register if keys need regeneration
5. Resume bridge operations
6. All pending transfers can be retried

### Coordination Channels

- **Primary:** Encrypted Slack/Element channel
- **Secondary:** PGP-encrypted email
- **Emergency:** Phone tree (stored offline)
