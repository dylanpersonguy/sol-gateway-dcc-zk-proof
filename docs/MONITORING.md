# Monitoring Strategy

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Solana Node  │     │  DCC Node   │     │  Validator   │
│ (full node)  │     │ (full node) │     │   Nodes x5   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                    │
       └───────────┬───────┘                    │
                   │                            │
         ┌─────────▼──────────┐       ┌────────▼────────┐
         │  Independent        │       │  Validator       │
         │  Monitor Node       │       │  Metrics (x5)    │
         │  (anomaly detection)│       │  (Prometheus)     │
         └─────────┬──────────┘       └────────┬────────┘
                   │                            │
         ┌─────────▼────────────────────────────▼─────────┐
         │                  Prometheus                      │
         └──────────────────────┬──────────────────────────┘
                                │
                   ┌────────────▼────────────┐
                   │       Grafana           │
                   │    (Dashboards)         │
                   └────────────┬────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
        ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
        │   Slack    │   │  Telegram   │   │  PagerDuty  │
        │  (warn+)   │   │ (critical+) │   │ (emergency) │
        └───────────┘   └─────────────┘   └─────────────┘
```

## Key Metrics

### Supply Invariant (MOST CRITICAL)

```
metric: bridge_supply_invariant_valid
type: gauge (0 or 1)
check_interval: 30 seconds
alert_threshold: 0 (immediately critical)
```

**locked_sol** - Solana vault balance
**wsol_supply** - wSOL.DCC total supply
**invariant** = locked_sol >= wsol_supply

If invariant fails → **EMERGENCY PAUSE AUTOMATIC**

### Transfer Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `bridge_deposits_total` | counter | Total deposits initiated |
| `bridge_mints_total` | counter | Total wSOL.DCC minted |
| `bridge_burns_total` | counter | Total wSOL.DCC burned |
| `bridge_unlocks_total` | counter | Total SOL unlocked |
| `bridge_transfer_duration_seconds` | histogram | End-to-end transfer time |
| `bridge_transfer_amount_lamports` | histogram | Transfer amount distribution |
| `bridge_daily_volume_lamports` | gauge | Rolling 24h volume |

### Validator Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `bridge_validator_active` | gauge | Is this validator active (0/1) |
| `bridge_consensus_rounds_total` | counter | Consensus rounds participated |
| `bridge_consensus_reached_total` | counter | Successful consensus rounds |
| `bridge_consensus_failed_total` | counter | Failed consensus rounds |
| `bridge_signatures_produced` | counter | Signatures created |
| `bridge_attestation_latency_ms` | histogram | Time to produce attestation |
| `bridge_peer_count` | gauge | Connected validator peers |

### Chain Health Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `bridge_solana_slot` | gauge | Latest processed Solana slot |
| `bridge_solana_latency_ms` | gauge | Solana RPC response time |
| `bridge_dcc_height` | gauge | Latest processed DCC height |
| `bridge_dcc_latency_ms` | gauge | DCC node response time |
| `bridge_pending_events` | gauge | Events awaiting finality |

## Alert Rules

### Emergency (Auto-Pause + PagerDuty)

```yaml
- alert: SupplyInvariantViolation
  expr: bridge_supply_invariant_valid == 0
  for: 0s
  severity: emergency
  action: auto_pause

- alert: AllValidatorsDown
  expr: sum(bridge_validator_active) < min_validators
  for: 1m
  severity: emergency
  action: auto_pause

- alert: AbnormalVolumeSpike
  expr: rate(bridge_daily_volume_lamports[1h]) > 10 * avg_over_time(bridge_daily_volume_lamports[7d])
  for: 5m
  severity: emergency
  action: auto_pause
```

### Critical (PagerDuty + Telegram)

```yaml
- alert: ValidatorDown
  expr: bridge_validator_active == 0
  for: 5m
  severity: critical

- alert: ConsensusFailureRate
  expr: rate(bridge_consensus_failed_total[1h]) / rate(bridge_consensus_rounds_total[1h]) > 0.2
  for: 10m
  severity: critical

- alert: HighTransferLatency
  expr: bridge_transfer_duration_seconds > 600
  for: 5m
  severity: critical
```

### Warning (Slack)

```yaml
- alert: HighChainLatency
  expr: bridge_solana_latency_ms > 5000 or bridge_dcc_latency_ms > 5000
  for: 5m
  severity: warning

- alert: LargeTransfer
  expr: bridge_transfer_amount_lamports > large_tx_threshold
  severity: warning

- alert: DailyVolumeHigh
  expr: bridge_daily_volume_lamports > max_daily_outflow * 0.8
  severity: warning
```

## Dashboards

### 1. Bridge Overview Dashboard
- Total Value Locked (TVL) graph
- Supply invariant status (big green/red indicator)
- Transfer count (24h, 7d, 30d)
- Volume (24h, 7d, 30d)
- Active validators count
- Bridge status (paused/active)

### 2. Transfer Dashboard
- Real-time transfer flow
- Transfer duration distribution
- Transfer amount distribution
- Success/failure rate
- Pending transfers count

### 3. Validator Dashboard
- Per-validator health status
- Consensus participation rate
- Attestation latency
- Peer connectivity
- Key rotation status

### 4. Security Dashboard
- Supply invariant trend
- Anomaly alerts timeline
- Rate limit utilization
- Large transaction log
- Circuit breaker status

## Log Aggregation

All components ship structured JSON logs to a central aggregator:

```json
{
  "timestamp": "2026-03-02T12:00:00Z",
  "level": "info",
  "component": "SolanaWatcher",
  "nodeId": "validator-1",
  "message": "Event finalized",
  "transferId": "abc123...",
  "amount": "1000000000",
  "confirmations": 35
}
```

**Retention:** 90 days minimum, 1 year for security events.
