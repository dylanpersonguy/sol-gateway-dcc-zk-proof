pub mod state;
pub mod errors;
pub mod events;
pub mod instructions;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("G9NL1r3B7Dzuxsct3nSYrcW3PySeBpNivcDmKH2fWRW6");

/// Checkpoint Registry Program
///
/// Stores finalized Solana state commitments (Merkle roots of deposit events)
/// for use by the ZK bridge prover. Checkpoints serve as the finality anchor:
/// the ZK circuit proves deposit inclusion under a committed checkpoint root,
/// and the DCC contract verifies the proof against this root.
///
/// SECURITY MODEL (Phase 1):
/// - Checkpoints are posted by a t-of-n committee with collective signatures
/// - Checkpoints reference finalized slots (with safety margin)
/// - Active timelock before checkpoint becomes usable
/// - Checkpoints expire after TTL
/// - Cannot accept wildcard (all-zero) roots
///
/// INVARIANTS:
/// - checkpoint_id is strictly monotonic
/// - commitment_root is never all-zero
/// - slot must be > last checkpoint's slot
/// - Only active, non-expired checkpoints can be used by proofs
#[program]
pub mod checkpoint_registry {
    use super::*;

    /// Initialize the checkpoint registry configuration.
    pub fn initialize(
        ctx: Context<Initialize>,
        params: InitializeParams,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Submit a new checkpoint (committee members sign the checkpoint data).
    pub fn submit_checkpoint(
        ctx: Context<SubmitCheckpoint>,
        params: SubmitCheckpointParams,
    ) -> Result<()> {
        instructions::submit_checkpoint::handler(ctx, params)
    }

    /// Activate a checkpoint after the timelock has elapsed.
    pub fn activate_checkpoint(
        ctx: Context<ActivateCheckpoint>,
    ) -> Result<()> {
        instructions::activate_checkpoint::handler(ctx)
    }

    /// Expire a checkpoint that has passed its TTL.
    pub fn expire_checkpoint(
        ctx: Context<ExpireCheckpoint>,
    ) -> Result<()> {
        instructions::expire_checkpoint::handler(ctx)
    }

    /// Register a committee member.
    pub fn register_member(
        ctx: Context<RegisterMember>,
        member_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::register_member::handler(ctx, member_pubkey)
    }

    /// Remove a committee member.
    pub fn remove_member(
        ctx: Context<RemoveMember>,
        member_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::remove_member::handler(ctx, member_pubkey)
    }

    /// Emergency pause — halts all checkpoint submissions.
    pub fn emergency_pause(ctx: Context<EmergencyPauseCheckpoint>) -> Result<()> {
        instructions::emergency::pause_handler(ctx)
    }

    /// Resume after emergency pause.
    pub fn emergency_resume(ctx: Context<EmergencyResumeCheckpoint>) -> Result<()> {
        instructions::emergency::resume_handler(ctx)
    }
}
