# Deployment Guide

## Prerequisites

- Rust 1.75+ with `solana` target
- Solana CLI 1.18+
- Anchor CLI 0.30+
- Node.js 20+
- Yarn 1.22+
- Docker & Docker Compose (for monitoring infra)
- Access to HSM hardware (production)

---

## Phase 1: Build & Test (Local)

### 1.1 Install Dependencies

```bash
# Root workspace
yarn install

# Rust/Anchor
rustup update
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --force
solana-install init 1.18.0
```

### 1.2 Build Solana Program

```bash
anchor build
# Verify program output
ls target/deploy/sol_bridge_lock.so
```

### 1.3 Run Local Tests

```bash
# Start local Solana validator
solana-test-validator &

# Run Anchor tests
anchor test

# Run validator unit tests
cd validator && yarn test

# Run API tests
cd api && yarn test
```

---

## Phase 2: Devnet Deployment

### 2.1 Configure Solana Devnet

```bash
solana config set --url devnet
solana airdrop 5  # Get devnet SOL
```

### 2.2 Deploy Solana Program

```bash
anchor deploy --provider.cluster devnet
# Note the program ID — update Anchor.toml and all configs
```

### 2.3 Initialize Bridge

```bash
# Run initialization script
ts-node scripts/initialize-bridge.ts \
  --network devnet \
  --guardian <GUARDIAN_PUBKEY> \
  --min-validators 2 \
  --max-validators 5 \
  --min-deposit 1000000 \
  --max-deposit 10000000000 \
  --max-daily-outflow 50000000000 \
  --required-confirmations 32
```

### 2.4 Deploy DCC Bridge Contract

```bash
# Deploy to DCC testnet
ts-node scripts/deploy-dcc-contracts.ts \
  --network testnet \
  --bridge-controller dcc-contracts/bridge-controller/bridge_controller.ride \
  --wsol-token dcc-contracts/wsol-token/wsol_token.ride
```

### 2.5 Register Validators

```bash
# For each validator
ts-node scripts/register-validator.ts \
  --network devnet \
  --validator-pubkey <VALIDATOR_PUBKEY>
```

---

## Phase 3: Validator Deployment

### 3.1 Environment Setup (per validator)

```bash
# Create .env file
cat > validator/.env << EOF
VALIDATOR_NODE_ID=validator-1
VALIDATOR_PRIVATE_KEY_PATH=./data/keys/validator.key
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=<PROGRAM_ID>
SOLANA_VAULT_PDA=<VAULT_PDA>
DCC_NODE_URL=https://testnet.decentralchain.io
DCC_BRIDGE_CONTRACT=<DCC_CONTRACT_ADDRESS>
DCC_CHAIN_ID=2
MIN_VALIDATORS=2
SOLANA_CONFIRMATIONS=32
DCC_CONFIRMATIONS=10
HSM_ENABLED=false
HEALTH_CHECK_PORT=8080
METRICS_PORT=9090
P2P_PORT=9000
EOF
```

### 3.2 Start Validator Node

```bash
cd validator
yarn build
yarn start
```

### 3.3 Verify Health

```bash
curl http://localhost:8080/health
```

---

## Phase 4: API & Frontend Deployment

### 4.1 API Server

```bash
cd api
cat > .env << EOF
API_PORT=3000
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=<PROGRAM_ID>
DCC_BRIDGE_CONTRACT=<DCC_CONTRACT_ADDRESS>
WSOL_ASSET_ID=<WSOL_ASSET_ID>
ALLOWED_ORIGINS=http://localhost:5173
EOF

yarn build && yarn start
```

### 4.2 Frontend

```bash
cd frontend
cat > .env << EOF
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
VITE_API_URL=http://localhost:3000/api/v1
EOF

yarn build
# Serve dist/ with your preferred static server
```

---

## Phase 5: Monitoring

```bash
cd monitoring
cat > .env << EOF
SOLANA_RPC_URL=https://api.devnet.solana.com
DCC_NODE_URL=https://testnet.decentralchain.io
SLACK_WEBHOOK_URL=<YOUR_SLACK_WEBHOOK>
MONITOR_PORT=9091
MIN_ACTIVE_VALIDATORS=2
EOF

yarn build && yarn start
```

---

## Phase 6: Production Deployment

### CRITICAL: Additional steps for mainnet

1. **HSM Setup:** Configure PKCS#11 HSMs for all validators and guardian
2. **Key Ceremony:** Multi-party key generation with video recording
3. **Audit:** Complete independent security audit (see AUDIT_CHECKLIST.md)
4. **Bug Bounty:** Launch program before mainnet deployment
5. **Gradual Rollout:**
   - Start with very low limits ($1K daily)
   - Increase limits weekly as confidence builds
   - Monitor all metrics continuously
6. **Insurance:** Arrange DeFi insurance coverage for TVL
7. **Incident Response:** Distribute runbook to all operators

### Production Config Differences

| Parameter | Devnet | Mainnet |
|-----------|--------|---------|
| min_validators | 2 | 3 |
| max_deposit | 10 SOL | 100 SOL |
| max_daily_outflow | 50 SOL | 1000 SOL |
| required_confirmations | 32 | 32 |
| large_withdrawal_delay | 10 min | 1 hour |
| HSM_ENABLED | false | true |
