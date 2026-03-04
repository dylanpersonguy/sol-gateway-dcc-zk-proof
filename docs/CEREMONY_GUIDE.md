# Groth16 Trusted Setup Ceremony — Production Guide

## Overview

The bridge's ZK proof system uses Groth16, which requires a **trusted setup ceremony**
where multiple independent participants contribute randomness. The security property is
**1-of-N honest**: if _any single_ contributor destroys their toxic waste, the proving
key is safe.

Our circuit (`bridge_deposit.circom`) produces ~97 K R1CS constraints with 8 public inputs.

## Prerequisites

| Requirement | Version      | Notes                                   |
|-------------|--------------|-----------------------------------------|
| Node.js     | ≥ 18         | snarkjs runtime                         |
| snarkjs     | ≥ 0.7.3      | `npm i -g snarkjs`                      |
| circom      | ≥ 2.1.0      | Circuit compiler                        |
| Git         | any          | For audit trail                         |
| GPG         | ≥ 2.x        | Contributors sign attestations          |

Each contributor needs **≥ 16 GB RAM** and **≥ 50 GB free disk** for the phase-2
computation on a circuit of this size.

## Ceremony Phases

### Phase 1: Powers of Tau (Community)

We use the **Hermez community Powers of Tau** file (`powersOfTau28_hez_final_22.ptau`),
which was produced by 54 independent contributors. This covers circuits up to 2^22
constraints (our circuit uses ~2^17).

The PTAU file is downloaded automatically by `ceremony.sh init`.

**SHA-256 of the PTAU file (verify after download):**
```
powersOfTau28_hez_final_22.ptau
  SHA256: 82eea6f95a7f67a1825e66a59d9478e6f3fc3b7b41e74f5cc2a48ef8f8c3cc9e
```

### Phase 2: Circuit-Specific Setup (Our Ceremony)

This is the multi-party ceremony specific to our circuit.

## Step-by-Step Instructions

### 1. Coordinator: Initialize the Ceremony

```bash
cd zk/circuits
./ceremony.sh init
```

This will:
- Download the Hermez PTAU file (if not cached)
- Compile the circuit to R1CS
- Generate the initial `.zkey` (contribution 0)
- Create `ceremony.log` with the session start entry

Share the output file with Contributor #1:
```
build/bridge_deposit_0000.zkey    # ~400 MB
```

### 2. Each Contributor: Add Entropy

Each contributor runs on their own machine:

```bash
# Receive the .zkey from the previous contributor
# (use secure transfer: rsync over SSH, IPFS, etc.)
./ceremony.sh contribute <input.zkey> <contributor_name>
```

The script will:
- Prompt for random entropy (type random characters)
- Mix entropy with `/dev/urandom` for defense-in-depth
- Output a new `.zkey` named `bridge_deposit_NNNN.zkey`
- Print a **contribution hash** — the contributor MUST publish this

**Required attestation** (post publicly on GitHub / Twitter / Keybase):
```
I participated in the sol-gateway-dcc bridge Groth16 ceremony.
My contribution number: <N>
Contribution hash: <hash from snarkjs output>
I destroyed the machine/VM used for this contribution.
Date: <ISO-8601>
GPG Signature: <detached sig>
```

### 3. Coordinator: Finalize

After all contributors have participated:

```bash
./ceremony.sh finalize <last_contribution.zkey>
```

This applies a final random beacon (derived from a future Bitcoin block hash or
Ethereum randao value announced _before_ the ceremony starts) to prevent the last
contributor from biasing the result.

Output:
```
build/bridge_deposit_final.zkey   # Production proving key
build/verification_key.json        # On-chain verifier input
```

### 4. Coordinator: Verify the Entire Chain

```bash
./ceremony.sh verify
```

This verifies every contribution in the chain is valid, checks the beacon
application, and confirms the final `.zkey` matches the circuit's R1CS.

## Minimum Participants

| Role             | Count | Organization             |
|------------------|-------|--------------------------|
| Coordinator      | 1     | Core team                |
| Core team        | 2     | Project developers       |
| Community        | 3+    | Independent contributors |
| External auditor | 1+    | Security firm            |
| **Total**        | **7+**| 1-of-7 honest suffices   |

## Security Requirements

### For Each Contributor

1. **Use a fresh machine or VM** — preferably air-gapped
2. **Do NOT save the entropy** entered during contribution
3. **Destroy the VM/disk** after contributing (verifiably, if possible)
4. **Publish your contribution hash** on a public, timestamped medium
5. **Sign your attestation** with a GPG key linked to your identity

### For the Coordinator

1. **Announce the ceremony** at least 2 weeks in advance
2. **Fix the beacon source** before the ceremony starts  
   (e.g., "We will use Bitcoin block hash at height N+1000")
3. **Publish `ceremony.log`** with all hashes after finalization
4. **Verify the full chain** before deploying to production
5. **Pin the verification key** to IPFS and record the CID on-chain

### Beacon Selection

The random beacon prevents the last contributor from biasing the setup.
We use a **future Bitcoin block hash** announced before the ceremony begins:

```
Beacon source:  Bitcoin block at height <HEIGHT>
Announcement:   <URL to public post>
Block hash:     <filled in after the block is mined>
```

## Post-Ceremony Checklist

- [ ] All contributor attestations collected and published  
- [ ] `ceremony.log` published (GitHub release)  
- [ ] `verification_key.json` pinned to IPFS  
- [ ] Final `.zkey` pinned to IPFS and archived  
- [ ] `ceremony.sh verify` passes with zero errors  
- [ ] Beacon block hash matches the announced source  
- [ ] At least 7 independent contributors participated  
- [ ] FINALAUDIT.md updated with ceremony details  

## File Inventory (Post-Ceremony)

```
zk/circuits/build/
  bridge_deposit.r1cs              # Circuit constraints
  bridge_deposit_js/
    bridge_deposit.wasm            # WASM witness generator
  bridge_deposit_0000.zkey         # Initial (contribution 0)
  bridge_deposit_0001.zkey         # Contributor 1
  ...
  bridge_deposit_NNNN.zkey         # Last contributor
  bridge_deposit_final.zkey        # Final (after beacon)
  verification_key.json            # Deploy this on-chain
  ceremony.log                     # Full audit trail
```

## Disaster Recovery

If a contributor's machine crashes mid-contribution, resume from the _previous_
contributor's `.zkey` — the failed contribution is simply skipped.

If the coordinator's machine fails, any participant who has the latest `.zkey` can
resume by passing it to the next contributor.

## Timeline

| Day       | Activity                              |
|-----------|---------------------------------------|
| D-14      | Announce ceremony, fix beacon source  |
| D-7       | Distribute `bridge_deposit_0000.zkey` |
| D-6 → D-1 | Contributors add entropy (1/day)     |
| D+0       | Bitcoin beacon block mined            |
| D+0       | Coordinator finalizes + verifies      |
| D+1       | Publish ceremony.log, pin to IPFS     |
| D+2       | Deploy `verification_key.json`        |
