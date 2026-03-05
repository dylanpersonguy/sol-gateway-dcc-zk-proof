use anchor_lang::prelude::*;
use crate::state::CheckpointConfig;
use crate::errors::CheckpointError;

#[derive(Accounts)]
pub struct EmergencyPauseCheckpoint<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, CheckpointConfig>,

    pub caller: Signer<'info>,
}

/// SECURITY FIX (MED-2): Request resume (phase 1 of 2-phase unpause)
#[derive(Accounts)]
pub struct RequestResumeCheckpoint<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
        has_one = authority @ CheckpointError::Unauthorized,
    )]
    pub config: Account<'info, CheckpointConfig>,

    pub authority: Signer<'info>,
}

/// SECURITY FIX (MED-2): Execute resume after timelock (phase 2)
#[derive(Accounts)]
pub struct EmergencyResumeCheckpoint<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
        has_one = authority @ CheckpointError::Unauthorized,
    )]
    pub config: Account<'info, CheckpointConfig>,

    pub authority: Signer<'info>,
}

pub fn pause_handler(ctx: Context<EmergencyPauseCheckpoint>) -> Result<()> {
    let config = &ctx.accounts.config;
    let caller = ctx.accounts.caller.key();

    require!(
        caller == config.authority || caller == config.guardian,
        CheckpointError::Unauthorized
    );

    let config = &mut ctx.accounts.config;
    config.paused = true;
    // Reset any pending resume when pausing
    config.resume_requested_at = 0;

    msg!("Checkpoint registry paused by {}", caller);
    Ok(())
}

/// SECURITY FIX (MED-2): Phase 1 — request resume (starts timelock)
pub fn request_resume_handler(ctx: Context<RequestResumeCheckpoint>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.paused, CheckpointError::RegistryPaused);

    let clock = Clock::get()?;
    config.resume_requested_at = clock.unix_timestamp;

    msg!("Resume requested — executable after {} seconds", CheckpointConfig::RESUME_TIMELOCK_SECONDS);
    Ok(())
}

/// SECURITY FIX (MED-2): Phase 2 — execute resume after timelock
pub fn resume_handler(ctx: Context<EmergencyResumeCheckpoint>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.paused, CheckpointError::RegistryPaused);
    require!(config.resume_requested_at > 0, CheckpointError::Unauthorized);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= config.resume_requested_at + CheckpointConfig::RESUME_TIMELOCK_SECONDS,
        CheckpointError::TimelockNotElapsed
    );

    config.paused = false;
    config.resume_requested_at = 0;

    msg!("Checkpoint registry resumed after timelock");
    Ok(())
}
