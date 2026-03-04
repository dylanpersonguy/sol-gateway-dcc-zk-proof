use anchor_lang::prelude::*;
use crate::state::BridgeConfig;
use crate::errors::BridgeError;
use crate::events::{BridgePaused, BridgeResumed, ResumeRequested, ResumeCancelled};

#[derive(Accounts)]
pub struct EmergencyPause<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        // Either authority OR guardian can pause
        constraint = (
            bridge_config.authority == authority.key() ||
            bridge_config.guardian == authority.key()
        ) @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

/// Account context for requesting a resume (starts the timelock).
/// Only the primary authority (not guardian) can request a resume.
#[derive(Accounts)]
pub struct RequestResume<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

/// Account context for executing the resume after the timelock has elapsed.
/// Only the primary authority can execute.
#[derive(Accounts)]
pub struct EmergencyResume<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

/// Account context for cancelling a pending resume request.
/// Either authority or guardian can cancel (defense-in-depth).
#[derive(Accounts)]
pub struct CancelResumeRequest<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = (
            bridge_config.authority == authority.key() ||
            bridge_config.guardian == authority.key()
        ) @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

pub fn pause_handler(ctx: Context<EmergencyPause>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.paused = true;

    // Cancel any pending resume request when pausing
    config.resume_requested_at = 0;

    let clock = Clock::get()?;
    emit!(BridgePaused {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "🛑 BRIDGE PAUSED by {}",
        ctx.accounts.authority.key()
    );
    Ok(())
}

/// Step 1: Request a resume. Starts the timelock countdown.
/// The bridge remains paused—this only records the intent.
pub fn request_resume_handler(ctx: Context<RequestResume>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    // Must be paused to request a resume
    require!(config.paused, BridgeError::InvalidConfig);

    // Cannot request while one is already pending
    require!(
        config.resume_requested_at == 0,
        BridgeError::ResumeAlreadyRequested
    );

    let clock = Clock::get()?;
    config.resume_requested_at = clock.unix_timestamp;

    let executable_after = clock.unix_timestamp
        .checked_add(config.resume_delay_seconds)
        .ok_or(BridgeError::ArithmeticOverflow)?;

    emit!(ResumeRequested {
        authority: ctx.accounts.authority.key(),
        requested_at: clock.unix_timestamp,
        executable_after,
    });

    msg!(
        "⏳ RESUME REQUESTED by {}. Executable after: {}",
        ctx.accounts.authority.key(),
        executable_after
    );
    Ok(())
}

/// Step 2: Execute the resume after the timelock delay has elapsed.
pub fn resume_handler(ctx: Context<EmergencyResume>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    // Must be paused
    require!(config.paused, BridgeError::InvalidConfig);

    // Must have a pending resume request
    require!(
        config.resume_requested_at != 0,
        BridgeError::ResumeNotRequested
    );

    let clock = Clock::get()?;

    // Timelock: requested_at + delay must be in the past
    let earliest_resume = config.resume_requested_at
        .checked_add(config.resume_delay_seconds)
        .ok_or(BridgeError::ArithmeticOverflow)?;
    require!(
        clock.unix_timestamp >= earliest_resume,
        BridgeError::ResumeDelayNotElapsed
    );

    // Execute the resume
    config.paused = false;
    config.resume_requested_at = 0;

    emit!(BridgeResumed {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "✅ BRIDGE RESUMED by {} (after timelock)",
        ctx.accounts.authority.key()
    );
    Ok(())
}

/// Cancel a pending resume request.
/// Either authority or guardian can cancel — defense-in-depth so a
/// compromised authority key alone cannot silently unpause.
pub fn cancel_resume_handler(ctx: Context<CancelResumeRequest>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    // Must have a pending resume request
    require!(
        config.resume_requested_at != 0,
        BridgeError::ResumeNotRequested
    );

    config.resume_requested_at = 0;

    let clock = Clock::get()?;
    emit!(ResumeCancelled {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "❌ RESUME CANCELLED by {}",
        ctx.accounts.authority.key()
    );
    Ok(())
}
