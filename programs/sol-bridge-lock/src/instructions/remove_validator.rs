use anchor_lang::prelude::*;
use crate::state::{BridgeConfig, ValidatorEntry};
use crate::errors::BridgeError;
use crate::events::ValidatorRemoved;

#[derive(Accounts)]
#[instruction(validator_pubkey: Pubkey)]
pub struct RemoveValidator<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        mut,
        seeds = [b"validator", validator_pubkey.as_ref()],
        bump = validator_entry.bump,
        close = authority,
    )]
    pub validator_entry: Account<'info, ValidatorEntry>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RemoveValidator>, validator_pubkey: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    // ── GUARD: Removing this validator must not breach the minimum threshold ──
    require!(
        config.validator_count > config.min_validators,
        BridgeError::ValidatorRemovalBreachesMinimum
    );

    config.validator_count -= 1;

    let clock = Clock::get()?;
    emit!(ValidatorRemoved {
        validator: validator_pubkey,
        validator_count: config.validator_count,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Validator removed: {}. Remaining: {}",
        validator_pubkey,
        config.validator_count
    );
    Ok(())
}
