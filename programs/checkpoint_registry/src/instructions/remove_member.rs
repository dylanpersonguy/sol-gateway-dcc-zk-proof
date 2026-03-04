use anchor_lang::prelude::*;
use crate::state::{CheckpointConfig, CommitteeMember};
use crate::errors::CheckpointError;

#[derive(Accounts)]
#[instruction(member_pubkey: Pubkey)]
pub struct RemoveMember<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
        has_one = authority @ CheckpointError::Unauthorized,
    )]
    pub config: Account<'info, CheckpointConfig>,

    #[account(
        mut,
        seeds = [b"member", member_pubkey.as_ref()],
        bump = member.bump,
    )]
    pub member: Account<'info, CommitteeMember>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RemoveMember>, _member_pubkey: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Cannot remove if it would breach minimum
    require!(
        config.member_count > config.min_signatures,
        CheckpointError::RemovalBreachesMinimum
    );

    let member = &mut ctx.accounts.member;
    require!(member.active, CheckpointError::MemberNotActive);

    member.active = false;
    config.member_count = config.member_count.saturating_sub(1);

    msg!("Committee member removed: {}", member.pubkey);
    Ok(())
}
