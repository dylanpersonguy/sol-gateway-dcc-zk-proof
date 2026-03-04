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

    #[test]
    fn test_golden_vector_v001() {
        let env = DepositEnvelope {
            domain_sep: DOMAIN_SEP_DEPOSIT.to_vec(),
            src_chain_id: 1,
            dst_chain_id: 2,
            src_program_id: hex_to_bytes32(
                "82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302",
            ),
            slot: 1000,
            event_index: 0,
            sender: [0u8; 32],
            recipient: [1u8; 32],
            amount: 1_000_000_000,
            nonce: 0,
            asset_id: hex_to_bytes32(
                "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
            ),
        };

        let preimage = encode_deposit_message(&env);
        assert_eq!(preimage.len(), DEPOSIT_PREIMAGE_LENGTH);

        let message_id = hash_message(&preimage);
        let expected = hex_to_bytes32(
            "6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444",
        );
        assert_eq!(message_id, expected, "Golden vector must match");
    }

    #[test]
    fn test_deposit_preimage_length() {
        let env = DepositEnvelope::default();
        let preimage = encode_deposit_message(&env);
        assert_eq!(preimage.len(), DEPOSIT_PREIMAGE_LENGTH);
    }

    #[test]
    fn test_unlock_preimage_length() {
        let env = UnlockEnvelope::default();
        let preimage = encode_unlock_message(&env);
        assert_eq!(preimage.len(), UNLOCK_PREIMAGE_LENGTH);
    }

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

        let id1 = compute_deposit_message_id(&env1);
        let id2 = compute_deposit_message_id(&env2);
        assert_ne!(id1, id2, "Swapped chain IDs must produce different IDs");
    }

    #[test]
    fn test_amount_mutation() {
        let env1 = DepositEnvelope {
            amount: 1_000_000_000,
            ..Default::default()
        };
        let env2 = DepositEnvelope {
            amount: 1_000_000_001,
            ..Default::default()
        };

        let id1 = compute_deposit_message_id(&env1);
        let id2 = compute_deposit_message_id(&env2);
        assert_ne!(id1, id2, "Different amounts must produce different IDs");
    }

    #[test]
    fn test_nonce_mutation() {
        let env1 = DepositEnvelope {
            nonce: 0,
            ..Default::default()
        };
        let env2 = DepositEnvelope {
            nonce: 1,
            ..Default::default()
        };

        let id1 = compute_deposit_message_id(&env1);
        let id2 = compute_deposit_message_id(&env2);
        assert_ne!(id1, id2, "Different nonces must produce different IDs");
    }

    #[test]
    fn test_max_values() {
        let env = DepositEnvelope {
            src_chain_id: u32::MAX,
            dst_chain_id: u32::MAX,
            slot: u64::MAX,
            event_index: u32::MAX,
            amount: u64::MAX,
            nonce: u64::MAX,
            src_program_id: [0xff; 32],
            sender: [0xff; 32],
            recipient: [0xff; 32],
            asset_id: [0xff; 32],
            ..Default::default()
        };
        let preimage = encode_deposit_message(&env);
        assert_eq!(preimage.len(), DEPOSIT_PREIMAGE_LENGTH);
        let id = hash_message(&preimage);
        assert_ne!(id, [0u8; 32]);
    }
}
