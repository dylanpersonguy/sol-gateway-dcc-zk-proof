# Architecture — SOL ⇄ DecentralChain Bridge

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER LAYER                               │
│   React Frontend  ←→  Bridge API Server                         │
│   (Phantom + DCC)      (REST, no custody)                       │
└───────────┬─────────────────────┬───────────────────────────────┘
            │                     │
┌───────────▼─────────────────────▼───────────────────────────────┐
│                    CHAIN INTERACTION LAYER                       │
│                                                                  │
│  ┌──────────────────┐                ┌──────────────────────┐   │
│  │  Solana Lock      │                │  DCC Bridge          │   │
│  │  Program (PDA)    │                │  Controller (RIDE)   │   │
│  │                   │                │                      │   │
│  │  • Lock/Unlock    │                │  • Verify/Mint       │   │
│  │  • PDA Vault      │                │  • Burn/Redeem       │   │
│  │  • Event Emission │                │  • Rate Limits       │   │
│  └──────────────────┘                └──────────────────────┘   │
└───────────┬─────────────────────┬───────────────────────────────┘
            │                     │
┌───────────▼─────────────────────▼───────────────────────────────┐
│                  VALIDATOR CONSENSUS LAYER                       │
│                                                                  │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │ Val #1 │  │ Val #2 │  │ Val #3 │  │ Val #4 │  │ Val #5 │  │
│  │  (HSM) │  │  (HSM) │  │  (HSM) │  │  (HSM) │  │  (HSM) │  │
│  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘  │
│      │           │           │           │           │          │
│      └─────────┐ │ ┌─────────┘ ┌─────────┘           │          │
│                ▼ ▼ ▼           ▼                     ▼          │
│          BFT Consensus Engine (M-of-N = 3-of-5)                 │
│          • Watch both chains                                     │
│          • Wait for finality                                     │
│          • Produce signed attestations                           │
│          • Detect Byzantine behavior                             │
└───────────┬─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│                  MONITORING & SAFETY LAYER                       │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────────────────────┐    │
│  │ Anomaly Detection │  │ Circuit Breakers                  │    │
│  │ • Supply check    │  │ • Emergency Pause                 │    │
│  │ • Volume check    │  │ • Rate Limits (daily/per-tx)      │    │
│  │ • Validator check │  │ • Large TX delay                  │    │
│  │ • Chain sync      │  │ • Auto-pause on anomaly           │    │
│  └──────────────────┘  └──────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Multi-Channel Alerting                                    │  │
│  │ Slack • Telegram • PagerDuty • Webhook                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: SOL → wSOL.DCC (Deposit)

```
1. User submits deposit via frontend
2. Phantom wallet signs Solana transaction
3. Solana Lock Program:
   a. Validates amount, nonce, bridge status
   b. Transfers SOL to PDA vault
   c. Records deposit with unique transfer_id
   d. Emits BridgeDeposit event
4. Validators detect event via log subscription
5. Each validator waits for ≥32 confirmations
6. Each validator verifies tx still exists at finalized slot
7. Each validator signs canonical message
8. BFT consensus achieved (3-of-5 signatures)
9. Consensus submitter calls DCC bridge controller
10. DCC bridge controller:
    a. Verifies validator signatures
    b. Checks replay protection
    c. Checks rate limits
    d. Mints wSOL.DCC to recipient
11. Monitor independently verifies supply invariant
```

## Data Flow: wSOL.DCC → SOL (Redeem)

```
1. User burns wSOL.DCC via DCC wallet
2. DCC bridge controller:
   a. Burns the tokens
   b. Records burn with unique burn_id
3. Validators detect burn event via polling
4. Each validator waits for DCC confirmations
5. Each validator verifies burn in chain state
6. Each validator signs unlock attestation
7. BFT consensus achieved
8. Consensus submitter calls Solana unlock
9. Solana Lock Program:
   a. Verifies M-of-N validator signatures
   b. Checks replay protection
   c. Checks rate limits and daily outflow
   d. Applies large-withdrawal delay if needed
   e. Transfers SOL from vault to recipient
10. Monitor verifies supply invariant
```

## Key Management

| Component | Key Type | Storage | Access |
|-----------|----------|---------|--------|
| Bridge Authority | Ed25519 | HSM/Multisig | Config updates only |
| Guardian | Ed25519 | HSM (separate) | Emergency pause only |
| Validators (x5) | Ed25519 | HSM per validator | Attestation signing |
| Monitor Guardian | Ed25519 | HSM (monitoring) | Auto-pause trigger |
| PDA Vault | Program-derived | None (on-chain) | Only by program logic |

## Upgrade Strategy

1. Solana program: Use BPF upgradeable loader with authority multisig
2. DCC contract: Deploy new version, migrate state, update bridge address
3. Validator: Rolling upgrade with compatibility checks
4. API/Frontend: Standard CI/CD with blue-green deployment
5. All upgrades require 2-of-3 authority signatures
