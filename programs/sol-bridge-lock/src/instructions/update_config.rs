use anchor_lang::prelude::*;
use crate::state::BridgeConfig;
use crate::errors::BridgeError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateConfigParams {
    pub min_deposit: Option<u64>,
    pub max_deposit: Option<u64>,
    pub max_daily_outflow: Option<u64>,
    pub max_unlock_amount: Option<u64>,
    pub required_confirmations: Option<u16>,
    pub large_withdrawal_delay: Option<i64>,
    pub large_withdrawal_threshold: Option<u64>,
    pub min_validators: Option<u8>,
    pub new_authority: Option<Pubkey>,
    pub new_guardian: Option<Pubkey>,
    pub resume_delay_seconds: Option<i64>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
        constraint = bridge_config.authority == authority.key() @ BridgeError::Unauthorized,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;

    if let Some(min_deposit) = params.min_deposit {
        require!(min_deposit > 0, BridgeError::InvalidConfig);
        config.min_deposit = min_deposit;
    }

    if let Some(max_deposit) = params.max_deposit {
        require!(max_deposit > config.min_deposit, BridgeError::InvalidConfig);
        config.max_deposit = max_deposit;
    }

    if let Some(max_daily_outflow) = params.max_daily_outflow {
        require!(max_daily_outflow > 0, BridgeError::InvalidConfig);
        config.max_daily_outflow = max_daily_outflow;
    }

    if let Some(max_unlock_amount) = params.max_unlock_amount {
        require!(max_unlock_amount > 0, BridgeError::InvalidConfig);
        config.max_unlock_amount = max_unlock_amount;
    }

    if let Some(required_confirmations) = params.required_confirmations {
        // Minimum 32 confirmations for safety
        require!(required_confirmations >= 32, BridgeError::InvalidConfig);
        config.required_confirmations = required_confirmations;
    }

    if let Some(large_withdrawal_delay) = params.large_withdrawal_delay {
        require!(large_withdrawal_delay >= 0, BridgeError::InvalidConfig);
        config.large_withdrawal_delay = large_withdrawal_delay;
    }

    if let Some(large_withdrawal_threshold) = params.large_withdrawal_threshold {
        config.large_withdrawal_threshold = large_withdrawal_threshold;
    }

    if let Some(min_validators) = params.min_validators {
        require!(
            min_validators >= 1 && min_validators <= config.max_validators,
            BridgeError::InvalidConfig
        );
        config.min_validators = min_validators;
    }

    if let Some(new_authority) = params.new_authority {
        config.authority = new_authority;
        msg!("Authority transferred to: {}", new_authority);
    }

    if let Some(new_guardian) = params.new_guardian {
        config.guardian = new_guardian;
        msg!("Guardian transferred to: {}", new_guardian);
    }

    if let Some(resume_delay_seconds) = params.resume_delay_seconds {
        // Minimum 5 minutes to prevent trivial bypass
        require!(resume_delay_seconds >= 300, BridgeError::InvalidConfig);
        config.resume_delay_seconds = resume_delay_seconds;
    }

    msg!("Bridge config updated");
    Ok(())
}
