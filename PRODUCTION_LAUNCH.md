# SOL ⇄ DecentralChain Bridge — Production Launch Checklist

## Status: READY FOR LAUNCH (pending Helius API key + SOL funding)

---

## ✅ Phase A — Infrastructure (COMPLETE)

| # | Item | Status |
|---|------|--------|
| 1 | ZK circuits compiled (3.58M constraints, R1CS + WASM) | ✅ Done |
| 2 | Groth16 ceremony (3 contributions + beacon → final zkey + verification_key.json) | ✅ Done |
| 3 | Solana program rebuilt (`anchor build` → sol_bridge_lock.so 378KB) | ✅ Done |
| 4 | DCC bridge contract verified on mainnet (173 entries, 17 tokens, 4 txs) | ✅ Done |

## ✅ Phase B — Configuration (COMPLETE)

| # | Item | Status |
|---|------|--------|
| 5 | `.env` switched to mainnet (Helius RPC, production origins, min_validators=3) | ✅ Done |
| 6 | `Anchor.toml` cluster set to `mainnet` | ✅ Done |
| 7 | Docker Compose hardened (health checks, resource limits, log rotation, dependency ordering) | ✅ Done |

---

## 🔲 Phase C — Deploy & Launch

### C1. Get Helius API Key
```bash
# 1. Sign up at https://dashboard.helius.dev
# 2. Create project → copy API key
# 3. Replace YOUR_HELIUS_API_KEY in .env (two places: SOLANA_RPC_URL and VITE_SOLANA_RPC_URL)
sed -i '' 's/YOUR_HELIUS_API_KEY/<your-actual-key>/g' .env
```

### C2. Fund Deployer Wallet
```bash
# Your deployer wallet:
solana address  # GaNkfy3fqnT71vKTJzx5hPf8oqz5UmfDfm7VtvJ7MTyc

# Send ~5 SOL from your funded wallet or exchange to this address
# Program deploy costs ~3.8 SOL for 378KB program
# Reserve ~1 SOL for initialize + register_validator txs

# Verify funding:
solana config set --url https://mainnet.helius-rpc.com/?api-key=<KEY>
solana balance
```

### C3. Deploy Solana Program to Mainnet
```bash
# Switch to mainnet
solana config set --url https://mainnet.helius-rpc.com/?api-key=<KEY>

# Deploy (uses ~3.8 SOL for rent-exempt storage)
solana program deploy target/deploy/sol_bridge_lock.so

# Record the new program ID and update .env:
# SOLANA_PROGRAM_ID=<new-mainnet-program-id>
# Also update Anchor.toml [programs.mainnet] section
```

### C4. Initialize Bridge On-Chain
```bash
# Initialize the bridge vault with guardian + validator config
npx ts-node scripts/initialize-bridge.ts

# This calls the `initialize` instruction with:
# - guardian: your deployer key
# - min_validators: 3
# - max_daily_outflow: 50 SOL
```

### C5. Register Validators
```bash
# Register each validator's public key
npx ts-node scripts/register-validator.ts --validator-key <PUBKEY_1>
npx ts-node scripts/register-validator.ts --validator-key <PUBKEY_2>
npx ts-node scripts/register-validator.ts --validator-key <PUBKEY_3>
```

### C6. Start Docker Services
```bash
# Build all images
docker compose build

# Start in order (health checks enforce dependency)
docker compose up -d

# Verify all healthy
docker compose ps
docker compose logs --tail=20 api
docker compose logs --tail=20 validator-1
```

### C7. Update DCC min_validators
```bash
# The DCC contract currently has min_validators=1
# Update to 3 to match production validator count
node deploy-dcc-mainnet.mjs --update-config min_validators=3
```

---

## 🔲 Phase D — Post-Launch Verification

### D1. Health Check
```bash
# API health
curl https://bridge-api.decentralchain.io/health

# Validator metrics
curl http://localhost:8080/health  # validator-1
curl http://localhost:8081/health  # validator-2
curl http://localhost:8082/health  # validator-3

# Prometheus
curl http://localhost:9100/api/v1/targets
```

### D2. Smoke Test
```bash
# Verify bridge state on Solana
npx ts-node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection(process.env.SOLANA_RPC_URL);
// Fetch bridge PDA and display state
"

# Send a small test deposit (0.001 SOL minimum)
# Monitor logs for validator consensus + DCC mint
```

### D3. Monitoring
- **Grafana**: http://localhost:3001 (set real `GF_ADMIN_PASSWORD` in .env)
- **Prometheus**: http://localhost:9100
- **Alerts**: Configure `SLACK_WEBHOOK_URL` and `PAGERDUTY_ROUTING_KEY` in .env when ready

### D4. Set Up Multisig (recommended)
```bash
# Transfer program upgrade authority to 2-of-3 Squads multisig
npx ts-node scripts/setup-multisig.ts
```

---

## Build Artifacts Summary

| Artifact | Path | Size |
|----------|------|------|
| Solana program | `target/deploy/sol_bridge_lock.so` | 378 KB |
| Program IDL | `target/idl/sol_bridge_lock.json` | 65 KB |
| TypeScript types | `target/types/sol_bridge_lock.ts` | 65 KB |
| ZK R1CS | `zk/circuits/build/bridge_deposit.r1cs` | 646 MB |
| ZK WASM | `zk/circuits/build/bridge_deposit_js/` | — |
| Groth16 final zkey | `zk/circuits/build/bridge_deposit_final.zkey` | 1.6 GB |
| Verification key | `zk/circuits/build/verification_key.json` | 4.1 KB |
| PTAU | `zk/circuits/build/powersOfTau28_hez_final_22.ptau` | 4.5 GB |

## DCC Bridge Contract (Mainnet)

| Property | Value |
|----------|-------|
| Address | `3Dcw59P4kGhWxTZKN4uGQgH9iWQanfRuMBG` |
| Registered tokens | 17 (SOL, USDC, USDT, BTC, ETH, BONK, RAY, PENGU, PYUSD, DAI, tBTC, ...) |
| Processed txs | 4 |
| Paused | false |
| min_validators | 1 (→ update to 3 at launch) |

## Security Reminders

- [ ] **Never commit `.env`** — it contains `DCC_VALIDATOR_SEED`
- [ ] Set `GF_ADMIN_PASSWORD` to a strong password (not `changeme_in_production`)
- [ ] Transfer upgrade authority to Squads multisig after launch stabilizes
- [ ] Rotate `DCC_VALIDATOR_SEED` if it was ever exposed
- [ ] Enable HSM for validator keys in production (set `HSM_ENABLED=true`)
- [ ] Set up backup/DR for validator key data volumes
