use anchor_lang::prelude::*;
use crate::state::BridgeConfig;
use crate::errors::BridgeError;
use crate::events::{BridgePaused, BridgeResumed};

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

#[derive(Accounts)]
pub struct EmergencyResume<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        // Only the primary authority (not guardian) can resume
        // This prevents a compromised guardian from resuming after
        // a legitimate pause
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

pub fn pause_handler(ctx: Context<EmergencyPause>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.paused = true;

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

pub fn resume_handler(ctx: Context<EmergencyResume>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.paused = false;

    let clock = Clock::get()?;
    emit!(BridgeResumed {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "✅ BRIDGE RESUMED by {}",
        ctx.accounts.authority.key()
    );
    Ok(())
}
