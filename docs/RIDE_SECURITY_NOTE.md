# RIDE Security Note — ZK Bridge Verification Boundary

**Document version:** 1.0  
**Contract:** `dcc/contracts/bridge/zk_bridge.ride` (STDLIB_VERSION 6)  
**Applies to:** `verifyAndMint` v2 (Strategy A — on-chain keccak256 recomputation)

---

## 1. What RIDE Verifies Directly

| Check | RIDE Code | Fail-Closed? |
|-------|-----------|-------------|
| **Groth16 proof validity** | `groth16Verify_8inputs(vk, proof, inputs)` | Yes — mint rejected |
| **Message ID recomputation** | `computeMessageId(…) == reconstruct256(feMsgIdLo, feMsgIdHi)` | Yes — CRITICAL throw |
| **Amount binding** | `fieldElementToInt(feAmount) == amount` | Yes — throw on mismatch |
| **Recipient binding** | `reconstruct256(feRecipLo, feRecipHi) == recipient` | Yes — throw on mismatch |
| **Version match** | `fieldElementToInt32(feVersion) == bridgeVersion` | Yes — throw on mismatch |
| **Checkpoint root match** | `reconstruct256(feRootLo, feRootHi) == storedRoot` | Yes — throw on mismatch |
| **Checkpoint freshness** | `height - cpHeight <= maxCheckpointAge` | Yes — rejects stale proofs |
| **Replay protection** | `isMessageProcessed(messageIdStr) == false` | Yes — double-mint impossible |
| **Rate limits** | `checkHourlyLimit()`, `checkDailyLimit()` | Yes — exceeding pauses/rejects |
| **Amount bounds** | `minMintAmount <= amount <= maxSingleMint` | Yes — throw on violation |
| **Chain ID validation** | `srcChainId == 1`, `dstChainId == 2` | Yes — throw on wrong chains |
| **Proof size** | `size(proof) >= PROOF_MIN_SIZE` | Yes — rejects truncated proofs |
| **Inputs size** | `size(inputs) == 256` | Yes — exact match required |
| **DataTransaction blocked** | `@Verifier` returns `false` for DataTransaction | Yes — state immutable via direct tx |

## 2. What the ZK Proof Guarantees (Circuit-Internal)

These properties are enforced by the Groth16 circuit (`bridge_deposit.circom`) and are cryptographically guaranteed once `groth16Verify` returns `true`:

| Property | Source |
|----------|--------|
| **Deposit event exists** | Circuit verifies leaf membership in Merkle tree |
| **Merkle inclusion** | `leaf = Keccak256(0x00 \|\| message_id)` is a valid leaf under `checkpoint_root` |
| **message_id = Keccak256(canonical_preimage)** | Circuit hashes all 181 bytes of the preimage internally |
| **All fields bound** | srcChainId, dstChainId, srcProgramId, slot, eventIndex, sender, recipient, amount, nonce, assetId — all bound via message_id |
| **Amount matches public input** | Circuit constrains public input #4 = amount from preimage |
| **Recipient matches public input** | Circuit constrains public inputs #5-#6 = recipient from preimage |
| **Version matches public input** | Circuit constrains public input #7 = version constant |

## 3. Defense-in-Depth: Strategy A Analysis

**Strategy A** = RIDE recomputes `message_id = keccak256(canonical_preimage)` on-chain from caller-provided fields and verifies it matches the proof's embedded `message_id`.

### Why This Matters

Without Strategy A, the security model is:
1. Prover provides `(proof, inputs)` → RIDE verifies `groth16Verify(vk, proof, inputs) == true`
2. RIDE trusts that the public inputs (message_id, amount, recipient) are correct *because the proof is valid*

This is already secure: a valid proof guarantees the public inputs are correct. But it creates a single point of failure — if there's a bug in the circuit or the trusted setup is compromised, the public inputs could be arbitrary.

With Strategy A, the security model becomes:
1. Caller provides all deposit fields + `(proof, inputs)`
2. RIDE **independently computes** `localMessageId = keccak256(all_fields)` using `computeMessageId()`
3. RIDE **extracts** `proofMessageId` from the proof's public inputs via `reconstruct256()`
4. RIDE verifies `localMessageId == proofMessageId` (binding check)
5. RIDE also verifies `proofAmount == callerAmount`, `proofRecipient == callerRecipient`
6. RIDE verifies `groth16Verify_8inputs(vk, proof, inputs) == true`

### Attack Surface Reduction

| Attack Scenario | Without Strategy A | With Strategy A |
|----------------|-------------------|-----------------|
| Compromised trusted setup | Attacker forges arbitrary proofs | Attacker still needs valid message_id that matches keccak256 of real fields |
| Circuit bug (wrong hash) | Wrong message_id accepted | Cross-validation catches mismatch |
| Malicious prover (different amount) | Amount from proof trusted | Amount checked twice: caller value + proof value must match |
| Field injection (extra deposit fields) | May not be caught | keccak256 over ALL fields catches any deviation |

### Residual Risk

Strategy A does NOT protect against:
- **Both-sides-wrong**: If the caller provides fake fields AND the proof was forged for those same fake fields, Strategy A cannot distinguish this from a legitimate transaction. This requires a compromised trusted setup + a malicious caller.
- **Keccak256 collision**: Theoretical (security margin: 128 bits for collision resistance)

## 4. Fields NOT Directly Available as Public Inputs

The circuit has 8 public inputs. Some deposit fields are NOT separate public inputs:

| Field | Available As | How It's Verified |
|-------|-------------|-------------------|
| `srcChainId` | Bound via `message_id` | RIDE validates `srcChainId == solChainId` AND message_id cross-check |
| `dstChainId` | Bound via `message_id` | RIDE validates `dstChainId == dccChainId` AND message_id cross-check |
| `srcProgramId` | Bound via `message_id` | message_id cross-check (not separately validated) |
| `slot` | Bound via `message_id` | message_id cross-check |
| `eventIndex` | Bound via `message_id` | message_id cross-check |
| `sender` | Bound via `message_id` | message_id cross-check |
| `nonce` | Bound via `message_id` | message_id cross-check |
| `assetId` | Bound via `message_id` | message_id cross-check |

All fields are bound through the message_id hash. Any change to any field changes message_id, which would cause either:
- The ZK proof to fail (circuit-side hash doesn't match), OR
- The Strategy A cross-validation to fail (RIDE-side hash doesn't match proof)

## 5. RIDE-Specific Security Controls

### 5.1 @Verifier: DataTransaction Blocking

The `@Verifier` script at the bottom of the contract blocks ALL `DataTransaction` types:

```ride
@Verifier(tx)
func verify() = {
    match tx {
        case dt: DataTransaction => false  # ALWAYS blocked
        case _ => sigVerify(tx.bodyBytes, tx.proofs[0], tx.senderPublicKey)
    }
}
```

**Why:** Without this, the DApp deployer could send a `DataTransaction` to directly delete `processed::` entries from storage, enabling replay attacks. With the verifier, ALL state changes must go through callable functions, which enforce replay protection.

### 5.2 Two-Phase Unpause

```
requestUnpause() → stores height → [wait 100 blocks] → executeUnpause()
```

**Why:** If an attacker gains temporary admin access and triggers auto-pause, they cannot immediately resume the bridge. The 100-block delay (~100 minutes) gives defenders time to respond.

### 5.3 Anomaly Auto-Pause

If hourly minted volume exceeds `anomalyThresholdPerHour` (200 SOL = 2× normal hourly cap), the contract automatically pauses. This is a circuit breaker against sustained exploit attempts.

### 5.4 Checkpoint Freshness

Proofs against checkpoints older than `maxCheckpointAge` (10080 blocks ≈ 7 days) are rejected. This limits the window during which a compromised checkpoint can be exploited.

## 6. Complexity Budget

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `computeMessageId` (LE encoding + keccak256) | ~450 | Manual byte extraction + hash |
| `groth16Verify_8inputs` | ~16,800 | Dominant cost |
| Storage reads (10×) | ~100 | State lookups |
| `reconstruct256` (2× reverseBytes16) | ~300 | Byte reversal |
| `addressFromPublicKey` | 82 | Recipient derivation |
| Rate limit checks | ~200 | Hourly + daily |
| Misc (comparisons, throws) | ~100 | |
| **Total** | **~18,032** | **Budget: 52,000** |

Headroom: ~34,000 complexity units available for future enhancements.

## 7. Known Limitations

1. **RIDE `Int` is signed i64**: Amounts > 2^63-1 lamports (~9.2 billion SOL) are theoretically unrepresentable. Practical impact: zero (rate limits cap at 50 SOL per transaction).

2. **No native test runner**: RIDE contracts cannot be unit-tested directly. Verification relies on an off-chain JavaScript harness (`tests/ride-equivalence.test.mjs`) that mirrors RIDE encoding logic.

3. **Script upgradeability**: The DApp deployer can update the script via `SetScriptTransaction` (allowed by `@Verifier` with DApp signature). To mitigate, governance should use a multisig for the DApp account in production.

4. **Decimal conversion**: Solana SOL uses 9 decimals; DCC wSOL uses 8 decimals. The conversion `mintAmount = amount / 10` truncates the last digit. Deposits of amounts not divisible by 10 lamports lose 0–9 lamports.
