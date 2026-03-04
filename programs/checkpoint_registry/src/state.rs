use anchor_lang::prelude::*;

/// Checkpoint status lifecycle
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointStatus {
    /// Submitted but timelock has not elapsed
    Pending,
    /// Active and usable by proofs
    Active,
    /// Expired past TTL — no longer usable
    Expired,
}

impl Default for CheckpointStatus {
    fn default() -> Self {
        CheckpointStatus::Pending
    }
}

/// Global registry configuration (PDA: seeds = [b"checkpoint_config"])
#[account]
pub struct CheckpointConfig {
    /// Authority that can update configuration
    pub authority: Pubkey,

    /// Guardian for emergency operations
    pub guardian: Pubkey,

    /// Whether submissions are paused
    pub paused: bool,

    /// Next checkpoint ID (monotonically increasing)
    pub next_checkpoint_id: u64,

    /// Last accepted slot (new checkpoints must reference a later slot)
    pub last_checkpoint_slot: u64,

    /// Minimum committee signatures required (t in t-of-n)
    pub min_signatures: u8,

    /// Number of active committee members
    pub member_count: u8,

    /// Maximum committee members
    pub max_members: u8,

    /// Safety margin: additional slots after finalization required
    pub finality_safety_margin: u64,

    /// Timelock duration (seconds) before checkpoint becomes active
    pub timelock_seconds: i64,

    /// Checkpoint TTL in slots (after which it expires)
    pub checkpoint_ttl_slots: u64,

    /// Maximum checkpoints that can be pending simultaneously
    pub max_pending: u8,

    /// Current count of pending checkpoints
    pub pending_count: u8,

    /// Bridge vault program ID (for domain separation)
    pub bridge_program_id: Pubkey,

    /// Solana chain ID
    pub solana_chain_id: u32,

    /// DCC chain ID
    pub dcc_chain_id: u32,

    /// Bump seed
    pub bump: u8,

    /// Reserved for future fields
    pub _reserved: [u8; 64],
}

impl CheckpointConfig {
    pub const LEN: usize = 8  // discriminator
        + 32    // authority
        + 32    // guardian
        + 1     // paused
        + 8     // next_checkpoint_id
        + 8     // last_checkpoint_slot
        + 1     // min_signatures
        + 1     // member_count
        + 1     // max_members
        + 8     // finality_safety_margin
        + 8     // timelock_seconds
        + 8     // checkpoint_ttl_slots
        + 1     // max_pending
        + 1     // pending_count
        + 32    // bridge_program_id
        + 4     // solana_chain_id
        + 4     // dcc_chain_id
        + 1     // bump
        + 64;   // reserved
}

/// Individual checkpoint entry (PDA: seeds = [b"checkpoint", checkpoint_id.to_le_bytes()])
#[account]
pub struct CheckpointEntry {
    /// Unique monotonic checkpoint ID
    pub checkpoint_id: u64,

    /// Solana slot this checkpoint covers
    pub slot: u64,

    /// Merkle root of deposit events in this checkpoint window
    pub commitment_root: [u8; 32],

    /// Number of events included in this checkpoint
    pub event_count: u32,

    /// Timestamp when checkpoint was submitted
    pub submitted_at: i64,

    /// Timestamp when checkpoint becomes active (submitted_at + timelock)
    pub activates_at: i64,

    /// Slot at which this checkpoint expires
    pub expires_at_slot: u64,

    /// Current status
    pub status: CheckpointStatus,

    /// Number of committee signatures that validated this checkpoint
    pub signature_count: u8,

    /// Bump seed
    pub bump: u8,
}

impl CheckpointEntry {
    pub const LEN: usize = 8  // discriminator
        + 8     // checkpoint_id
        + 8     // slot
        + 32    // commitment_root
        + 4     // event_count
        + 8     // submitted_at
        + 8     // activates_at
        + 8     // expires_at_slot
        + 1     // status
        + 1     // signature_count
        + 1;    // bump
}

/// Committee member entry (PDA: seeds = [b"member", pubkey])
#[account]
pub struct CommitteeMember {
    /// Member's signing public key
    pub pubkey: Pubkey,

    /// Whether this member is active
    pub active: bool,

    /// Registration timestamp
    pub registered_at: i64,

    /// Bump seed
    pub bump: u8,
}

impl CommitteeMember {
    pub const LEN: usize = 8  // discriminator
        + 32    // pubkey
        + 1     // active
        + 8     // registered_at
        + 1;    // bump
}
