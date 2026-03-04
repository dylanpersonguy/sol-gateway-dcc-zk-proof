use anchor_lang::prelude::*;
use crate::state::{CheckpointConfig, CommitteeMember};
use crate::errors::CheckpointError;

#[derive(Accounts)]
#[instruction(member_pubkey: Pubkey)]
pub struct RegisterMember<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
        has_one = authority @ CheckpointError::Unauthorized,
    )]
    pub config: Account<'info, CheckpointConfig>,

    #[account(
        init,
        payer = authority,
        space = CommitteeMember::LEN,
        seeds = [b"member", member_pubkey.as_ref()],
        bump,
    )]
    pub member: Account<'info, CommitteeMember>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterMember>, member_pubkey: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.member_count < config.max_members,
        CheckpointError::MaxMembersReached
    );

    let clock = Clock::get()?;
    let member = &mut ctx.accounts.member;
    member.pubkey = member_pubkey;
    member.active = true;
    member.registered_at = clock.unix_timestamp;
    member.bump = ctx.bumps.member;

    config.member_count = config.member_count
        .checked_add(1)
        .ok_or(CheckpointError::ArithmeticOverflow)?;

    msg!("Committee member registered: {}", member_pubkey);
    Ok(())
}
