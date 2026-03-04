# Rate Limit Configuration — Production Tuning Guide

## Overview

Rate limits protect the bridge from DoS attacks, flash-loan exploits, and
accidental overload. Limits are enforced at three layers:

1. **On-chain** — Solana program enforces per-user nonce progression and max deposit
2. **API gateway** — Express middleware rate limits by IP and by wallet
3. **Monitoring** — Anomaly detector triggers alerts and auto-pause

## Recommended Production Limits

### On-Chain (Solana Program — `BridgeConfig`)

| Parameter                | Value          | Notes                                |
|--------------------------|----------------|--------------------------------------|
| `max_deposit`            | 100 SOL        | Per-transaction cap                  |
| `min_deposit`            | 0.001 SOL      | Dust prevention                      |
| `max_unlock`             | 100 SOL        | Per-transaction cap (unlock side)    |
| `cooldown_seconds`       | 10             | Per-user deposit cooldown            |

These are enforced in `deposit.rs` and `unlock.rs` via `BridgeConfig` fields.

### API Gateway (Express Middleware)

```env
# Global limits
API_RATE_LIMIT_GLOBAL=100         # requests/min across all endpoints
API_RATE_LIMIT_DEPOSIT=30         # deposit requests/min (global)
API_RATE_LIMIT_UNLOCK=30          # unlock requests/min (global)

# Per-IP limits
API_RATE_LIMIT_PER_IP=20          # requests/min per IP address
API_RATE_LIMIT_DEPOSIT_PER_IP=5   # deposit requests/min per IP

# Per-wallet limits
API_RATE_LIMIT_PER_WALLET=10      # requests/min per wallet address
API_RATE_LIMIT_DEPOSIT_PER_WALLET=3  # deposit requests/min per wallet
```

### Monitoring Thresholds

```env
# Transaction rate alerts
MAX_TX_PER_MIN=30                  # Alert if >30 tx/min
MAX_HOURLY_VOLUME=500000000000     # 500 SOL/hour (alert threshold)
LARGE_TX_THRESHOLD=50000000000     # 50 SOL (flag large transactions)

# Validator health
MIN_ACTIVE_VALIDATORS=3            # Critical if <3 active

# Supply drift
MAX_SUPPLY_DRIFT_PERCENT=0.001     # 0.1% (warning threshold)
```

## Load Test Profiles

Run with: `npx ts-node scripts/load-test.ts --profile <name>`

| Profile  | Rate      | Duration | Users | Purpose                        |
|----------|-----------|----------|-------|--------------------------------|
| `low`    | 5 tx/min  | 5 min    | 3     | Normal mainnet volume          |
| `medium` | 20 tx/min | 5 min    | 10    | Peak expected volume           |
| `high`   | 60 tx/min | 3 min    | 20    | 3× peak (stress test)          |
| `stress` | 200 tx/min| 2 min    | 50    | DDoS simulation                |

### Expected Results

| Profile  | p50 Latency | p99 Latency | Success Rate | Rate Limited |
|----------|-------------|-------------|--------------|--------------|
| `low`    | < 500ms     | < 2s        | > 99%        | 0%           |
| `medium` | < 1s        | < 5s        | > 95%        | < 5%         |
| `high`   | < 2s        | < 10s       | > 80%        | < 20%        |
| `stress` | < 5s        | < 30s       | > 50%        | > 30%        |

## Tuning Process

### 1. Baseline (Localnet)

```bash
# Start localnet
solana-test-validator

# Run low profile
npx ts-node scripts/load-test.ts --profile low
```

### 2. Scale Up

```bash
# Run medium, then high
npx ts-node scripts/load-test.ts --profile medium
npx ts-node scripts/load-test.ts --profile high
```

### 3. Analyze Results

- If **p99 > 10s**: Increase Solana RPC connection pool or use a dedicated RPC
- If **rate limited > 20%**: Increase API_RATE_LIMIT_GLOBAL
- If **success rate < 90%** on medium: Check validator health and RPC reliability
- If **success rate < 50%** on stress: This is expected — verify monitoring fires alerts

### 4. Production Deployment

After tuning on devnet, deploy with conservative limits:

```env
# Start conservative, increase after monitoring
API_RATE_LIMIT_GLOBAL=50
API_RATE_LIMIT_DEPOSIT=15
API_RATE_LIMIT_PER_IP=10
MAX_TX_PER_MIN=20
MAX_HOURLY_VOLUME=200000000000
```

Scale up limits gradually as real traffic patterns emerge (first week).

## Alert Thresholds

| Metric                    | Warning          | Critical        | Action        |
|---------------------------|------------------|-----------------|---------------|
| TX rate                   | > 30/min         | > 100/min       | Auto-pause    |
| Hourly volume             | > 200 SOL        | > 500 SOL       | Auto-pause    |
| Single TX                 | > 50 SOL         | > 100 SOL       | Alert only    |
| Supply drift              | > 0.1%           | > 1%            | Auto-pause    |
| Vault depletion rate      | Empty in < 24h   | Empty in < 4h   | Auto-pause    |
| Active validators         | < 5              | < 3             | Auto-pause    |
| Chain latency             | > 10s            | > 30s           | Alert only    |
| Unlocks in 10min          | > 5              | > 10            | Auto-pause    |
