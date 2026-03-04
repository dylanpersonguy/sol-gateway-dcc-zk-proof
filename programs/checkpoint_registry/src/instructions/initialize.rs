use anchor_lang::prelude::*;
use crate::state::CheckpointConfig;
use crate::errors::CheckpointError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeParams {
    pub guardian: Pubkey,
    pub min_signatures: u8,
    pub max_members: u8,
    pub finality_safety_margin: u64,
    pub timelock_seconds: i64,
    pub checkpoint_ttl_slots: u64,
    pub max_pending: u8,
    pub bridge_program_id: Pubkey,
    pub solana_chain_id: u32,
    pub dcc_chain_id: u32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = CheckpointConfig::LEN,
        seeds = [b"checkpoint_config"],
        bump,
    )]
    pub config: Account<'info, CheckpointConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    require!(params.min_signatures >= 1, CheckpointError::InvalidConfig);
    require!(params.max_members >= params.min_signatures, CheckpointError::InvalidConfig);
    require!(params.timelock_seconds >= 0, CheckpointError::InvalidConfig);
    require!(params.checkpoint_ttl_slots > 0, CheckpointError::InvalidConfig);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.guardian = params.guardian;
    config.paused = false;
    config.next_checkpoint_id = 0;
    config.last_checkpoint_slot = 0;
    config.min_signatures = params.min_signatures;
    config.member_count = 0;
    config.max_members = params.max_members;
    config.finality_safety_margin = params.finality_safety_margin;
    config.timelock_seconds = params.timelock_seconds;
    config.checkpoint_ttl_slots = params.checkpoint_ttl_slots;
    config.max_pending = params.max_pending;
    config.pending_count = 0;
    config.bridge_program_id = params.bridge_program_id;
    config.solana_chain_id = params.solana_chain_id;
    config.dcc_chain_id = params.dcc_chain_id;
    config.bump = ctx.bumps.config;
    config._reserved = [0u8; 64];

    msg!("Checkpoint registry initialized");
    Ok(())
}
