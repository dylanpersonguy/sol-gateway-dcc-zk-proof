use anchor_lang::prelude::*;

#[error_code]
pub enum CheckpointError {
    #[msg("Registry is paused")]
    RegistryPaused,

    #[msg("Checkpoint slot must be greater than last accepted slot")]
    SlotNotAdvancing,

    #[msg("Commitment root cannot be all zeros")]
    ZeroRoot,

    #[msg("Insufficient committee signatures")]
    InsufficientSignatures,

    #[msg("Committee member not active")]
    MemberNotActive,

    #[msg("Duplicate committee member signature")]
    DuplicateMemberSignature,

    #[msg("Invalid committee member signature")]
    InvalidMemberSignature,

    #[msg("Checkpoint timelock has not elapsed")]
    TimelockNotElapsed,

    #[msg("Checkpoint has expired")]
    CheckpointExpired,

    #[msg("Checkpoint is not in Pending status")]
    NotPending,

    #[msg("Checkpoint is not in Active status")]
    NotActive,

    #[msg("Maximum pending checkpoints reached")]
    MaxPendingReached,

    #[msg("Maximum committee members reached")]
    MaxMembersReached,

    #[msg("Member already registered")]
    MemberAlreadyRegistered,

    #[msg("Would breach minimum signature threshold")]
    RemovalBreachesMinimum,

    #[msg("Unauthorized caller")]
    Unauthorized,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Finality safety margin not met — slot too recent")]
    FinalitySafetyMarginNotMet,

    #[msg("Checkpoint is not yet expired")]
    NotYetExpired,

    #[msg("Invalid configuration parameter")]
    InvalidConfig,
}
