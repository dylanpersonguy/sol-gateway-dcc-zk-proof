use anchor_lang::prelude::*;
use crate::state::{CheckpointConfig, CheckpointEntry, CheckpointStatus};
use crate::errors::CheckpointError;
use crate::events::CheckpointExpiredEvent;

#[derive(Accounts)]
pub struct ExpireCheckpoint<'info> {
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

pub fn handler(ctx: Context<ExpireCheckpoint>) -> Result<()> {
    let checkpoint = &mut ctx.accounts.checkpoint;

    // ── GUARD: Only Active or Pending can be expired ──
    require!(
        checkpoint.status == CheckpointStatus::Active || checkpoint.status == CheckpointStatus::Pending,
        CheckpointError::CheckpointExpired // already expired
    );

    // ── GUARD: Must actually be past expiry ──
    let clock = Clock::get()?;
    require!(
        clock.slot >= checkpoint.expires_at_slot,
        CheckpointError::NotYetExpired
    );

    // If it was pending, also decrement pending count
    if checkpoint.status == CheckpointStatus::Pending {
        let config = &mut ctx.accounts.config;
        config.pending_count = config.pending_count.saturating_sub(1);
    }

    checkpoint.status = CheckpointStatus::Expired;

    emit!(CheckpointExpiredEvent {
        checkpoint_id: checkpoint.checkpoint_id,
        slot: checkpoint.slot,
        expired_at_slot: checkpoint.expires_at_slot,
    });

    msg!(
        "Checkpoint #{} expired (slot {})",
        checkpoint.checkpoint_id,
        checkpoint.slot
    );

    Ok(())
}
