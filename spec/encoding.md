# Canonical Encoding Specification

## SOL ⇄ DCC ZK Bridge — Message Encoding v1.0

### 1. Overview

This document defines the **single canonical byte-level encoding** for all cross-chain bridge messages. Every component (Solana/Rust, TypeScript prover, DCC/Ride verifier, ZK circuit) MUST produce identical bytes and identical hashes for the same logical message.

**Failure mode**: If any implementation diverges by even one byte, Ed25519 signature verification fails, ZK proofs reject, and funds become stuck (liveness failure) — or worse, a safety failure allowing unauthorized mints/unlocks.

---

### 2. Message Envelope Schema

All integers are **little-endian** unless explicitly noted. All byte arrays are raw binary (no base58/base64 inside the hash preimage).

#### 2.1 Deposit Message (SOL → DCC Mint)

| # | Field | Type | Size (bytes) | Description |
|---|-------|------|-------------|-------------|
| 1 | `domain_sep` | ASCII bytes | 17 | `"DCC_SOL_BRIDGE_V1"` — fixed, never changes |
| 2 | `src_chain_id` | u32 LE | 4 | Solana chain ID (mainnet: 1) |
| 3 | `dst_chain_id` | u32 LE | 4 | DCC chain ID (mainnet: 2, or 63 for Ride chain byte) |
| 4 | `src_program_id` | bytes | 32 | Solana program ID (raw Pubkey bytes) |
| 5 | `slot` | u64 LE | 8 | Solana slot of the deposit transaction |
| 6 | `event_index` | u32 LE | 4 | Event index within the slot (derived from global_nonce) |
| 7 | `sender` | bytes | 32 | Depositor's Solana public key (raw 32 bytes) |
| 8 | `recipient` | bytes | 32 | DCC recipient (padded to 32 bytes if shorter) |
| 9 | `amount` | u64 LE | 8 | Amount in lamports |
| 10 | `nonce` | u64 LE | 8 | Per-user sequential nonce |
| 11 | `asset_id` | bytes | 32 | SPL mint address or native SOL sentinel |

**Total preimage**: 17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32 = **181 bytes**

**Message ID**: `message_id = Keccak256(preimage)` → 32 bytes

#### 2.2 Unlock Message (DCC → SOL Unlock)

| # | Field | Type | Size (bytes) | Description |
|---|-------|------|-------------|-------------|
| 1 | `domain_sep` | ASCII bytes | 24 | `"SOL_DCC_BRIDGE_UNLOCK_V1"` — fixed |
| 2 | `transfer_id` | bytes | 32 | Unique transfer/burn ID |
| 3 | `recipient` | bytes | 32 | Solana recipient public key (raw) |
| 4 | `amount` | u64 LE | 8 | Amount in lamports |
| 5 | `burn_tx_hash` | bytes | 32 | DCC burn transaction hash |
| 6 | `dcc_chain_id` | u32 LE | 4 | DCC chain ID |
| 7 | `expiration` | i64 LE | 8 | Unix timestamp deadline |

**Total preimage**: 24 + 32 + 32 + 8 + 32 + 4 + 8 = **140 bytes**

#### 2.3 Mint Attestation Message

| # | Field | Type | Size (bytes) | Description |
|---|-------|------|-------------|-------------|
| 1 | `domain_sep` | ASCII bytes | 22 | `"SOL_DCC_BRIDGE_V1_MINT"` — fixed |
| 2 | `transfer_id` | bytes | 32 | Transfer ID from deposit |
| 3 | `sender` | bytes | 32 | Depositor's Solana public key |
| 4 | `recipient` | bytes | 32 | DCC recipient |
| 5 | `amount` | u64 LE | 8 | Amount in lamports |
| 6 | `nonce` | u64 LE | 8 | User nonce |
| 7 | `slot` | u64 LE | 8 | Solana slot |
| 8 | `chain_id` | u32 LE | 4 | Source chain ID |
| 9 | `timestamp` | u64 LE | 8 | Attestation timestamp |

---

### 3. Encoding Rules

#### 3.1 Integer Encoding

- All `u32` values: 4 bytes, **little-endian**
- All `u64` values: 8 bytes, **little-endian**, unsigned
- All `i64` values: 8 bytes, **little-endian**, signed (two's complement)
- No variable-length integer encoding

#### 3.2 Address / Public Key Encoding

- **Solana Pubkey**: 32 raw bytes (no base58)
- **DCC Address**: 
  - If 26-byte address: left-padded to 32 bytes with trailing zeros
  - If 32-byte public key: used directly
  - **Inside hash preimage**: always exactly 32 bytes
- **SPL Mint / Asset ID**: 32 raw bytes

#### 3.3 Domain Separators

- Must be exact ASCII bytes (no null terminator)
- `"DCC_SOL_BRIDGE_V1"` = `0x4443435f534f4c5f4252494447455f5631` (17 bytes)
- `"SOL_DCC_BRIDGE_UNLOCK_V1"` = 24 bytes
- `"SOL_DCC_BRIDGE_V1_MINT"` = 22 bytes

#### 3.4 Hash Function

- **Primary**: Keccak-256 (for message_id and ZK circuit compatibility)
- **Ride**: blake2b256 for binding checks (Keccak not natively available in RIDE v6)
- **Transfer ID**: SHA-256 (`hash(sender || nonce)`)

#### 3.5 Prohibited Patterns

- ❌ No base58/base64 strings inside hash preimages
- ❌ No UTF-8 encoded strings (ASCII only for domain separators)
- ❌ No variable-length fields without explicit length prefix
- ❌ No implicit type coercion or silent truncation
- ❌ No big-endian integers (all LE)

---

### 4. RIDE-Specific Constraints

RIDE v6 has the following constraints affecting encoding:

1. **Keccak-256 available**: RIDE v6 provides `keccak256()` natively. The contract uses `keccak256()` for message_id computation, matching Solana and TypeScript. (`blake2b256()` and `sha256()` are also available but NOT used for message_id.)
2. **Integer handling**: All integers are `Int` (64-bit signed). For encoding:
   - Use `toBytes(Int)` which produces 8-byte big-endian
   - Must manually convert to LE using byte extraction: `toBytes(n).drop(7).take(1)` etc.
3. **ByteVector ops**: `+` for concatenation, `.drop(n)`, `.take(n)`, `.size()`
4. **Max complexity**: ~26,000 complexity units. Full 181-byte preimage reconstruction + keccak256 is feasible (~3,000 complexity)
5. **Storage**: Data entries with string keys, max key length ~100 chars

#### 4.1 RIDE LE Encoding Helpers

```ride
func intToLE4(n: Int) -> ByteVector = {
  let b = toBytes(n)       # 8-byte big-endian
  b.drop(7).take(1) +      # byte 0 (LSB)
  b.drop(6).take(1) +      # byte 1  
  b.drop(5).take(1) +      # byte 2
  b.drop(4).take(1)         # byte 3 (MSB for u32)
}

func intToLE8(n: Int) -> ByteVector = {
  let b = toBytes(n)       # 8-byte big-endian
  b.drop(7).take(1) +      # byte 0 (LSB)
  b.drop(6).take(1) +
  b.drop(5).take(1) +
  b.drop(4).take(1) +
  b.drop(3).take(1) +
  b.drop(2).take(1) +
  b.drop(1).take(1) +
  b.take(1)                 # byte 7 (MSB)
}
```

---

### 5. ZK Public Input Packing

The ZK circuit (Groth16 over BN128) accepts 8 public inputs, each a BN128 scalar field element:

| Input # | Source | Encoding |
|---------|--------|----------|
| 0 | `checkpoint_root[0..16]` | First 16 bytes of Merkle root as uint |
| 1 | `checkpoint_root[16..32]` | Last 16 bytes of Merkle root as uint |
| 2 | `message_id[0..16]` | First 16 bytes of message_id as uint |
| 3 | `message_id[16..32]` | Last 16 bytes of message_id as uint |
| 4 | `amount` | u64 value (fits in field) |
| 5 | `recipient[0..16]` | First 16 bytes of raw recipient address |
| 6 | `recipient[16..32]` | Last 16 bytes of raw recipient address |
| 7 | `version` | Protocol version (must equal 1) |

**Byte splitting**: 32-byte values are split into two 16-byte halves, each interpreted as a little-endian unsigned 128-bit integer, to fit within the BN128 scalar field (~254 bits). This matches the `hashToFieldElements()` function in the TypeScript prover.

**RIDE packing**: Use `bn256Groth16Verify(vk, proof, inputs)` where `inputs` is a concatenated byte array of 8 × 32-byte big-endian field elements.

---

### 6. Golden Test Vector

**Input**:
- `domain_sep` = "DCC_SOL_BRIDGE_V1"
- `src_chain_id` = 1
- `dst_chain_id` = 2
- `src_program_id` = `82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302`
- `slot` = 1000
- `event_index` = 0
- `sender` = `0000000000000000000000000000000000000000000000000000000000000000`
- `recipient` = `0101010101010101010101010101010101010101010101010101010101010101`
- `amount` = 1,000,000,000 (1 SOL)
- `nonce` = 0
- `asset_id` = `069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001`

**Expected message_id**: `0x6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444`

This value is verified across Rust (`compute_message_id` in deposit.rs) and TypeScript prover.

---

### 7. Implementation Checklist

- [x] Rust encoder (`deposit.rs::compute_message_id`) — produces 181-byte preimage, Keccak-256
- [x] TypeScript encoder (`libs/encoding-ts`) — identical preimage construction
- [x] RIDE encoder (`zk_bridge.ride::computeMessageId`) — uses keccak256 with identical LE helpers
- [x] ZK circuit public input derivation — splits message_id into field elements
- [x] Golden test vector passes in all implementations
- [ ] CI enforcement of cross-language equivalence

---

### 8. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-01-27 | Initial canonical specification |
