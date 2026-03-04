use anchor_lang::prelude::*;
use crate::state::{CheckpointConfig, CheckpointEntry, CheckpointStatus};
use crate::errors::CheckpointError;
use crate::events::CheckpointActivated;

#[derive(Accounts)]
pub struct ActivateCheckpoint<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, CheckpointConfig>,

    #[account(
        mut,
        seeds = [b"checkpoint", checkpoint.checkpoint_id.to_le_bytes().as_ref()],
        bump = checkpoint.bump,
    )]
    pub checkpoint: Account<'info, CheckpointEntry>,
}

pub fn handler(ctx: Context<ActivateCheckpoint>) -> Result<()> {
    let checkpoint = &mut ctx.accounts.checkpoint;

    // ── GUARD: Must be Pending ──
    require!(
        checkpoint.status == CheckpointStatus::Pending,
        CheckpointError::NotPending
    );

    // ── GUARD: Timelock must have elapsed ──
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= checkpoint.activates_at,
        CheckpointError::TimelockNotElapsed
    );

    // ── GUARD: Must not already be expired by slot ──
    require!(
        clock.slot < checkpoint.expires_at_slot,
        CheckpointError::CheckpointExpired
    );

    // ── Activate ──
    checkpoint.status = CheckpointStatus::Active;

    // Decrement pending count
    let config = &mut ctx.accounts.config;
    config.pending_count = config.pending_count.saturating_sub(1);

    emit!(CheckpointActivated {
        checkpoint_id: checkpoint.checkpoint_id,
        slot: checkpoint.slot,
        commitment_root: checkpoint.commitment_root,
        activated_at: clock.unix_timestamp,
    });

    msg!(
        "Checkpoint #{} activated (slot {})",
        checkpoint.checkpoint_id,
        checkpoint.slot
    );

    Ok(())
}
