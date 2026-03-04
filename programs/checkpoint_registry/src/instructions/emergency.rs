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

    msg!("Checkpoint registry paused by {}", caller);
    Ok(())
}

pub fn resume_handler(ctx: Context<EmergencyResumeCheckpoint>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = false;

    msg!("Checkpoint registry resumed");
    Ok(())
}
