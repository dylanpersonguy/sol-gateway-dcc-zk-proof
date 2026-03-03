use anchor_lang::prelude::*;
use crate::state::{BridgeConfig, ValidatorEntry};
use crate::errors::BridgeError;
use crate::events::ValidatorRegistered;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RegisterValidatorParams {
    pub validator_pubkey: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: RegisterValidatorParams)]
pub struct RegisterValidator<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = ValidatorEntry::LEN,
        seeds = [b"validator", params.validator_pubkey.as_ref()],
        bump,
    )]
    pub validator_entry: Account<'info, ValidatorEntry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterValidator>, params: RegisterValidatorParams) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    // ── GUARD: Maximum validator count ──
    require!(
        config.validator_count < config.max_validators,
        BridgeError::MaxValidatorsReached
    );

    let clock = Clock::get()?;
    let entry = &mut ctx.accounts.validator_entry;
    entry.pubkey = params.validator_pubkey;
    entry.active = true;
    entry.registered_at = clock.unix_timestamp;
    entry.attestation_count = 0;
    entry.fault_count = 0;
    entry.bump = ctx.bumps.validator_entry;

    config.validator_count += 1;

    emit!(ValidatorRegistered {
        validator: params.validator_pubkey,
        validator_count: config.validator_count,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Validator registered: {}. Total: {}",
        params.validator_pubkey,
        config.validator_count
    );
    Ok(())
}
