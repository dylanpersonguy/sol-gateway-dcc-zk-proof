# Canonical Encoding Specification v2.0

## SOL ⇄ DCC ZK Bridge — Cross-Language Message Encoding

> **Single source of truth** for every byte produced by every component.  
> Every implementation MUST produce identical bytes and identical hashes.

---

## Table of Contents

1. [Design Decisions](#1-design-decisions)
2. [Deposit Message Schema](#2-deposit-message-schema)
3. [Unlock Message Schema](#3-unlock-message-schema)
4. [Encoding Rules](#4-encoding-rules)
5. [Hash Function](#5-hash-function)
6. [ZK Public Input Packing](#6-zk-public-input-packing)
7. [RIDE-Specific Constraints](#7-ride-specific-constraints)
8. [Library API Contract](#8-library-api-contract)
9. [Negative/Failure Cases](#9-negativefailure-cases)
10. [Golden Test Vector](#10-golden-test-vector)
11. [Implementation Checklist](#11-implementation-checklist)
12. [Version History](#12-version-history)

---

## 1. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integer endianness | **Little-endian** | Matches Solana/Anchor native, Circom bit decomposition |
| Hash function | **Keccak-256** | Available natively in RIDE v6, supported in Circom |
| Field sizes | **All fixed** | No variable-length fields in hash preimage — eliminates length-extension and padding ambiguity |
| Address encoding | **Raw 32 bytes** | No base58/base64 inside the hash preimage |
| Domain separation | **ASCII bytes, no null terminator** | Fixed per message type, never changes within a protocol version |
| ZK field element packing | **128-bit LE halves** | Fits in BN128 scalar field (254 bits), matches Circom `Num2Bits(128)` |

### Prohibited Patterns

- ❌ No base58 or base64 strings inside hash preimages
- ❌ No UTF-8 beyond ASCII (domain separators are 7-bit ASCII only)
- ❌ No variable-length fields without explicit length prefix
- ❌ No implicit type coercion, no silent truncation
- ❌ No big-endian integers (all integers are LE)
- ❌ No null terminators in domain separators
- ❌ No length prefixes on fixed-length byte arrays
- ❌ No "close enough" encodings — byte-identical or fail

---

## 2. Deposit Message Schema

**Direction:** SOL → DCC (lock on Solana, mint on DCC)

| # | Field | Type | Size (bytes) | Offset | Description |
|---|-------|------|-------------|--------|-------------|
| 1 | `domain_sep` | ASCII | 17 | 0 | `"DCC_SOL_BRIDGE_V1"` — fixed, never changes |
| 2 | `src_chain_id` | u32 LE | 4 | 17 | Source chain (Solana mainnet: `1`) |
| 3 | `dst_chain_id` | u32 LE | 4 | 21 | Destination chain (DCC mainnet: `2`) |
| 4 | `src_program_id` | bytes | 32 | 25 | Solana bridge program ID (raw Ed25519 pubkey bytes) |
| 5 | `slot` | u64 LE | 8 | 57 | Solana slot of the deposit transaction |
| 6 | `event_index` | u32 LE | 4 | 65 | Event index within the slot (derived from `global_nonce`) |
| 7 | `sender` | bytes | 32 | 69 | Depositor's Solana public key (raw 32 bytes) |
| 8 | `recipient` | bytes | 32 | 101 | DCC recipient address (raw 32 bytes, padded if shorter) |
| 9 | `amount` | u64 LE | 8 | 133 | Amount in lamports (1 SOL = 10^9 lamports) |
| 10 | `nonce` | u64 LE | 8 | 141 | Per-user sequential nonce |
| 11 | `asset_id` | bytes | 32 | 149 | SPL mint address or native SOL sentinel (raw 32 bytes) |

**Total preimage size:** `17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32 = 181 bytes` (fixed)

**Message ID:** `message_id = Keccak256(preimage)` → 32 bytes

### Byte Layout Diagram

```
Offset:  0         17  21  25                    57  65  69
         ├─────────┼───┼───┼────────────────────┼───┼───┼──
         │domain(17)│s_c│d_c│  src_program_id(32) │slt│idx│
         └─────────┴───┴───┴────────────────────┴───┴───┴──

Offset:  69                   101                  133 141 149              181
         ├───────────────────┼───────────────────┼───┼───┼──────────────────┤
         │   sender(32)      │  recipient(32)    │amt│non│  asset_id(32)    │
         └───────────────────┴───────────────────┴───┴───┴──────────────────┘
```

---

## 3. Unlock Message Schema

**Direction:** DCC → SOL (burn on DCC, unlock on Solana)

| # | Field | Type | Size (bytes) | Offset | Description |
|---|-------|------|-------------|--------|-------------|
| 1 | `domain_sep` | ASCII | 24 | 0 | `"SOL_DCC_BRIDGE_UNLOCK_V1"` — fixed |
| 2 | `transfer_id` | bytes | 32 | 24 | Unique transfer/burn ID |
| 3 | `recipient` | bytes | 32 | 56 | Solana recipient public key (raw 32 bytes) |
| 4 | `amount` | u64 LE | 8 | 88 | Amount in lamports |
| 5 | `burn_tx_hash` | bytes | 32 | 96 | DCC burn transaction hash |
| 6 | `dcc_chain_id` | u32 LE | 4 | 128 | DCC chain ID |
| 7 | `expiration` | i64 LE | 8 | 132 | Unix timestamp deadline (signed, two's complement) |

**Total preimage size:** `24 + 32 + 32 + 8 + 32 + 4 + 8 = 140 bytes` (fixed)

---

## 4. Encoding Rules

### 4.1 Integer Encoding

| Type | Bytes | Endianness | Notes |
|------|-------|------------|-------|
| `u8` | 1 | N/A | Single byte |
| `u32` | 4 | Little-endian | `value.to_le_bytes()` in Rust, manual LE in RIDE |
| `u64` | 8 | Little-endian | Unsigned; LSB at lowest offset |
| `i64` | 8 | Little-endian | Two's complement; `-1` = `0xFFFFFFFFFFFFFFFF` |

**Rust:** `value.to_le_bytes()` produces the correct byte order.
**TypeScript:** Manual byte extraction: `buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xFFn)`.
**RIDE:** Manual extraction via `toBytes(v % 256).drop(7)` for each byte (see Section 7).

### 4.2 Address / Public Key Encoding

| Address Type | Raw Size | In Preimage | Encoding |
|-------------|----------|-------------|----------|
| Solana Pubkey | 32 bytes | 32 bytes | Raw Ed25519 public key (no base58) |
| DCC Address | 26 bytes | 32 bytes | Right-padded with zeros to 32 bytes |
| DCC Public Key | 32 bytes | 32 bytes | Raw bytes directly |
| SPL Mint / Asset | 32 bytes | 32 bytes | Raw bytes directly |

### 4.3 Domain Separators

Domain separators are **fixed ASCII byte strings** with no null terminator and no length prefix.

| Message Type | Domain Separator | Hex | Length |
|-------------|-----------------|-----|--------|
| Deposit | `"DCC_SOL_BRIDGE_V1"` | `4443435f534f4c5f4252494447455f5631` | 17 |
| Unlock | `"SOL_DCC_BRIDGE_UNLOCK_V1"` | `534f4c5f4443435f4252494447455f554e4c4f434b5f5631` | 24 |
| Mint | `"SOL_DCC_BRIDGE_V1_MINT"` | `534f4c5f4443435f4252494447455f56315f4d494e54` | 22 |

### 4.4 Transfer ID

`transfer_id = SHA-256(sender || nonce)` where:
- `sender` is 32 raw bytes
- `nonce` is 8 bytes LE (u64)

---

## 5. Hash Function

### Primary Hash: Keccak-256

All `message_id` computations use **Keccak-256** (the Ethereum variant, NOT NIST SHA-3).

```
message_id = Keccak256(message_bytes)  →  32 bytes
```

**Implementations:**
| Language | Library | Function |
|----------|---------|----------|
| Rust | `solana_program::keccak` / `sha3::Keccak256` | `keccak::hash(&data)` |
| TypeScript | `@noble/hashes/sha3` | `keccak_256(data)` |
| RIDE | Built-in | `keccak256(byteVector)` |
| Circom | Custom Keccak circuit | `Keccak256Bits(n)` |

> **WARNING:** `SHA-3` (NIST FIPS 202) differs from `Keccak-256` (pre-NIST) by the padding byte (`0x06` vs `0x01`). Always use the pre-NIST Keccak-256.

### Leaf Hash (Merkle Tree)

```
leaf = Keccak256(0x00 || message_id)
```

The `0x00` prefix (1 byte) follows RFC 6962 §2.1 to domain-separate leaves from internal nodes.

### Internal Node Hash (Merkle Tree)

```
node = Keccak256(0x01 || left || right)
```

---

## 6. ZK Public Input Packing

The Groth16 circuit (`bridge_deposit.circom`) accepts exactly **8 public field elements** for compatibility with RIDE's `groth16Verify_8inputs`.

### 6.1 Field Element Layout

| Input # | Name | Source | Bits |
|---------|------|--------|------|
| 0 | `checkpoint_root_lo` | Root bytes [0..16] as LE u128 | 128 |
| 1 | `checkpoint_root_hi` | Root bytes [16..32] as LE u128 | 128 |
| 2 | `message_id_lo` | msg_id bytes [0..16] as LE u128 | 128 |
| 3 | `message_id_hi` | msg_id bytes [16..32] as LE u128 | 128 |
| 4 | `amount` | Deposit amount in lamports | 64 |
| 5 | `recipient_lo` | Recipient bytes [0..16] as LE u128 | 128 |
| 6 | `recipient_hi` | Recipient bytes [16..32] as LE u128 | 128 |
| 7 | `version` | Protocol version (must equal `1`) | 32 |

### 6.2 Byte Splitting Rule

To convert a 32-byte value into two field elements:

```
bytes32 = [b0, b1, ..., b31]

lo = b0 + b1×2^8 + b2×2^16 + ... + b15×2^120   (bytes 0..15 as LE u128)
hi = b16 + b17×2^8 + b18×2^16 + ... + b31×2^120 (bytes 16..31 as LE u128)
```

Both `lo` and `hi` are guaranteed < 2^128 < BN128_ORDER (≈2^254), so they always fit in a single field element.

**BN128 scalar field order:** `21888242871839275222246405745257275088548364400416034343698204186575808495617`

### 6.3 RIDE Input Packing

For `bn256Groth16Verify(vk, proof, inputs)`, the `inputs` parameter is a **concatenation of 8 × 32-byte big-endian** representations of each field element:

```
inputs = concat(
  field_to_32_bytes_BE(checkpoint_root_lo),
  field_to_32_bytes_BE(checkpoint_root_hi),
  field_to_32_bytes_BE(message_id_lo),
  field_to_32_bytes_BE(message_id_hi),
  field_to_32_bytes_BE(amount),
  field_to_32_bytes_BE(recipient_lo),
  field_to_32_bytes_BE(recipient_hi),
  field_to_32_bytes_BE(version)
)
```

Total: 256 bytes.

### 6.4 Binding Properties

All 8 public inputs are **deterministically derived** from the deposit message and checkpoint:

| Public Input | Derived From | Binding |
|-------------|--------------|---------|
| root_lo/hi | Merkle root of deposit tree | Binds proof to specific checkpoint |
| message_id_lo/hi | Keccak256 of 181-byte preimage | Binds ALL deposit fields via hash |
| amount | `envelope.amount` | Direct binding; circuit verifies match |
| recipient_lo/hi | `envelope.recipient` | Direct binding; circuit verifies match |
| version | Hardcoded `1` | Circuit enforces `version === 1` |

No "off-chain chosen" values are permitted.

---

## 7. RIDE-Specific Constraints

### 7.1 Available Operations

RIDE v6 provides:
- `keccak256(ByteVector)` — native Keccak-256 ✓
- `toBytes(String)` — UTF-8 encoding (no length prefix in RIDE v6) ✓
- `toBytes(Int)` — 8-byte **big-endian** ✓
- ByteVector concat (`+`), `drop(n)`, `take(n)`, `size()` ✓
- `groth16Verify_8inputs(vk, proof, inputs)` — Groth16 on BN128 ✓

### 7.2 LE Integer Encoding Helpers

```ride
func intToLE4(v: Int) = {
    let b0 = v % 256
    let b1 = (v / 256) % 256
    let b2 = (v / 65536) % 256
    let b3 = (v / 16777216) % 256
    toBytes(b0).drop(7) + toBytes(b1).drop(7) + toBytes(b2).drop(7) + toBytes(b3).drop(7)
}

func intToLE8(v: Int) = {
    let b0 = v % 256
    let b1 = (v / 256) % 256
    let b2 = (v / 65536) % 256
    let b3 = (v / 16777216) % 256
    let b4 = (v / 4294967296) % 256
    let b5 = (v / 1099511627776) % 256
    let b6 = (v / 281474976710656) % 256
    let b7 = (v / 72057594037927936) % 256
    toBytes(b0).drop(7) + toBytes(b1).drop(7) + toBytes(b2).drop(7) + toBytes(b3).drop(7) +
    toBytes(b4).drop(7) + toBytes(b5).drop(7) + toBytes(b6).drop(7) + toBytes(b7).drop(7)
}
```

### 7.3 Domain Separator Verification

The contract verifies `size(toBytes(domainSeparator)) == 17` at runtime to guard against hypothetical RIDE behavior changes.

### 7.4 Complexity Budget

Full 181-byte preimage + `keccak256()` ≈ 3,000 complexity units out of ~26,000.

### 7.5 Limitations

| Limitation | Impact | Compensating Control |
|-----------|--------|---------------------|
| RIDE `Int` is signed 64-bit | Cannot represent u64 values > 2^63-1 | Rate limits keep amounts in safe range |
| No native u128 | Field element splitting must be manual | Pre-computed by prover, verified via ZK proof |
| No unit testing harness | Cannot run `assert()` offline | Cross-language vector tests verify encoding |

---

## 8. Library API Contract

Every encoding library MUST expose:

```
encodeDepositMessage(envelope) → bytes     (exactly 181 bytes)
encodeUnlockMessage(envelope)  → bytes     (exactly 140 bytes)
hashMessage(bytes)             → 32 bytes  (Keccak-256)
computeDepositMessageId(env)   → 32 bytes  (convenience)
computeLeafHash(messageId)     → 32 bytes  (Keccak256(0x00 || id))
splitTo128(bytes32)            → [lo, hi]  (128-bit LE halves)
derivePublicInputs(msgId, amount, recipient) → 8 field elements
parseDepositMessage(bytes)     → envelope  (optional, round-trip)
```

**Fail-closed policy:** Throw/error on any field size mismatch, invalid domain separator, or unexpected preimage length. No silent truncation ever.

---

## 9. Negative/Failure Cases

| Condition | Expected Behavior |
|-----------|-------------------|
| `src_program_id.length ≠ 32` | Throw/error |
| `sender.length ≠ 32` | Throw/error |
| Single byte mutation in any field | Hash MUST differ |
| Wrong hash function (SHA3 vs Keccak) | Different output — fail |
| Domain sep `"V2"` vs `"V1"` | Different hash — test as negative |

---

## 10. Golden Test Vector

See `test-vectors.json` V-001. Expected message_id: `6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444`

---

## 11. Ride Adaptation — Constraints & Compensating Controls

### 11.1 Available Operations & Complexity Budget

| Operation | RIDE v6 Function | Complexity | Notes |
|-----------|-----------------|------------|-------|
| Keccak-256 | `keccak256(ByteVector)` | 200 | Pre-NIST variant (matches Ethereum) ✓ |
| Blake2b-256 | `blake2b256(ByteVector)` | 200 | Available but NOT used (keccak chosen for circuit compat) |
| Groth16 verify | `groth16Verify_8inputs(vk, proof, inputs)` | ~16,800 | BN256 curve, 8 public inputs |
| ByteVector concat | `bv1 + bv2` | 2 | Used extensively for preimage assembly |
| ByteVector slice | `take(bv, n)`, `drop(bv, n)` | 7 each | Used for field element extraction |
| Int to bytes | `toBytes(Int)` | 1 | Produces 8-byte **big-endian** — NOT usable directly |
| String to bytes | `toBytes(String)` | 10 | UTF-8, no length prefix in RIDE v6 |
| Address from pubkey | `addressFromPublicKey(ByteVector)` | 82 | Used for recipient derivation |

**Total complexity for `verifyAndMint`:** ~450 (encoding) + 200 (keccak) + 16,800 (groth16) + 500 (storage reads) + 300 (misc) ≈ **18,250 / 52,000** — well within budget.

### 11.2 RIDE Int Limitation

RIDE's `Int` type is **signed 64-bit** (range: $-2^{63}$ to $2^{63}-1$).

| Impact | Mitigation |
|--------|-----------|
| Cannot represent `u64` values ≥ $2^{63}$ | Rate limits keep all amounts < 50 SOL = 5×10¹⁰ lamports (well within i64 range) |
| No native `u128` for field element math | 128-bit splitting done by prover off-chain; RIDE only reconstructs via byte reversal |
| Nonces/slots theoretically up to `u64::MAX` | In practice, values stay within i64 for decades of operation |

### 11.3 Message ID Strategy

**Strategy A (Implemented):** RIDE recomputes `message_id = keccak256(canonical_preimage)` from caller-provided deposit fields and cross-validates against the ZK proof's public inputs.

```
┌──────────────┐     ┌──────────────────┐     ┌────────────┐
│ Caller fields │────▶│ RIDE keccak256   │────▶│ local_hash │──┐
└──────────────┘     └──────────────────┘     └────────────┘  │
                                                               │ must match
┌──────────────┐     ┌──────────────────┐     ┌────────────┐  │
│ ZK proof     │────▶│ reconstruct256   │────▶│ proof_hash │──┘
└──────────────┘     └──────────────────┘     └────────────┘
```

**Why not Strategy B?** Strategy B (binding commitment without full recomputation) is weaker: it doesn't verify ALL fields, only selected ones. Since RIDE can afford full recomputation (~450 complexity), Strategy A is strictly preferred.

### 11.4 Recipient Encoding

**Canonical format:** 32-byte DCC Curve25519 **public key** (NOT 26-byte address).

- RIDE derives the DCC Address via `addressFromPublicKey(pubkey)` (complexity: 82)
- No base58 inside the hash preimage
- The depositor on Solana must provide the DCC public key (32 bytes)
- The ZK circuit binds recipient through `recipient_lo` and `recipient_hi` (public inputs)

### 11.5 Storage Schema (Replay Protection)

```
processed::<message_id_base58>      = true       (BooleanEntry — NEVER deletable)
processed_at::<message_id_base58>   = timestamp   (IntegerEntry — audit trail)
minted_amount::<message_id_base58>  = amount      (IntegerEntry — audit trail)
```

**Deletion prevention:** The `@Verifier` script blocks ALL `DataTransaction`s, forcing state changes through callable functions only. No callable function exists to delete `processed::*` entries.

### 11.6 Compensating Controls for RIDE Limitations

| RIDE Limitation | Compensating Control |
|----------------|---------------------|
| Signed i64 only | Rate limits cap all amounts at 50 SOL (well within i64) |
| No native u128 | 128-bit split done by prover; RIDE reconstructs via byte reversal |
| No test harness | JS mirror harness validates all vectors in CI |
| `toBytes(Int)` is big-endian | Manual `intToLE4`/`intToLE8` helpers extract bytes via div/mod |
| Limited error context | Descriptive error messages with values in all `throw()` calls |
| Single account controls script | `@Verifier` blocks direct `DataTransaction`s |

---

## 12. Implementation Checklist

- [x] Rust encoder (`libs/encoding-rust` + on-chain `deposit.rs`)
- [x] TypeScript encoder (`libs/encoding-ts`)
- [x] RIDE encoder (`zk_bridge.ride::computeMessageId`)
- [x] Circom circuit (1448-bit preimage → Keccak256)
- [x] 32 test vectors with preimage, hash, leaf hash, ZK public inputs
- [x] CI enforcement of cross-language equivalence
- [x] RIDE `verifyAndMint` v2: Strategy A message_id recomputation
- [x] RIDE `computeLeafHash`: domain-separated Merkle leaf
- [x] RIDE `@Verifier`: blocks direct state manipulation
- [x] RIDE anomaly auto-pause: triggers on 2x hourly cap
- [x] RIDE checkpoint freshness: rejects checkpoints older than 7 days
- [x] RIDE test harness: `tests/ride-equivalence.test.mjs`

---

## 13. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-01-15 | Initial specification |
| 1.1 | 2025-01-18 | Fixed FV-2 (RIDE keccak256), FV-3 (recipient encoding) |
| 2.0 | 2025-01-20 | Full rewrite: byte layout diagrams, ZK public input packing, BN128 details, RIDE limitations, library API contract, 32 vectors with full expected values |
| 2.1 | 2025-01-22 | Ride adaptation: Strategy A message_id recomputation, recipient=32-byte pubkey, @Verifier script, anomaly auto-pause, checkpoint freshness, enhanced storage schema, Ride complexity analysis, compensating controls |
