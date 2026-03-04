use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::{BridgeConfig, DepositRecord, UserState};
use crate::errors::BridgeError;
use crate::events::BridgeDepositSpl;
use crate::instructions::deposit::{compute_transfer_id, compute_message_id};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DepositSplParams {
    /// Recipient address on DecentralChain (32 bytes)
    pub recipient_dcc: [u8; 32],
    /// Amount to deposit in smallest token units
    pub amount: u64,
    /// Pre-computed transfer ID (verified on-chain)
    pub transfer_id: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: DepositSplParams)]
pub struct DepositSpl<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init_if_needed,
        payer = sender,
        space = UserState::LEN,
        seeds = [b"user_state", sender.key().as_ref()],
        bump,
    )]
    pub user_state: Account<'info, UserState>,

    /// Deposit record PDA — created per deposit with transfer_id seed
    #[account(
        init,
        payer = sender,
        space = DepositRecord::LEN,
        seeds = [
            b"deposit",
            params.transfer_id.as_ref()
        ],
        bump,
    )]
    pub deposit_record: Account<'info, DepositRecord>,

    /// The SPL token mint being deposited
    pub spl_mint: Account<'info, Mint>,

    /// Sender's token account (source)
    #[account(
        mut,
        associated_token::mint = spl_mint,
        associated_token::authority = sender,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// Bridge vault token account for this specific SPL mint.
    /// PDA-owned ATA — tokens are custodied by the bridge config PDA.
    #[account(
        init_if_needed,
        payer = sender,
        associated_token::mint = spl_mint,
        associated_token::authority = bridge_config,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositSpl>, params: DepositSplParams) -> Result<()> {
    let config = &ctx.accounts.bridge_config;

    // ── GUARD: Bridge must not be paused ──
    require!(!config.paused, BridgeError::BridgePaused);

    // ── GUARD: Deposit amount within bounds ──
    require!(params.amount >= config.min_deposit, BridgeError::DepositTooSmall);
    require!(params.amount <= config.max_deposit, BridgeError::DepositTooLarge);

    // ── GUARD: Valid DCC recipient (non-zero) ──
    require!(
        params.recipient_dcc != [0u8; 32],
        BridgeError::InvalidDccAddress
    );

    let clock = Clock::get()?;
    let user_state = &mut ctx.accounts.user_state;

    // Initialize user state if first deposit
    if user_state.user == Pubkey::default() {
        user_state.user = ctx.accounts.sender.key();
        user_state.next_nonce = 0;
        user_state.total_deposited = 0;
        user_state.bump = ctx.bumps.user_state;
    }

    let current_nonce = user_state.next_nonce;

    // ── Compute and verify globally unique transfer ID ──
    let expected_transfer_id = compute_transfer_id(
        &ctx.accounts.sender.key(),
        current_nonce,
    );
    require!(
        params.transfer_id == expected_transfer_id,
        BridgeError::InvalidTransferId
    );
    let transfer_id = expected_transfer_id;

    // ── Transfer SPL tokens from sender → vault ATA via CPI ──
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sender_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        params.amount,
    )?;

    // ── Update bridge config ──
    let config = &mut ctx.accounts.bridge_config;
    let event_index = config.global_nonce as u32;
    // Note: total_locked tracks native SOL. For SPL tokens, tracking is
    // per-deposit in the deposit record and via events.
    config.global_nonce = config.global_nonce
        .checked_add(1)
        .ok_or(BridgeError::ArithmeticOverflow)?;

    // ── Compute ZK bridge message_id (H-4 fix) ──
    // Uses SPL mint pubkey as asset_id so SPL deposits can be included in Merkle tree
    let message_id = compute_message_id(
        config.solana_chain_id,
        config.dcc_chain_id,
        ctx.program_id,
        clock.slot,
        event_index,
        &ctx.accounts.sender.key(),
        &params.recipient_dcc,
        params.amount,
        current_nonce,
        &ctx.accounts.spl_mint.key(),
    );

    // ── Update user state ──
    user_state.next_nonce = current_nonce
        .checked_add(1)
        .ok_or(BridgeError::ArithmeticOverflow)?;
    user_state.total_deposited = user_state.total_deposited
        .checked_add(params.amount)
        .ok_or(BridgeError::ArithmeticOverflow)?;

    // ── Populate deposit record ──
    let deposit = &mut ctx.accounts.deposit_record;
    deposit.transfer_id = transfer_id;
    deposit.message_id = message_id;
    deposit.sender = ctx.accounts.sender.key();
    deposit.recipient_dcc = params.recipient_dcc;
    deposit.amount = params.amount;
    deposit.nonce = current_nonce;
    deposit.slot = clock.slot;
    deposit.event_index = event_index;
    deposit.timestamp = clock.unix_timestamp;
    deposit.asset_id = ctx.accounts.spl_mint.key();
    deposit.processed = false;
    deposit.bump = ctx.bumps.deposit_record;

    // ── Emit SPL deposit event ──
    emit!(BridgeDepositSpl {
        transfer_id,
        message_id,
        sender: ctx.accounts.sender.key(),
        recipient_dcc: params.recipient_dcc,
        spl_mint: ctx.accounts.spl_mint.key(),
        amount: params.amount,
        nonce: current_nonce,
        slot: clock.slot,
        event_index,
        timestamp: clock.unix_timestamp,
        chain_id: config.solana_chain_id,
    });

    msg!(
        "SPL Deposit: {} units of mint {:?}, transfer_id: {:?}, message_id: {:?}, nonce: {}",
        params.amount,
        ctx.accounts.spl_mint.key(),
        &transfer_id[..8],
        &message_id[..8],
        current_nonce
    );

    Ok(())
}
