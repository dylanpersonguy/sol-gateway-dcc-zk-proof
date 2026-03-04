//! SOL ⇄ DCC Bridge — Canonical Encoding Library (Rust)
//!
//! Reference implementation matching TypeScript `libs/encoding-ts` and
//! RIDE `computeMessageId()` byte-for-byte.

use sha3::{Keccak256, Digest};

/// Domain separator for deposit messages
pub const DOMAIN_SEP_DEPOSIT: &[u8] = b"DCC_SOL_BRIDGE_V1";
/// Domain separator for unlock messages
pub const DOMAIN_SEP_UNLOCK: &[u8] = b"SOL_DCC_BRIDGE_UNLOCK_V1";

pub const DEPOSIT_PREIMAGE_LENGTH: usize = 181;
pub const UNLOCK_PREIMAGE_LENGTH: usize = 140;

/// Deposit message envelope — SOL → DCC
#[derive(Debug, Clone)]
pub struct DepositEnvelope {
    pub domain_sep: Vec<u8>,
    pub src_chain_id: u32,
    pub dst_chain_id: u32,
    pub src_program_id: [u8; 32],
    pub slot: u64,
    pub event_index: u32,
    pub sender: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u64,
    pub nonce: u64,
    pub asset_id: [u8; 32],
}

/// Unlock message envelope — DCC → SOL
#[derive(Debug, Clone)]
pub struct UnlockEnvelope {
    pub domain_sep: Vec<u8>,
    pub transfer_id: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u64,
    pub burn_tx_hash: [u8; 32],
    pub dcc_chain_id: u32,
    pub expiration: i64,
}

impl Default for DepositEnvelope {
    fn default() -> Self {
        Self {
            domain_sep: DOMAIN_SEP_DEPOSIT.to_vec(),
            src_chain_id: 1,
            dst_chain_id: 2,
            src_program_id: [0u8; 32],
            slot: 0,
            event_index: 0,
            sender: [0u8; 32],
            recipient: [0u8; 32],
            amount: 0,
            nonce: 0,
            asset_id: [0u8; 32],
        }
    }
}

impl Default for UnlockEnvelope {
    fn default() -> Self {
        Self {
            domain_sep: DOMAIN_SEP_UNLOCK.to_vec(),
            transfer_id: [0u8; 32],
            recipient: [0u8; 32],
            amount: 0,
            burn_tx_hash: [0u8; 32],
            dcc_chain_id: 2,
            expiration: 0,
        }
    }
}

/// Encode a deposit message into canonical bytes (181 bytes for default domain_sep).
pub fn encode_deposit_message(env: &DepositEnvelope) -> Vec<u8> {
    let mut data = Vec::with_capacity(DEPOSIT_PREIMAGE_LENGTH);
    data.extend_from_slice(&env.domain_sep);
    data.extend_from_slice(&env.src_chain_id.to_le_bytes());
    data.extend_from_slice(&env.dst_chain_id.to_le_bytes());
    data.extend_from_slice(&env.src_program_id);
    data.extend_from_slice(&env.slot.to_le_bytes());
    data.extend_from_slice(&env.event_index.to_le_bytes());
    data.extend_from_slice(&env.sender);
    data.extend_from_slice(&env.recipient);
    data.extend_from_slice(&env.amount.to_le_bytes());
    data.extend_from_slice(&env.nonce.to_le_bytes());
    data.extend_from_slice(&env.asset_id);
    data
}

/// Encode an unlock message into canonical bytes (140 bytes for default domain_sep).
pub fn encode_unlock_message(env: &UnlockEnvelope) -> Vec<u8> {
    let mut data = Vec::with_capacity(UNLOCK_PREIMAGE_LENGTH);
    data.extend_from_slice(&env.domain_sep);
    data.extend_from_slice(&env.transfer_id);
    data.extend_from_slice(&env.recipient);
    data.extend_from_slice(&env.amount.to_le_bytes());
    data.extend_from_slice(&env.burn_tx_hash);
    data.extend_from_slice(&env.dcc_chain_id.to_le_bytes());
    data.extend_from_slice(&env.expiration.to_le_bytes());
    data
}

/// Hash a preimage with Keccak-256 to produce message_id.
pub fn hash_message(preimage: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(preimage);
    hasher.finalize().into()
}

/// Compute leaf hash = Keccak256(0x00 || message_id).
/// RFC 6962 §2.1 domain separation for Merkle leaves.
pub fn compute_leaf_hash(message_id: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 33];
    buf[0] = 0x00;
    buf[1..33].copy_from_slice(message_id);
    hash_message(&buf)
}

/// Split a 32-byte value into two 128-bit LE unsigned integers [lo, hi].
/// bytes[0..16] → lo (LE u128), bytes[16..32] → hi (LE u128).
pub fn split_to_128(bytes: &[u8; 32]) -> (u128, u128) {
    let lo = u128::from_le_bytes(bytes[0..16].try_into().unwrap());
    let hi = u128::from_le_bytes(bytes[16..32].try_into().unwrap());
    (lo, hi)
}

/// Convenience: compute deposit message_id in one call.
pub fn compute_deposit_message_id(env: &DepositEnvelope) -> [u8; 32] {
    let preimage = encode_deposit_message(env);
    hash_message(&preimage)
}

/// Hex string to bytes.
pub fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// Bytes to hex string.
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Parse hex into fixed 32-byte array.
pub fn hex_to_bytes32(hex: &str) -> [u8; 32] {
    let v = hex_to_bytes(hex);
    v.try_into().expect("must be 32 bytes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;

    fn load_vectors() -> Vec<Value> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/test-vectors.json");
        let data = fs::read_to_string(path).expect("Cannot read test-vectors.json");
        let json: Value = serde_json::from_str(&data).expect("Invalid JSON");
        json["vectors"].as_array().unwrap().clone()
    }

    fn build_deposit_envelope(fields: &Value) -> DepositEnvelope {
        DepositEnvelope {
            domain_sep: fields["domain_sep"].as_str().unwrap().as_bytes().to_vec(),
            src_chain_id: fields["src_chain_id"].as_u64().unwrap() as u32,
            dst_chain_id: fields["dst_chain_id"].as_u64().unwrap() as u32,
            src_program_id: hex_to_bytes32(fields["src_program_id"].as_str().unwrap()),
            slot: fields["slot"].as_u64().unwrap(),
            event_index: fields["event_index"].as_u64().unwrap() as u32,
            sender: hex_to_bytes32(fields["sender"].as_str().unwrap()),
            recipient: hex_to_bytes32(fields["recipient"].as_str().unwrap()),
            amount: fields["amount"].as_u64().unwrap(),
            nonce: fields["nonce"].as_u64().unwrap(),
            asset_id: hex_to_bytes32(fields["asset_id"].as_str().unwrap()),
        }
    }

    fn build_unlock_envelope(fields: &Value) -> UnlockEnvelope {
        UnlockEnvelope {
            domain_sep: fields["domain_sep"].as_str().unwrap().as_bytes().to_vec(),
            transfer_id: hex_to_bytes32(fields["transfer_id"].as_str().unwrap()),
            recipient: hex_to_bytes32(fields["recipient"].as_str().unwrap()),
            amount: fields["amount"].as_u64().unwrap(),
            burn_tx_hash: hex_to_bytes32(fields["burn_tx_hash"].as_str().unwrap()),
            dcc_chain_id: fields["dcc_chain_id"].as_u64().unwrap() as u32,
            expiration: fields["expiration"].as_i64().unwrap(),
        }
    }

    // ═══════════════════════════════════════════════════════
    // Golden Vector
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_golden_vector_v001() {
        let vectors = load_vectors();
        let v = &vectors[0];
        let fields = &v["fields"];
        let env = build_deposit_envelope(fields);

        let preimage = encode_deposit_message(&env);
        assert_eq!(preimage.len(), DEPOSIT_PREIMAGE_LENGTH);

        // Check preimage hex matches
        let expected_hex = v["expected_preimage_hex"].as_str().unwrap();
        assert_eq!(bytes_to_hex(&preimage), expected_hex, "V-001 preimage mismatch");

        let message_id = hash_message(&preimage);
        let expected_id = v["expected_message_id"].as_str().unwrap();
        assert_eq!(bytes_to_hex(&message_id), expected_id, "V-001 message_id mismatch");

        // Leaf hash
        let leaf = compute_leaf_hash(&message_id);
        let expected_leaf = v["expected_leaf_hash"].as_str().unwrap();
        assert_eq!(bytes_to_hex(&leaf), expected_leaf, "V-001 leaf hash mismatch");
    }

    // ═══════════════════════════════════════════════════════
    // All Vectors — Preimage + Hash
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_all_vectors_preimage_and_hash() {
        let vectors = load_vectors();
        for v in &vectors {
            let id = v["id"].as_str().unwrap();
            let is_unlock = v["type"].as_str().map(|t| t == "unlock").unwrap_or(false);
            let fields = &v["fields"];
            let expected_len = v["expected_preimage_length"].as_u64().unwrap() as usize;

            if is_unlock {
                // Skip if amount overflows u64
                if fields["amount"].as_u64().is_none() { continue; }

                let env = build_unlock_envelope(fields);
                let preimage = encode_unlock_message(&env);
                assert_eq!(preimage.len(), expected_len, "{id} — preimage length mismatch");

                if let Some(hex) = v["expected_preimage_hex"].as_str() {
                    assert_eq!(bytes_to_hex(&preimage), hex, "{id} — preimage hex mismatch");
                }
                if let Some(expected_id) = v["expected_message_id"].as_str() {
                    let msgid = hash_message(&preimage);
                    assert_eq!(bytes_to_hex(&msgid), expected_id, "{id} — message_id mismatch");
                }
            } else {
                // Skip if amount/nonce/slot overflows u64
                if fields["amount"].as_u64().is_none()
                    || fields["nonce"].as_u64().is_none()
                    || fields["slot"].as_u64().is_none()
                {
                    continue;
                }

                let env = build_deposit_envelope(fields);
                let preimage = encode_deposit_message(&env);
                assert_eq!(preimage.len(), expected_len, "{id} — preimage length mismatch");

                if let Some(hex) = v["expected_preimage_hex"].as_str() {
                    assert_eq!(bytes_to_hex(&preimage), hex, "{id} — preimage hex mismatch");
                }
                if let Some(expected_id) = v["expected_message_id"].as_str() {
                    let msgid = hash_message(&preimage);
                    assert_eq!(bytes_to_hex(&msgid), expected_id, "{id} — message_id mismatch");
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // Leaf Hash for All Deposit Vectors
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_all_vectors_leaf_hash() {
        let vectors = load_vectors();
        for v in &vectors {
            let id = v["id"].as_str().unwrap();
            if v["type"].as_str().map(|t| t == "unlock").unwrap_or(false) { continue; }
            if v["expected_leaf_hash"].as_str().is_none() { continue; }
            if v["fields"]["amount"].as_u64().is_none()
                || v["fields"]["nonce"].as_u64().is_none()
                || v["fields"]["slot"].as_u64().is_none()
            {
                continue;
            }

            let env = build_deposit_envelope(&v["fields"]);
            let preimage = encode_deposit_message(&env);
            let message_id = hash_message(&preimage);
            let leaf = compute_leaf_hash(&message_id);
            let expected = v["expected_leaf_hash"].as_str().unwrap();
            assert_eq!(bytes_to_hex(&leaf), expected, "{id} — leaf hash mismatch");
        }
    }

    // ═══════════════════════════════════════════════════════
    // ZK Public Input Derivation (128-bit split)
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_all_vectors_public_inputs() {
        let vectors = load_vectors();
        for v in &vectors {
            let id = v["id"].as_str().unwrap();
            if v["type"].as_str().map(|t| t == "unlock").unwrap_or(false) { continue; }
            if v["expected_public_inputs"].is_null() { continue; }
            if v["fields"]["amount"].as_u64().is_none()
                || v["fields"]["nonce"].as_u64().is_none()
                || v["fields"]["slot"].as_u64().is_none()
            {
                continue;
            }

            let env = build_deposit_envelope(&v["fields"]);
            let preimage = encode_deposit_message(&env);
            let message_id = hash_message(&preimage);
            let recipient = hex_to_bytes32(v["fields"]["recipient"].as_str().unwrap());

            let (msg_lo, msg_hi) = split_to_128(&message_id);
            let (recip_lo, recip_hi) = split_to_128(&recipient);

            let pi = &v["expected_public_inputs"];
            assert_eq!(
                msg_lo.to_string(),
                pi["message_id_lo"].as_str().unwrap(),
                "{id} — message_id_lo"
            );
            assert_eq!(
                msg_hi.to_string(),
                pi["message_id_hi"].as_str().unwrap(),
                "{id} — message_id_hi"
            );
            assert_eq!(
                pi["amount"].as_str().unwrap(),
                v["fields"]["amount"].as_u64().unwrap().to_string(),
                "{id} — amount"
            );
            assert_eq!(
                recip_lo.to_string(),
                pi["recipient_lo"].as_str().unwrap(),
                "{id} — recipient_lo"
            );
            assert_eq!(
                recip_hi.to_string(),
                pi["recipient_hi"].as_str().unwrap(),
                "{id} — recipient_hi"
            );
        }
    }

    // ═══════════════════════════════════════════════════════
    // split_to_128 Unit Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_split_zeros() {
        let buf = [0u8; 32];
        let (lo, hi) = split_to_128(&buf);
        assert_eq!(lo, 0);
        assert_eq!(hi, 0);
    }

    #[test]
    fn test_split_byte0_is_1() {
        let mut buf = [0u8; 32];
        buf[0] = 1;
        let (lo, hi) = split_to_128(&buf);
        assert_eq!(lo, 1);
        assert_eq!(hi, 0);
    }

    #[test]
    fn test_split_byte16_is_1() {
        let mut buf = [0u8; 32];
        buf[16] = 1;
        let (lo, hi) = split_to_128(&buf);
        assert_eq!(lo, 0);
        assert_eq!(hi, 1);
    }

    #[test]
    fn test_split_all_ff() {
        let buf = [0xffu8; 32];
        let (lo, hi) = split_to_128(&buf);
        assert_eq!(lo, u128::MAX);
        assert_eq!(hi, u128::MAX);
    }

    // ═══════════════════════════════════════════════════════
    // Mutation tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_cross_chain_no_collision() {
        let env1 = DepositEnvelope {
            src_chain_id: 1,
            dst_chain_id: 2,
            ..Default::default()
        };
        let env2 = DepositEnvelope {
            src_chain_id: 2,
            dst_chain_id: 1,
            ..Default::default()
        };
        assert_ne!(
            compute_deposit_message_id(&env1),
            compute_deposit_message_id(&env2),
            "Swapped chain IDs must differ"
        );
    }

    #[test]
    fn test_amount_mutation() {
        let env1 = DepositEnvelope { amount: 1_000_000_000, ..Default::default() };
        let env2 = DepositEnvelope { amount: 1_000_000_001, ..Default::default() };
        assert_ne!(
            compute_deposit_message_id(&env1),
            compute_deposit_message_id(&env2),
        );
    }

    #[test]
    fn test_nonce_mutation() {
        let env1 = DepositEnvelope { nonce: 0, ..Default::default() };
        let env2 = DepositEnvelope { nonce: 1, ..Default::default() };
        assert_ne!(
            compute_deposit_message_id(&env1),
            compute_deposit_message_id(&env2),
        );
    }

    // ═══════════════════════════════════════════════════════
    // All unique message IDs
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_all_message_ids_unique() {
        let vectors = load_vectors();
        let mut ids: Vec<String> = Vec::new();
        for v in &vectors {
            if let Some(mid) = v["expected_message_id"].as_str() {
                assert!(!ids.contains(&mid.to_string()), "Duplicate message_id: {mid}");
                ids.push(mid.to_string());
            }
        }
    }
}
