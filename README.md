<div align="center">

# ⇄ sol-gateway-dcc

### Multi-Token Cross-Chain Bridge &nbsp;·&nbsp; Solana ↔ DecentralChain

[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF?style=flat-square&logo=solana&logoColor=white)](https://explorer.solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.31-blue?style=flat-square)](https://www.anchor-lang.com)
[![RIDE](https://img.shields.io/badge/RIDE-v5-00D4AA?style=flat-square)](https://docs.decentralchain.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

A trust-minimized, production-grade cross-chain gateway that bridges **17 tokens** between Solana and DecentralChain — including SOL, USDC, USDT, BTC, ETH, and more.

[Getting Started](#-getting-started) · [Architecture](#-architecture) · [Supported Tokens](#-supported-tokens) · [Security](#-security) · [Docs](#-documentation)

</div>

---

## Overview

**sol-gateway-dcc** is a bidirectional bridge enabling seamless asset transfers between the Solana and DecentralChain ecosystems. Assets deposited on Solana are locked in PDA-controlled vaults and wrapped tokens are minted on DecentralChain through multi-validator consensus.

### Key Highlights

- **17 Bridgeable Tokens** — SOL + 16 major SPL tokens with automatic decimal conversion
- **Lock & Mint Architecture** — 1:1 collateralized, no fractional reserve
- **M-of-N Validator Consensus** — Byzantine fault-tolerant attestation with threshold signatures
- **Defense in Depth** — Rate limiting, circuit breakers, anomaly detection, large-tx delays
- **Full-Stack** — Solana program (Rust/Anchor) + RIDE smart contract + React frontend + validator nodes + REST API + monitoring

---

## 🏗 Architecture

```
                    ┌──────────────────────────────────────────┐
                    │              User / Frontend             │
                    └──────────┬───────────────┬───────────────┘
                               │               │
                    ┌──────────▼──────┐ ┌──────▼──────────────┐
                    │  Solana Program │ │  DCC RIDE Contract   │
                    │  (Lock / Unlock)│ │  (Mint / Burn)       │
                    │  Anchor + SPL   │ │  Token Registry      │
                    └──────────┬──────┘ └──────┬──────────────┘
                               │               │
                    ┌──────────▼───────────────▼──────────────┐
                    │        Validator Consensus Layer         │
                    │   Solana Watcher → Consensus → DCC TX   │
                    │     Finality (32+ blocks) + TSS/MPC     │
                    └──────────┬──────────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────────┐
                    │        Risk & Monitoring Layer           │
                    │   Rate Limits · Circuit Breakers         │
                    │   Anomaly Detection · Alerting           │
                    └─────────────────────────────────────────┘
```

### Deposit Flow (Solana → DCC)

1. User deposits SOL or SPL tokens into the Solana vault (PDA-controlled)
2. Validator nodes detect the deposit after **≥32 block confirmations**
3. M-of-N validators attest via threshold signatures
4. Bridge controller on DCC mints the wrapped token and transfers to recipient
5. Transfer ID is recorded to prevent replay attacks

### Redemption Flow (DCC → Solana)

1. User burns wrapped tokens on DecentralChain
2. Validators verify the burn event
3. Consensus is reached through M-of-N attestation
4. Solana vault releases the original tokens to the user's wallet

---

## 🪙 Supported Tokens

All tokens are registered on-chain with automatic decimal conversion.

| Token | Symbol | Solana Mint | Sol Dec | DCC Dec | Category |
|:------|:-------|:------------|:-------:|:-------:|:---------|
| **Solana** | SOL → wSOL | `So111...1112` | 9 | 8 | Native |
| **USD Coin** | USDC → wUSDC | `EPjFW...Dt1v` | 6 | 6 | Stablecoin |
| **Tether** | USDT → wUSDT | `Es9vM...wNYB` | 6 | 6 | Stablecoin |
| **PayPal USD** | PYUSD → wPYUSD | `2b1kV...4GXo` | 6 | 6 | Stablecoin |
| **DAI** | DAI → wDAI | `EKpQG...zcjm` | 8 | 8 | Stablecoin |
| **Bitcoin** | BTC → wBTC | `3NZ9J...qmJh` | 8 | 8 | BTC |
| **Coinbase BTC** | cbBTC → wcbBTC | `cbbtc...iMij` | 8 | 8 | BTC |
| **Threshold BTC** | tBTC → wtBTC | `6DNSN...PzQq` | 8 | 8 | BTC |
| **Ether** | ETH → wETH | `7vfCX...voxs` | 8 | 8 | ETH |
| **Jito SOL** | JitoSOL → wJitoSOL | `J1tos...GCPn` | 9 | 8 | Ecosystem |
| **Jupiter** | JUP → wJUP | `JUPyi...dvCN` | 6 | 6 | Ecosystem |
| **Raydium** | RAY → wRAY | `4k3Dy...kX6R` | 6 | 6 | Ecosystem |
| **Pyth Network** | PYTH → wPYTH | `HZ1Jo...BCt3` | 6 | 6 | Ecosystem |
| **Render** | RNDR → wRNDR | `rndri...HBof` | 8 | 8 | Ecosystem |
| **Bonk** | BONK → wBONK | `DezXA...PB263` | 5 | 5 | Meme |
| **Pump.fun** | PUMP → wPUMP | `pumpC...9Dfn` | 6 | 6 | Meme |
| **Pudgy Penguins** | PENGU → wPENGU | `2zMMh...uauv` | 6 | 6 | Meme |

---

## 📂 Project Structure

```
sol-gateway-dcc/
├── programs/sol-bridge-lock/     # Solana on-chain program (Rust / Anchor)
│   └── src/
│       ├── lib.rs                #   Program entry point
│       ├── state.rs              #   Account structures
│       ├── instructions/         #   deposit, deposit_spl, unlock, initialize...
│       ├── events.rs             #   On-chain event definitions
│       └── errors.rs             #   Custom error codes
│
├── dcc-contracts/                # DecentralChain smart contracts (RIDE v5)
│   ├── bridge-controller/        #   Multi-token bridge logic (mint/burn/registry)
│   └── token-registry.cjs        #   SPL token configuration (16 tokens)
│
├── validator/                    # Validator / relayer node
│   └── src/
│       ├── watchers/             #   Solana & DCC chain watchers
│       ├── consensus/            #   BFT consensus engine
│       ├── signer/               #   Threshold signature (TSS/MPC)
│       └── main.ts               #   Entry point
│
├── api/                          # Bridge REST API
│   └── src/
│       ├── routes/               #   deposit, redeem, transfer, health, stats
│       ├── middleware/            #   Error handling, request logging
│       └── main.ts               #   Entry point
│
├── frontend/                     # React + Vite + Tailwind frontend
│   └── src/
│       ├── components/           #   BridgeInterface, TokenSelector, DepositForm...
│       ├── config/tokens.ts      #   Token definitions with logos
│       ├── hooks/                #   Zustand bridge store
│       ├── context/              #   Phantom wallet provider
│       └── services/             #   API client
│
├── monitoring/                   # Monitoring & anomaly detection
├── docs/                         # Architecture, security, deployment docs
├── scripts/                      # Deployment & utility scripts
├── tests/                        # E2E and security test suites
├── deploy-dcc.cjs                # DCC contract deployment script
├── e2e-test.cjs                  # End-to-end bridge test
└── docker-compose.yml            # Multi-validator local environment
```

---

## 🚀 Getting Started

### Prerequisites

- **Rust** (1.70+) with `cargo`
- **Solana CLI** (1.18+) & **Anchor** (0.31+)
- **Node.js** (18+) & **npm**
- **Docker** & **Docker Compose** (for DCC local chain)

### Installation

```bash
# Clone the repository
git clone https://github.com/dylanpersonguy/sol-gateway-dcc.git
cd sol-gateway-dcc

# Install all dependencies (npm workspaces)
npm install

# Build the Solana program
anchor build
```

### Local Development

```bash
# 1. Start the local DCC node
docker compose up -d dcc-node

# 2. Deploy DCC contracts + register all 17 tokens
node deploy-dcc.cjs

# 3. Run the end-to-end test
node e2e-test.cjs

# 4. Start the frontend
cd frontend && npx vite
```

### Deploy to Devnet

```bash
# Deploy Solana program
anchor deploy --provider.cluster devnet

# Program ID: 9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF
```

---

## 🔐 Security

### Design Principles

| Principle | Implementation |
|:----------|:---------------|
| **No single point of failure** | M-of-N validator consensus with threshold signatures |
| **No fund custody by externals** | PDA-controlled vaults — only the program can release funds |
| **No mint without proof** | Finality-verified (32+ blocks), consensus-attested deposits |
| **No unlock without burn proof** | Verified burn events required before vault release |
| **Circuit breakers** | Emergency pause, daily rate limits, large-tx delays |
| **Defense in depth** | Multiple independent security layers |

### Security Features

- **Rate Limiting** — Daily mint caps with automatic reset
- **Large Transaction Delay** — High-value mints require a waiting period before execution
- **Replay Protection** — Every transfer ID is recorded on-chain; duplicates are rejected
- **Emergency Pause** — Guardian can halt all operations instantly
- **Anomaly Detection** — Monitoring layer watches for unusual patterns

---

## 📚 Documentation

| Document | Description |
|:---------|:------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design and data flow |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | Attack vectors and mitigations |
| [AUDIT_CHECKLIST.md](docs/AUDIT_CHECKLIST.md) | Pre-audit security checklist |
| [SECURITY_TESTING.md](docs/SECURITY_TESTING.md) | Security test procedures |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment guide |
| [VALIDATOR_BOOTSTRAP.md](docs/VALIDATOR_BOOTSTRAP.md) | Validator node setup |
| [MONITORING.md](docs/MONITORING.md) | Monitoring and alerting |
| [UPGRADE_MECHANISM.md](docs/UPGRADE_MECHANISM.md) | Contract upgrade procedures |

---

## 🧪 Testing

```bash
# End-to-end bridge test (SOL → wSOL.DCC on local chain)
node e2e-test.cjs

# Solana program tests
anchor test

# Full test suite
npm run test:e2e
npm run test:security
```

All 17 tokens have been validated with `mintToken()` on the DCC chain — decimal conversion, asset registry lookup, reissuance, and balance transfer verified passing for every token.

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

| Variable | Description |
|:---------|:------------|
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `SOLANA_PROGRAM_ID` | Deployed Anchor program ID |
| `DCC_NODE_URL` | DecentralChain node URL |
| `DCC_BRIDGE_CONTRACT` | Bridge controller address on DCC |
| `WSOL_ASSET_ID` | wSOL.DCC asset ID |
| `DCC_VALIDATOR_SEED` | Validator wallet seed phrase |

---

## 🛠 Tech Stack

| Layer | Technology |
|:------|:-----------|
| **Solana Program** | Rust, Anchor 0.31, anchor-spl |
| **DCC Contract** | RIDE v5 (DecentralChain) |
| **Validator** | TypeScript, Node.js |
| **API** | TypeScript, Express |
| **Frontend** | React 18, Vite 5, Tailwind CSS 3, Zustand |
| **Wallet** | Phantom (Solana Wallet Adapter) |
| **Infrastructure** | Docker, Docker Compose, Prometheus |

---

## 📄 License

[MIT](LICENSE)

---

<div align="center">
<sub>Built with Rust, RIDE, TypeScript, and React — bridging Solana and DecentralChain.</sub>
</div>
