<div align="center">

# ZK Bridge — Solana ⇄ DecentralChain

### Zero-Knowledge Proof Cross-Chain Bridge Protocol

[![Solana](https://img.shields.io/badge/Solana-Mainnet_Ready-9945FF?style=for-the-badge&logo=solana&logoColor=white)](https://solana.com)
[![ZK Proofs](https://img.shields.io/badge/ZK-Groth16_BN128-FF6B2B?style=for-the-badge)](https://en.wikipedia.org/wiki/Zero-knowledge_proof)
[![Anchor](https://img.shields.io/badge/Anchor-0.31-0066FF?style=for-the-badge)](https://www.anchor-lang.com)
[![RIDE](https://img.shields.io/badge/RIDE-v5-00D4AA?style=for-the-badge)](https://docs.decentralchain.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

A trust-minimized cross-chain bridge that uses **Groth16 zero-knowledge proofs** to enable verifiable, cryptographically-proven asset transfers between Solana and DecentralChain — without relying on any trusted intermediary for proof of deposit or burn.

[How It Works](#-how-it-works) · [Architecture](#-architecture) · [ZK Proof System](#-zk-proof-system) · [Security Model](#-security-model) · [Getting Started](#-getting-started) · [Documentation](#-documentation)

</div>

---

## Why This Exists

Cross-chain bridges are one of the most attacked primitives in all of crypto. The root cause is almost always the same: **trust assumptions**. Traditional bridges rely on multisigs, oracles, or relayer committees that can be compromised, bribed, or exploited. When the trusted party fails, the bridge drains.

This bridge takes a fundamentally different approach. Instead of trusting a committee to attest that a deposit happened, the bridge requires a **zero-knowledge proof** — a mathematical guarantee that a deposit event is included in a finalized Solana checkpoint. The destination chain doesn't need to trust anyone; it verifies the proof and either accepts or rejects it. No social consensus, no reputation, no trust.

---

## How It Works

### The Core Idea

When a user deposits SOL on Solana, the bridge doesn't simply tell DecentralChain "hey, a deposit happened." Instead, a **Groth16 ZK proof** is generated that mathematically proves:

1. **A deposit event exists** with a specific sender, recipient, amount, nonce, and asset ID
2. **The deposit is included** in a Merkle tree whose root matches a finalized Solana checkpoint
3. **The checkpoint is real** — committed on-chain with finality guarantees

The DCC bridge contract calls `groth16Verify()` natively. If the proof verifies, the contract mints wrapped tokens. If it doesn't, nothing happens. There is no fallback, no override, no admin key that can force a mint. **Math is the only authority.**

### Deposit Flow (Solana → DCC)

```
User deposits SOL into Solana vault (PDA-controlled)
         │
         ▼
Deposit event is recorded on-chain with a unique message_id
         │
         ▼
Checkpoint program aggregates events into a Merkle tree
and commits the root after finalization (32+ block confirmations)
         │
         ▼
ZK prover service generates a Groth16 proof:
  • Computes message_id = Keccak256(domain_sep || chain_ids || all fields)
  • Proves Merkle inclusion of the event leaf under the checkpoint root
  • Binds amount, recipient, and asset_id as public inputs
         │
         ▼
Proof is submitted to DCC bridge contract
         │
         ▼
DCC contract calls groth16Verify(verifying_key, proof, public_inputs)
  • If valid AND message_id not already processed → mint wSOL to recipient
  • If invalid OR replay → reject
```

### Redemption Flow (DCC → Solana)

```
User burns wSOL on DecentralChain
         │
         ▼
Burn event is recorded with a unique message_id
         │
         ▼
Phase 1: Committee signatures + timelock + rate caps release SOL from vault
Phase 2: ZK proof of DCC burn verifiable on-chain via Solana alt_bn128 precompile
```

### 17 Supported Tokens

All tokens are registered on-chain with automatic decimal conversion between Solana and DCC representations.

| Token | Direction | Sol Decimals | DCC Decimals | Category |
|:------|:---------:|:------------:|:------------:|:---------|
| **SOL** | SOL → wSOL | 9 | 8 | Native |
| **USDC** | USDC → wUSDC | 6 | 6 | Stablecoin |
| **USDT** | USDT → wUSDT | 6 | 6 | Stablecoin |
| **PYUSD** | PYUSD → wPYUSD | 6 | 6 | Stablecoin |
| **DAI** | DAI → wDAI | 8 | 8 | Stablecoin |
| **BTC** (Wrapped) | BTC → wBTC | 8 | 8 | Bitcoin |
| **cbBTC** | cbBTC → wcbBTC | 8 | 8 | Bitcoin |
| **tBTC** | tBTC → wtBTC | 8 | 8 | Bitcoin |
| **ETH** (Wrapped) | ETH → wETH | 8 | 8 | Ethereum |
| **JitoSOL** | JitoSOL → wJitoSOL | 9 | 8 | Liquid Staking |
| **JUP** | JUP → wJUP | 6 | 6 | DeFi |
| **RAY** | RAY → wRAY | 6 | 6 | DeFi |
| **PYTH** | PYTH → wPYTH | 6 | 6 | Oracle |
| **RNDR** | RNDR → wRNDR | 8 | 8 | Compute |
| **BONK** | BONK → wBONK | 5 | 5 | Community |
| **PUMP** | PUMP → wPUMP | 6 | 6 | Community |
| **PENGU** | PENGU → wPENGU | 6 | 6 | Community |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER LAYER                                 │
│     React + Vite Frontend  ←→  Bridge REST API  ←→  Phantom Wallet     │
└──────────────┬──────────────────────────────────────┬───────────────────┘
               │                                      │
┌──────────────▼──────────────────┐    ┌──────────────▼───────────────────┐
│       SOLANA (Source Chain)      │    │     DECENTRALCHAIN (Dest Chain)  │
│                                  │    │                                   │
│  ┌────────────────────────────┐ │    │  ┌─────────────────────────────┐ │
│  │  BridgeVaultProgram        │ │    │  │  DCCBridgeContract (RIDE)   │ │
│  │  • PDA-controlled vault    │ │    │  │  • groth16Verify() native   │ │
│  │  • Deposit / Release SOL   │ │    │  │  • Mint / Burn wSOL        │ │
│  │  • Replay protection (PDA) │ │    │  │  • Replay protection (map) │ │
│  │  • Rate limits + pause     │ │    │  │  • Rate limits + pause     │ │
│  └────────────────────────────┘ │    │  └─────────────────────────────┘ │
│                                  │    │                                   │
│  ┌────────────────────────────┐ │    │  ┌─────────────────────────────┐ │
│  │  CheckpointProgram         │ │    │  │  Checkpoint Registry        │ │
│  │  • Merkle root of events   │ │    │  │  • Mirrors Solana roots     │ │
│  │  • Finality enforcement    │ │    │  │  • TTL-based expiry         │ │
│  │  • Committee + timelock    │ │    │  │  • Proof validation anchor  │ │
│  └────────────────────────────┘ │    │  └─────────────────────────────┘ │
└─────────────────────────────────┘    └───────────────────────────────────┘
               │                                      │
               └──────────────┬───────────────────────┘
                              │
               ┌──────────────▼───────────────────────┐
               │        ZK PROOF LAYER                 │
               │                                       │
               │  Circom Circuit (Groth16 / BN128)     │
               │  • Keccak256 message ID computation   │
               │  • Merkle inclusion proof (depth 20)  │
               │  • Domain-separated public inputs     │
               │                                       │
               │  Prover Service (TypeScript)           │
               │  • Fetches checkpoint + event data     │
               │  • Builds Merkle witness               │
               │  • Generates proof (A, B, C points)    │
               └──────────────┬───────────────────────┘
                              │
               ┌──────────────▼───────────────────────┐
               │    SAFETY & MONITORING LAYER          │
               │                                       │
               │  • Supply invariant check (30s loop)  │
               │  • Circuit breakers (auto-pause)      │
               │  • Rate limits (per-tx, hourly, daily)│
               │  • Large withdrawal delay (60 min)    │
               │  • Anomaly detection + alerting       │
               │  • Prometheus + Grafana dashboards     │
               │  • Slack / Telegram / PagerDuty        │
               └───────────────────────────────────────┘
```

---

## ZK Proof System

### Overview

The bridge uses **Groth16 proofs over the BN128 curve** — the same proof system used by Zcash, Tornado Cash, and other production-grade privacy protocols. Groth16 provides:

- **128-bit computational security** — breaking the proof requires solving the discrete log problem on BN128
- **Constant-size proofs** — exactly 256 bytes regardless of circuit complexity
- **Single pairing check verification** — extremely efficient on-chain verification
- **Native DCC support** — DecentralChain's RIDE v5 includes built-in `groth16Verify()` for BN128

### What the Circuit Proves

The Circom circuit (`zk/circuits/bridge_deposit.circom`) proves three things in a single proof:

**1. Message ID Integrity**
```
message_id = Keccak256(
    "DCC_SOL_BRIDGE_V1"  ||   // Domain separator (17 bytes)
    src_chain_id          ||   // 4 bytes — prevents cross-chain replay
    dst_chain_id          ||   // 4 bytes
    src_program_id        ||   // 32 bytes — binds to specific bridge program
    slot                  ||   // 8 bytes — Solana slot of the event
    event_index           ||   // 4 bytes — position in the block
    sender                ||   // 32 bytes — who deposited
    recipient             ||   // 32 bytes — who receives on DCC
    amount                ||   // 8 bytes — exact transfer amount
    nonce                 ||   // 8 bytes — per-sender monotonic counter
    asset_id              ||   // 32 bytes — which token
)
```
The circuit computes this Keccak256 hash inside the proof and constrains it to equal the claimed `message_id` public input. This means the prover cannot lie about any field — the hash would differ.

**2. Merkle Inclusion**
```
leaf = Keccak256(message_id)
MerkleVerify(leaf, siblings[20], path_indices[20]) == checkpoint_root
```
The circuit proves the event leaf exists in the Merkle tree committed by the Solana checkpoint program. The tree has depth 20, supporting up to 1,048,576 events per checkpoint window.

**3. Domain Separation**
```
Public inputs include: src_chain_id, dst_chain_id, version
```
These are verified by the on-chain contract, ensuring a proof from one bridge deployment cannot be replayed on another.

### Public vs Private Inputs

| Input | Visibility | Why |
|:------|:----------:|:----|
| `checkpoint_root` | **Public** | Verified against on-chain committed root |
| `message_id` | **Public** | Checked against replay protection map |
| `amount` | **Public** | Used for rate limit checks and minting |
| `recipient` | **Public** | Determines who receives minted tokens |
| `asset_id` | **Public** | Determines which token to mint |
| `src/dst_chain_id` | **Public** | Domain separation on-chain |
| `version` | **Public** | Protocol versioning |
| `sender`, `slot`, `nonce`, etc. | **Private** | Hidden inside the proof — not needed for verification |
| `merkle_siblings` | **Private** | Merkle path — proves inclusion without revealing tree structure |

### Trusted Setup

Groth16 requires a one-time trusted setup ceremony:
- **Phase 1:** Powers of Tau — universal, reusable across circuits
- **Phase 2:** Circuit-specific contribution
- **Verifying key** is stored on DCC as immutable state — changing it requires deploying an entirely new contract

---

## Security Model

### Why This Bridge Is Different

Most bridges fail because they rely on a **social** trust assumption: "these N parties will behave honestly." This bridge replaces that with a **mathematical** trust assumption: "Groth16 is sound" — which has the same security level as the elliptic curve cryptography securing every blockchain.

### Defense-in-Depth Layers

The bridge implements seven independent security layers. An attacker would need to defeat **all of them simultaneously** to extract funds:

| Layer | Protection | How It Works |
|:------|:-----------|:-------------|
| **1. ZK Proof Verification** | No mint without valid proof | `groth16Verify()` is called on every mint — forging a proof requires breaking 128-bit discrete log |
| **2. Replay Protection** | No double-processing | Every `message_id` is recorded on-chain (PDA on Solana, map on DCC) — duplicates are rejected permanently |
| **3. PDA-Only Custody** | No key can drain the vault | Funds are held in Program Derived Addresses — only the program's logic can release them, no private key exists |
| **4. Checkpoint Finality** | No acting on unconfirmed events | Checkpoints require 32+ Solana block confirmations + additional safety margin + 10-minute timelock |
| **5. Rate Limits** | Bounded loss on any exploit | Per-transaction max (50 SOL), hourly caps (100 SOL), daily caps (1,000 SOL) — even a valid exploit is throttled |
| **6. Circuit Breakers** | Automatic emergency shutdown | If `total_minted > total_locked` at any point, the bridge auto-pauses within seconds |
| **7. Domain Separation** | No cross-deployment replay | Chain IDs, program IDs, and version bytes are hardcoded in the circuit — proofs from one deployment are invalid on another |

### Threat Mitigation Matrix

| Threat | Severity | Mitigation | Residual Risk |
|:-------|:--------:|:-----------|:-------------:|
| Forged ZK proof | Critical | Groth16 soundness — 128-bit security | **Negligible** |
| Replay attack | Critical | `processed_message_ids` + PDA uniqueness + nonce monotonicity | **Negligible** |
| Checkpoint committee compromise | High | Timelock (10 min) + rate caps + monitoring + Phase 2 eliminates committee | **Low** |
| Solana chain reorg | High | 32+ confirmations = finalized commitment + reorg window + re-verification | **Negligible** |
| Smart contract bug | High | Anchor safety checks + checked arithmetic + PDA custody + circuit breakers + audit | **Low** |
| Vault drain via volume | High | Multi-layer rate limits + large-tx delay + anomaly detection | **Low** |
| Admin key compromise | Medium | Guardian ≠ authority + timelocked operations + immutable critical parameters | **Low** |
| Oracle manipulation | Medium | ZK proofs reference **only** on-chain committed checkpoints — no price feeds, no oracles | **Negligible** |
| Supply chain attack | Medium | Dependency pinning + lockfiles + minimal dependency surface + reproducible builds | **Low** |

### Security Invariants

These properties are enforced at all times and continuously monitored:

```
1. ∀ t : wSOL_supply(t) ≤ vault_balance(t)
   → DCC supply never exceeds locked SOL (checked every 30 seconds)

2. ∀ m : processed(m) → ¬processable(m)
   → No message can ever be processed twice

3. ∀ p : verify(p) → ∃ checkpoint c : root(c) = p.checkpoint_root ∧ active(c)
   → Every verified proof references a real, active checkpoint

4. messageId(d) = H(domainSep || fields(d))
   → Message IDs are deterministic, collision-resistant, and domain-separated
```

### Key Management

| Component | Storage | Access | Purpose |
|:----------|:--------|:-------|:--------|
| Bridge Authority | HSM / Multisig | Config updates only | Parameter changes (timelocked) |
| Guardian | Separate HSM | Emergency pause only | Kill switch for incidents |
| Validators (x5) | Individual HSMs | Checkpoint attestation | Checkpoint committee (Phase 1) |
| PDA Vault | Program-derived | Program logic only | **No private key exists** |
| Verifying Key | Immutable on-chain | Read-only | Cannot be changed after deployment |

---

## Project Structure

```
├── programs/
│   ├── bridge_vault/              # Solana BridgeVaultProgram (Rust / Anchor)
│   │   └── src/                   #   PDA vault, deposit, release, replay protection
│   ├── checkpoint_registry/       # Solana CheckpointProgram (Rust / Anchor)
│   │   └── src/                   #   Merkle root commits, finality enforcement
│   └── sol-bridge-lock/           # Legacy bridge lock program (Rust / Anchor)
│       └── src/                   #   Instructions, state, events, errors
│
├── zk/
│   ├── circuits/                  # Groth16 circuits (Circom 2.x)
│   │   ├── bridge_deposit.circom  #   Main deposit inclusion circuit
│   │   ├── keccak256.circom       #   Keccak256 hash component
│   │   └── merkle_tree.circom     #   Binary Merkle tree verifier
│   ├── prover/                    # ZK prover service (TypeScript)
│   └── build/                     # Compiled circuit artifacts + keys
│
├── dcc/contracts/bridge/          # DCC ZK bridge contract (RIDE v5)
├── dcc-contracts/                 # DCC token contracts
│   ├── bridge-controller/         #   Multi-token bridge logic
│   └── token-registry.cjs        #   SPL token configuration (17 tokens)
│
├── validator/                     # Validator / checkpoint committee node
│   └── src/
│       ├── watchers/              #   Solana & DCC chain watchers
│       ├── consensus/             #   BFT consensus engine
│       ├── signer/                #   Threshold signature (TSS/MPC)
│       └── p2p/                   #   Peer-to-peer communication
│
├── api/                           # Bridge REST API (Express)
├── frontend/                      # React + Vite + Tailwind UI
├── monitoring/                    # Anomaly detection + alerting
├── telegram-bot/                  # Telegram notifications
├── tests/
│   ├── e2e/                       #   End-to-end bridge tests
│   ├── security/                  #   Replay, signature, PDA tests
│   ├── adversarial/               #   Chaos engineering tests
│   ├── unit/                      #   Component unit tests
│   └── vectors/                   #   Test vectors for ZK circuits
│
├── spec/bridge-spec.md            # Full bridge specification
├── docs/                          # Architecture, security, deployment docs
├── scripts/                       # Deployment & utility scripts
└── infra/                         # Prometheus monitoring config
```

---

## Getting Started

### Prerequisites

| Dependency | Version | Purpose |
|:-----------|:--------|:--------|
| Rust | 1.75+ | Solana program compilation |
| Solana CLI | 1.18+ | Chain interaction |
| Anchor CLI | 0.31+ | Program framework |
| Node.js | 20+ | Validator, API, prover, frontend |
| Docker | Latest | Local DCC node + monitoring |
| Circom | 2.1+ | ZK circuit compilation |
| SnarkJS | Latest | Proof generation + verification |

### Installation

```bash
# Clone the repository
git clone https://github.com/dylanpersonguy/sol-gateway-dcc-zk-proof.git
cd sol-gateway-dcc-zk-proof

# Install all dependencies (npm workspaces)
npm install

# Build the Solana programs
anchor build

# Compile ZK circuits (if modifying)
cd zk/circuits && bash build.sh
```

### Local Development

```bash
# 1. Start the local DCC node
docker compose up -d dcc-node

# 2. Deploy DCC contracts + register all 17 tokens
node deploy-dcc.cjs

# 3. Run the end-to-end bridge test
node e2e-test.cjs

# 4. Start the frontend
cd frontend && npx vite

# 5. Start the monitoring stack
docker compose up -d prometheus grafana
```

### Deploy to Devnet

```bash
# Deploy Solana programs
anchor deploy --provider.cluster devnet

# Initialize bridge parameters
npx ts-node scripts/initialize-bridge.ts --network devnet

# Deploy DCC bridge contract
npx ts-node scripts/deploy-dcc-contracts.ts --network testnet

# Register validators
npx ts-node scripts/register-validator.ts --network devnet
```

### Run Tests

```bash
# Anchor on-chain tests
anchor test

# End-to-end bridge flow
node e2e-test.cjs

# Security tests (replay, signatures, PDA)
npm run test:security

# ZK bridge integration test
npm run test:zk-bridge

# Full test suite
npm run test:e2e
```

---

## Phased Rollout

The bridge follows a two-phase trust reduction strategy:

| | Phase 1 (Current) | Phase 2 (Planned) |
|:--|:-------------------|:-------------------|
| **SOL → DCC** | ZK proof (fully trustless) | ZK proof (no change) |
| **DCC → SOL** | Committee sigs + timelock + caps | ZK proof via Solana `alt_bn128` precompile |
| **Checkpoints** | Committee (3/5) + 10-min timelock | Independent verification / light client proof |
| **Trust assumption** | Committee honest majority (bounded by caps) | Math only |

Phase 1 is already production-grade for SOL→DCC. The DCC→SOL direction uses a committee with strict guardrails (rate caps, timelock, monitoring) as a temporary measure until Solana's `alt_bn128` precompile enables on-chain Groth16 verification.

---

## Documentation

| Document | Description |
|:---------|:------------|
| [spec/bridge-spec.md](spec/bridge-spec.md) | Complete bridge specification — message format, state machine, proof system |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and data flow diagrams |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Comprehensive threat analysis with mitigations |
| [docs/SECURITY_TESTING.md](docs/SECURITY_TESTING.md) | Five-layer security testing strategy |
| [docs/AUDIT_SCOPE.md](docs/AUDIT_SCOPE.md) | Audit scope with line-level file inventory |
| [docs/AUDIT_CHECKLIST.md](docs/AUDIT_CHECKLIST.md) | Pre-audit security checklist |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment guide |
| [docs/VALIDATOR_BOOTSTRAP.md](docs/VALIDATOR_BOOTSTRAP.md) | Validator node setup and operation |
| [docs/MONITORING.md](docs/MONITORING.md) | Monitoring, metrics, and alerting |
| [docs/UPGRADE_MECHANISM.md](docs/UPGRADE_MECHANISM.md) | Contract and protocol upgrade procedures |

---

## Tech Stack

| Layer | Technology |
|:------|:-----------|
| **Solana Programs** | Rust, Anchor 0.31, anchor-spl |
| **ZK Circuits** | Circom 2.x, Groth16, BN128, SnarkJS |
| **DCC Contracts** | RIDE v5 (DecentralChain) |
| **Validator** | TypeScript, Node.js, Ed25519, P2P |
| **ZK Prover** | TypeScript, SnarkJS, Keccak256 |
| **API** | TypeScript, Express |
| **Frontend** | React 18, Vite 5, Tailwind CSS 3, Zustand |
| **Wallet** | Phantom (Solana Wallet Adapter) |
| **Monitoring** | Prometheus, Grafana, custom anomaly detection |
| **Infrastructure** | Docker, Docker Compose |

---

## License

[MIT](LICENSE)

---

<div align="center">
<sub>Bridging Solana and DecentralChain with zero-knowledge proofs — because math doesn't lie.</sub>
</div>