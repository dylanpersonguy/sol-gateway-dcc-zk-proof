use anchor_lang::prelude::*;

/// ═══════════════════════════════════════════════════════════════
/// BRIDGE EVENTS — Canonical on-chain events for validator observation
/// ═══════════════════════════════════════════════════════════════

/// Emitted when SOL is deposited into the bridge vault.
/// The ZK prover watches for this event and builds inclusion proofs.
#[event]
pub struct BridgeDeposit {
    /// Globally unique transfer identifier (legacy, kept for index compatibility)
    pub transfer_id: [u8; 32],
    /// ZK bridge message ID = Keccak256(domain_sep || fields)
    pub message_id: [u8; 32],
    /// Depositor's Solana public key
    pub sender: Pubkey,
    /// Recipient address on DecentralChain
    pub recipient_dcc: [u8; 32],
    /// Amount in lamports
    pub amount: u64,
    /// User-specific monotonic nonce
    pub nonce: u64,
    /// Solana slot at deposit time
    pub slot: u64,
    /// Event index within the checkpoint window
    pub event_index: u32,
    /// Unix timestamp
    pub timestamp: i64,
    /// Solana chain ID (domain separation)
    pub src_chain_id: u32,
    /// DCC chain ID
    pub dst_chain_id: u32,
    /// Asset identifier (SPL mint or native SOL sentinel)
    pub asset_id: Pubkey,
}

/// Emitted when SPL tokens are deposited into the bridge vault.
/// Includes the SPL mint address so DCC knows which wrapped token to mint.
#[event]
pub struct BridgeDepositSpl {
    /// Globally unique transfer identifier
    pub transfer_id: [u8; 32],
    /// ZK bridge message ID = Keccak256(domain_sep || fields)
    pub message_id: [u8; 32],
    /// Depositor's Solana public key
    pub sender: Pubkey,
    /// Recipient address on DecentralChain
    pub recipient_dcc: [u8; 32],
    /// SPL token mint address (used as asset_id in message_id)
    pub spl_mint: Pubkey,
    /// Amount in smallest token units
    pub amount: u64,
    /// User-specific monotonic nonce
    pub nonce: u64,
    /// Solana slot at deposit time
    pub slot: u64,
    /// Event index within the checkpoint window
    pub event_index: u32,
    /// Unix timestamp
    pub timestamp: i64,
    /// Solana chain ID (domain separation)
    pub chain_id: u32,
}

/// Emitted when SOL is unlocked from the vault after DCC burn verification.
#[event]
pub struct BridgeUnlock {
    /// Transfer ID from the DCC burn
    pub transfer_id: [u8; 32],
    /// Recipient Solana address
    pub recipient: Pubkey,
    /// Amount unlocked in lamports
    pub amount: u64,
    /// DCC burn transaction hash
    pub burn_tx_hash: [u8; 32],
    /// Unix timestamp of unlock
    pub timestamp: i64,
    /// Number of validator signatures provided
    pub signature_count: u8,
}

/// Emitted when the bridge is paused.
#[event]
pub struct BridgePaused {
    /// Authority that triggered the pause
    pub authority: Pubkey,
    /// Timestamp of pause
    pub timestamp: i64,
}

/// Emitted when the bridge is resumed.
#[event]
pub struct BridgeResumed {
    /// Authority that triggered the resume
    pub authority: Pubkey,
    /// Timestamp of resume
    pub timestamp: i64,
}

/// Emitted when a validator is registered.
#[event]
pub struct ValidatorRegistered {
    /// Validator's public key
    pub validator: Pubkey,
    /// Current validator count
    pub validator_count: u8,
    /// Timestamp
    pub timestamp: i64,
}

/// Emitted when a validator is removed.
#[event]
pub struct ValidatorRemoved {
    /// Validator's public key
    pub validator: Pubkey,
    /// Current validator count
    pub validator_count: u8,
    /// Timestamp
    pub timestamp: i64,
}

/// Emitted when circuit breaker triggers.
#[event]
pub struct CircuitBreakerTriggered {
    /// Type of circuit breaker
    pub breaker_type: String,
    /// Current value that triggered the breaker
    pub current_value: u64,
    /// Threshold that was exceeded
    pub threshold: u64,
    /// Timestamp
    pub timestamp: i64,
}

/// Emitted when a resume is requested (starts the timelock).
#[event]
pub struct ResumeRequested {
    /// Authority that requested the resume
    pub authority: Pubkey,
    /// When the resume was requested
    pub requested_at: i64,
    /// Earliest time the resume can be executed
    pub executable_after: i64,
}

/// Emitted when a pending resume request is cancelled.
#[event]
pub struct ResumeCancelled {
    /// Authority that cancelled the resume
    pub authority: Pubkey,
    /// Timestamp of cancellation
    pub timestamp: i64,
}
