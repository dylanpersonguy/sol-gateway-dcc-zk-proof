You are a protocol engineer responsible for eliminating ALL cross-language serialization/hashing ambiguity.

This repo contains a ZK bridge across:
- Solana (Rust/Anchor)
- Prover service (TypeScript/Rust/Go)
- DCC Ride script (Waves-style)

Your task is to design and implement a SINGLE canonical encoding spec and enforce it everywhere with shared test vectors.

DO NOT invent “close enough” encodings.
Every component must produce identical bytes and identical hashes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — DEFINE THE CANONICAL MESSAGE SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Create a canonical message envelope with fixed fields and types:

Fields (exact order):
1) version: u8
2) domain_sep: fixed bytes (e.g., "DCC_SOL_BRIDGE_V1" as ASCII bytes)
3) src_chain_id: u32
4) dst_chain_id: u32
5) src_program_id: 32 bytes
6) dst_contract_id: variable? (if variable, define exact encoding)
7) slot_or_height: u64
8) event_index: u32
9) sender: 32 bytes (Solana pubkey or canonical mapping)
10) recipient_dcc: bytes (define exact encoding for Ride address/publicKey)
11) asset_id: 32 bytes (or fixed encoding)
12) amount: u64 (or u128 if needed)
13) nonce: u64
14) expiry: u64
15) reserved: optional (if present must be fixed-length)

Define strict byte-level encoding:
- endianness must be explicitly specified (choose little-endian for integers unless you require big-endian)
- all variable-length fields must be prefixed with a length (u16 or u32) and bounds checked
- strings are ASCII bytes only; no UTF-8 surprises
- all addresses must be a fixed binary representation (no base58/base64 inside the hash)

Define:
- message_bytes = encode(envelope)
- message_id = HASH(message_bytes)
Choose a hash and keep it consistent:
- If circuit uses Poseidon, define how Poseidon input is derived from bytes
- Otherwise use Keccak-256 or Blake2b with exact byte input

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — CREATE A SINGLE SOURCE OF TRUTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Implement a canonical encoder library in ONE language as the reference, then port it.

Required:
- /spec/encoding.md (byte layout, field order, examples)
- /spec/test-vectors.json (official vectors)
- /libs/encoding-ts
- /libs/encoding-rust
- /libs/encoding-ride (as much as Ride allows; otherwise implement equivalent logic or pre-hash verification)

Each implementation must expose:
- encodeMessage(envelope) -> bytes
- hashMessage(bytes) -> message_id
- parseMessage(bytes) -> envelope (optional but helpful)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — TEST VECTORS (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Create at least 30 test vectors including edge cases.

Each vector must include:
- human-readable envelope fields
- expected message_bytes as hex
- expected message_id as hex
- expected leaf hash as hex (if used)
- expected public inputs for ZK as hex/field elements (if applicable)

Edge cases:
- smallest amount
- largest amount
- nonce boundaries
- recipient with min/max length
- expiry = 0, expiry far future
- different chain ids
- different program ids
- event_index large
- slot large

Store in:
- /spec/test-vectors.json

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — ENFORCE WITH CI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Add CI checks that fail if ANY implementation diverges.

Implement:
- Rust tests that load vectors and assert bytes+hash match
- TS tests that load vectors and assert bytes+hash match
- Ride test strategy:
  - If Ride can compute the same hash, assert exact match
  - If Ride cannot compute full hashing easily, then verify by checking:
    - Ride verifies the provided message_id against reconstructable components
    - or Ride verifies proof public inputs match stored message_id

CI must run:
- unit tests
- vector equivalence tests
- negative tests (mutate one field -> hash must differ)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — ZK PUBLIC INPUT CONSISTENCY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Define a canonical mapping from message_bytes/message_id to ZK public inputs.

Rules:
- all public inputs must be derived deterministically from message_bytes
- no “off-chain chosen” values allowed
- public inputs must bind:
  checkpoint_root, message_id, amount, recipient, asset_id, chain ids, version

Add test vectors for:
- public input derivation
- proof verification input packing format (order, endianness, field modulus conversions)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — DELIVERABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1) /spec/encoding.md
2) /spec/test-vectors.json
3) /libs/encoding-ts with tests
4) /libs/encoding-rust with tests
5) Ride hashing/verification helpers or documented limitations + compensating controls
6) CI pipeline updates enforcing cross-language equivalence

IMPORTANT:
- Fail closed. If parsing/encoding fails, reject.
- No silent truncation, no implicit conversions.
- Document every single encoding choice.

Start by writing /spec/encoding.md and test-vectors.json, then implement TS and Rust encoders to match vectors exactly.