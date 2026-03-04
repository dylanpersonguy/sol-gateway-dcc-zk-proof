use anchor_lang::prelude::*;

/// Emitted when a new checkpoint is submitted (pending activation).
#[event]
pub struct CheckpointSubmitted {
    pub checkpoint_id: u64,
    pub slot: u64,
    pub commitment_root: [u8; 32],
    pub event_count: u32,
    pub submitted_at: i64,
    pub activates_at: i64,
    pub signature_count: u8,
}

/// Emitted when a checkpoint becomes active (timelock elapsed).
#[event]
pub struct CheckpointActivated {
    pub checkpoint_id: u64,
    pub slot: u64,
    pub commitment_root: [u8; 32],
    pub activated_at: i64,
}

/// Emitted when a checkpoint expires.
#[event]
pub struct CheckpointExpiredEvent {
    pub checkpoint_id: u64,
    pub slot: u64,
    pub expired_at_slot: u64,
}
