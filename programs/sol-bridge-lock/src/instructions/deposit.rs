use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::hash::hash;
use crate::state::{BridgeConfig, DepositRecord, UserState};
use crate::errors::BridgeError;
use crate::events::BridgeDeposit;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DepositParams {
    /// Recipient address on DecentralChain (32 bytes)
    pub recipient_dcc: [u8; 32],
    /// Amount to deposit in lamports
    pub amount: u64,
    /// Pre-computed transfer ID (verified on-chain)
    pub transfer_id: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: DepositParams)]
pub struct Deposit<'info> {
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

    /// CHECK: PDA vault — receives the deposited SOL
    #[account(
        mut,
        seeds = [b"vault"],
        bump = bridge_config.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Compute a deterministic, globally unique transfer ID.
/// Uses hash(sender || nonce) — (sender, nonce) is unique because
/// nonces are strictly monotonic per user.
pub fn compute_transfer_id(sender: &Pubkey, nonce: u64) -> [u8; 32] {
    let mut data = Vec::with_capacity(40);
    data.extend_from_slice(sender.as_ref());
    data.extend_from_slice(&nonce.to_le_bytes());
    hash(&data).to_bytes()
}

pub fn handler(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
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

    // ── Transfer SOL to vault via CPI ──
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        params.amount,
    )?;

    // ── Update bridge config ──
    let config = &mut ctx.accounts.bridge_config;
    config.total_locked = config.total_locked
        .checked_add(params.amount)
        .ok_or(BridgeError::ArithmeticOverflow)?;
    config.global_nonce = config.global_nonce
        .checked_add(1)
        .ok_or(BridgeError::ArithmeticOverflow)?;

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
    deposit.sender = ctx.accounts.sender.key();
    deposit.recipient_dcc = params.recipient_dcc;
    deposit.amount = params.amount;
    deposit.nonce = current_nonce;
    deposit.slot = clock.slot;
    deposit.timestamp = clock.unix_timestamp;
    deposit.processed = false;
    deposit.bump = ctx.bumps.deposit_record;

    // ── Emit canonical deposit event ──
    emit!(BridgeDeposit {
        transfer_id,
        sender: ctx.accounts.sender.key(),
        recipient_dcc: params.recipient_dcc,
        amount: params.amount,
        nonce: current_nonce,
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
        chain_id: config.solana_chain_id,
    });

    msg!(
        "Deposit: {} lamports, transfer_id: {:?}, nonce: {}",
        params.amount,
        &transfer_id[..8],
        current_nonce
    );

    Ok(())
}
