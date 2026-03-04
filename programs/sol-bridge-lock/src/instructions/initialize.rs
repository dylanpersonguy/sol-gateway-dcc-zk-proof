use anchor_lang::prelude::*;
use crate::state::BridgeConfig;
use crate::errors::BridgeError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeParams {
    /// Guardian authority for emergency operations
    pub guardian: Pubkey,
    /// Minimum validator signatures required (M in M-of-N)
    pub min_validators: u8,
    /// Maximum validators allowed
    pub max_validators: u8,
    /// Minimum deposit (lamports)
    pub min_deposit: u64,
    /// Maximum deposit (lamports)
    pub max_deposit: u64,
    /// Maximum daily outflow (lamports)
    pub max_daily_outflow: u64,
    /// Maximum single unlock (lamports)
    pub max_unlock_amount: u64,
    /// Required Solana confirmations
    pub required_confirmations: u16,
    /// Time delay for large withdrawals (seconds)
    pub large_withdrawal_delay: i64,
    /// Threshold for large withdrawals (lamports)
    pub large_withdrawal_threshold: u64,
    /// DCC chain ID
    pub dcc_chain_id: u32,
    /// Solana chain ID
    pub solana_chain_id: u32,
    /// Resume timelock delay in seconds (minimum 300 = 5 minutes)
    pub resume_delay_seconds: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = BridgeConfig::LEN,
        seeds = [b"bridge_config"],
        bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    /// CHECK: PDA vault — no private key can sign for this account
    #[account(
        seeds = [b"vault"],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    // Validate configuration parameters
    require!(
        params.min_validators >= 1 && params.min_validators <= params.max_validators,
        BridgeError::InvalidConfig
    );
    require!(params.max_validators <= 20, BridgeError::InvalidConfig);
    require!(params.min_deposit > 0, BridgeError::InvalidConfig);
    require!(params.max_deposit > params.min_deposit, BridgeError::InvalidConfig);
    require!(params.max_daily_outflow > 0, BridgeError::InvalidConfig);
    require!(params.required_confirmations >= 32, BridgeError::InvalidConfig);
    require!(params.resume_delay_seconds >= 300, BridgeError::InvalidConfig);

    let config = &mut ctx.accounts.bridge_config;
    
    config.authority = ctx.accounts.authority.key();
    config.guardian = params.guardian;
    config.paused = false;
    config.global_nonce = 0;
    config.total_locked = 0;
    config.total_unlocked = 0;
    config.validator_count = 0;
    config.min_validators = params.min_validators;
    config.max_validators = params.max_validators;
    config.min_deposit = params.min_deposit;
    config.max_deposit = params.max_deposit;
    config.max_daily_outflow = params.max_daily_outflow;
    config.current_daily_outflow = 0;
    config.last_daily_reset = Clock::get()?.unix_timestamp;
    config.max_unlock_amount = params.max_unlock_amount;
    config.required_confirmations = params.required_confirmations;
    config.large_withdrawal_delay = params.large_withdrawal_delay;
    config.large_withdrawal_threshold = params.large_withdrawal_threshold;
    config.dcc_chain_id = params.dcc_chain_id;
    config.solana_chain_id = params.solana_chain_id;
    config.bump = ctx.bumps.bridge_config;
    config.vault_bump = ctx.bumps.vault;
    config.resume_requested_at = 0;
    config.resume_delay_seconds = params.resume_delay_seconds;
    config._reserved = [0u8; 112];

    msg!("Bridge initialized. Authority: {}", config.authority);
    Ok(())
}
