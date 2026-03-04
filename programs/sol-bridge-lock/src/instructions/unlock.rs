use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use crate::state::{BridgeConfig, UnlockRecord, ValidatorEntry};
use crate::errors::BridgeError;
use crate::events::BridgeUnlock;

/// Validator signature attestation for an unlock operation
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ValidatorAttestation {
    /// Validator's public key
    pub validator: Pubkey,
    /// Ed25519 signature over the unlock message
    pub signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UnlockParams {
    /// Transfer ID from the DCC burn event
    pub transfer_id: [u8; 32],
    /// Recipient Solana address
    pub recipient: Pubkey,
    /// Amount to unlock (lamports)
    pub amount: u64,
    /// DCC burn transaction hash
    pub burn_tx_hash: [u8; 32],
    /// DCC chain ID (for domain separation verification)
    pub dcc_chain_id: u32,
    /// Expiration timestamp (prevents stale unlocks)
    pub expiration: i64,
    /// Validator attestations (M-of-N signatures)
    pub attestations: Vec<ValidatorAttestation>,
}

#[derive(Accounts)]
#[instruction(params: UnlockParams)]
pub struct Unlock<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = payer,
        space = UnlockRecord::LEN,
        seeds = [b"unlock", params.transfer_id.as_ref()],
        bump,
    )]
    pub unlock_record: Account<'info, UnlockRecord>,

    /// CHECK: PDA vault — source of unlocked funds
    #[account(
        mut,
        seeds = [b"vault"],
        bump = bridge_config.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Recipient receives the unlocked SOL
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Ed25519 program for signature verification
    #[account(address = ed25519_program::ID)]
    pub ed25519_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar for Ed25519 introspection
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

pub fn handler(ctx: Context<Unlock>, params: UnlockParams) -> Result<()> {
    let config = &ctx.accounts.bridge_config;

    // ── GUARD: Bridge must not be paused ──
    require!(!config.paused, BridgeError::BridgePaused);

    // ── GUARD: Chain ID domain separation ──
    require!(
        params.dcc_chain_id == config.dcc_chain_id,
        BridgeError::ChainIdMismatch
    );

    let clock = Clock::get()?;

    // ── GUARD: Transfer not expired ──
    require!(
        params.expiration > clock.unix_timestamp,
        BridgeError::TransferExpired
    );

    // ── GUARD: Amount within limits ──
    require!(
        params.amount <= config.max_unlock_amount,
        BridgeError::UnlockAmountExceeded
    );

    // ── GUARD: Sufficient validator signatures ──
    require!(
        params.attestations.len() >= config.min_validators as usize,
        BridgeError::InsufficientSignatures
    );

    // ── GUARD: Recipient matches ──
    require!(
        params.recipient == ctx.accounts.recipient.key(),
        BridgeError::Unauthorized
    );

    // ── Verify no duplicate validator signatures ──
    let mut seen_validators: Vec<Pubkey> = Vec::new();
    for attestation in &params.attestations {
        require!(
            !seen_validators.contains(&attestation.validator),
            BridgeError::DuplicateValidatorSignature
        );
        seen_validators.push(attestation.validator);
    }

    // ── Construct the canonical message for signature verification ──
    let message = construct_unlock_message(
        &params.transfer_id,
        &params.recipient,
        params.amount,
        &params.burn_tx_hash,
        params.dcc_chain_id,
        params.expiration,
    );

    // ── Verify each validator signature ──
    // In production, these would be verified via the Ed25519 precompile
    // For now, we verify the validator is in the active set
    // Actual Ed25519 verification happens via instruction introspection
    let mut valid_sigs = 0u8;

    for attestation in &params.attestations {
        // Find validator entry in remaining accounts
        let validator_found = ctx.remaining_accounts.iter().any(|acc| {
            // Deserialize manually to avoid lifetime issues
            let data = acc.try_borrow_data();
            if let Ok(data) = data {
                if data.len() >= ValidatorEntry::LEN {
                    // Skip 8-byte discriminator, read pubkey (32 bytes) and active (1 byte)
                    let pubkey = Pubkey::try_from(&data[8..40]).unwrap_or_default();
                    let active = data[40] != 0;
                    pubkey == attestation.validator && active
                } else {
                    false
                }
            } else {
                false
            }
        });

        require!(validator_found, BridgeError::ValidatorNotActive);

        // Verify Ed25519 signature via instruction introspection
        // The transaction must include Ed25519 precompile instructions before this one
        let sig_valid = verify_ed25519_signature_introspect(
            &ctx.accounts.instructions_sysvar,
            &attestation.validator,
            &message,
            &attestation.signature,
        )?;
        require!(sig_valid, BridgeError::InvalidSignature);
        
        valid_sigs += 1;
    }

    require!(
        valid_sigs >= config.min_validators,
        BridgeError::InsufficientSignatures
    );

    // ── CIRCUIT BREAKER: Check daily outflow ──
    let config = &mut ctx.accounts.bridge_config;
    
    // Reset daily counter if new day
    let day_seconds: i64 = 86400;
    if clock.unix_timestamp - config.last_daily_reset >= day_seconds {
        config.current_daily_outflow = 0;
        config.last_daily_reset = clock.unix_timestamp;
    }

    let new_daily_outflow = config.current_daily_outflow
        .checked_add(params.amount)
        .ok_or(BridgeError::ArithmeticOverflow)?;
    require!(
        new_daily_outflow <= config.max_daily_outflow,
        BridgeError::DailyOutflowExceeded
    );

    // ── GUARD: Large withdrawal delay ──
    if params.amount >= config.large_withdrawal_threshold {
        // For large withdrawals, we create the record but don't execute immediately
        // A separate instruction must be called after the delay
        let unlock_record = &mut ctx.accounts.unlock_record;
        unlock_record.transfer_id = params.transfer_id;
        unlock_record.recipient = params.recipient;
        unlock_record.amount = params.amount;
        unlock_record.timestamp = clock.unix_timestamp;
        unlock_record.burn_tx_hash = params.burn_tx_hash;
        unlock_record.executed = false;
        unlock_record.scheduled_time = clock.unix_timestamp + config.large_withdrawal_delay;
        unlock_record.bump = ctx.bumps.unlock_record;

        msg!(
            "Large withdrawal scheduled. Execute after: {}",
            unlock_record.scheduled_time
        );
        return Ok(());
    }

    // ── Execute the unlock: Transfer SOL from vault to recipient ──
    let vault_lamports = ctx.accounts.vault.lamports();
    require!(
        vault_lamports >= params.amount,
        BridgeError::InsufficientVaultBalance
    );

    // Transfer from PDA vault using CPI with signer seeds
    let vault_seeds: &[&[u8]] = &[b"vault", &[config.vault_bump]];
    let signer_seeds = &[vault_seeds];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
            signer_seeds,
        ),
        params.amount,
    )?;

    // ── Update state ──
    config.total_unlocked = config.total_unlocked
        .checked_add(params.amount)
        .ok_or(BridgeError::ArithmeticOverflow)?;
    config.current_daily_outflow = new_daily_outflow;

    let unlock_record = &mut ctx.accounts.unlock_record;
    unlock_record.transfer_id = params.transfer_id;
    unlock_record.recipient = params.recipient;
    unlock_record.amount = params.amount;
    unlock_record.timestamp = clock.unix_timestamp;
    unlock_record.burn_tx_hash = params.burn_tx_hash;
    unlock_record.executed = true;
    unlock_record.scheduled_time = 0;
    unlock_record.bump = ctx.bumps.unlock_record;

    // ── Emit unlock event ──
    emit!(BridgeUnlock {
        transfer_id: params.transfer_id,
        recipient: params.recipient,
        amount: params.amount,
        burn_tx_hash: params.burn_tx_hash,
        timestamp: clock.unix_timestamp,
        signature_count: valid_sigs,
    });

    msg!(
        "Unlock: {} lamports to {}, transfer_id: {:?}",
        params.amount,
        params.recipient,
        &params.transfer_id[..8]
    );

    Ok(())
}

/// Construct the canonical message that validators must sign.
/// Domain-separated to prevent cross-chain signature replay.
fn construct_unlock_message(
    transfer_id: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
    burn_tx_hash: &[u8; 32],
    dcc_chain_id: u32,
    expiration: i64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(128);
    // Domain separator
    msg.extend_from_slice(b"SOL_DCC_BRIDGE_UNLOCK_V1");
    msg.extend_from_slice(transfer_id);
    msg.extend_from_slice(recipient.as_ref());
    msg.extend_from_slice(&amount.to_le_bytes());
    msg.extend_from_slice(burn_tx_hash);
    msg.extend_from_slice(&dcc_chain_id.to_le_bytes());
    msg.extend_from_slice(&expiration.to_le_bytes());
    msg
}

/// Verify an Ed25519 signature via Solana instruction introspection.
///
/// This is the production-grade pattern used by Wormhole, Pyth, and other
/// production bridges. The flow:
///
/// 1. The transaction includes Ed25519SigVerify instructions BEFORE the unlock ix
/// 2. Each Ed25519SigVerify instruction verifies one (pubkey, message, signature) triple
/// 3. This function introspects preceding instructions to confirm a matching
///    Ed25519 verification instruction exists for each attestation
///
/// Security properties:
/// - The Ed25519 program is a native Solana precompile (cannot be spoofed)
/// - We verify the program_id, pubkey, message, and signature all match
/// - Instructions in the same transaction are atomic — if the Ed25519 ix
///   fails, the entire transaction (including this unlock) is rolled back
fn verify_ed25519_signature_introspect(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
    expected_signature: &[u8; 64],
) -> Result<bool> {
    // Load the current instruction index
    let current_ix_index = ix_sysvar::load_current_index_checked(instructions_sysvar)
        .map_err(|_| BridgeError::InvalidSignature)?;

    // Search for a matching Ed25519 precompile instruction in preceding ixs
    for ix_index in 0..current_ix_index {
        let ix = ix_sysvar::load_instruction_at_checked(ix_index as usize, instructions_sysvar)
            .map_err(|_| BridgeError::InvalidSignature)?;

        // Must be an Ed25519 precompile instruction
        if ix.program_id != ed25519_program::ID {
            continue;
        }

        // Parse the Ed25519 instruction data
        // Format: https://docs.solanalabs.com/runtime/programs#ed25519-program
        // 
        // Byte layout:
        // [0]     num_signatures (u8)
        // [1]     padding (u8)
        // For each signature:
        // [2..4]  signature_offset (u16 LE)
        // [4..6]  signature_instruction_index (u16 LE)
        // [6..8]  public_key_offset (u16 LE)
        // [8..10] public_key_instruction_index (u16 LE)
        // [10..12] message_data_offset (u16 LE)
        // [12..14] message_data_size (u16 LE)
        // [14..16] message_instruction_index (u16 LE)
        //
        // Then the actual data (pubkey, signature, message) follows at the offsets
        
        let data = &ix.data;
        if data.len() < 2 {
            continue;
        }

        let num_signatures = data[0] as usize;
        if num_signatures == 0 {
            continue;
        }

        // Each signature entry is 14 bytes (offsets), starting at byte 2
        let header_size = 2 + num_signatures * 14;
        if data.len() < header_size {
            continue;
        }

        for sig_idx in 0..num_signatures {
            let offset = 2 + sig_idx * 14;

            // Parse offsets (all u16 LE)
            let sig_offset = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            let sig_ix_index = u16::from_le_bytes([data[offset + 2], data[offset + 3]]);
            let pk_offset = u16::from_le_bytes([data[offset + 4], data[offset + 5]]) as usize;
            let pk_ix_index = u16::from_le_bytes([data[offset + 6], data[offset + 7]]);
            let msg_offset = u16::from_le_bytes([data[offset + 8], data[offset + 9]]) as usize;
            let msg_size = u16::from_le_bytes([data[offset + 10], data[offset + 11]]) as usize;
            let msg_ix_index = u16::from_le_bytes([data[offset + 12], data[offset + 13]]);

            // We only support data embedded in the same instruction (ix_index == u16::MAX)
            // u16::MAX means "use data from this instruction's data field"
            let self_ref = u16::MAX;
            if sig_ix_index != self_ref || pk_ix_index != self_ref || msg_ix_index != self_ref {
                continue;
            }

            // Extract and verify public key
            if pk_offset + 32 > data.len() {
                continue;
            }
            let ix_pubkey = &data[pk_offset..pk_offset + 32];
            if ix_pubkey != expected_pubkey.as_ref() {
                continue;
            }

            // Extract and verify signature
            if sig_offset + 64 > data.len() {
                continue;
            }
            let ix_signature = &data[sig_offset..sig_offset + 64];
            if ix_signature != expected_signature.as_slice() {
                continue;
            }

            // Extract and verify message
            if msg_offset + msg_size > data.len() {
                continue;
            }
            let ix_message = &data[msg_offset..msg_offset + msg_size];
            if ix_message == expected_message {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

// ═══════════════════════════════════════════════════════════════
// EXECUTE SCHEDULED UNLOCK — Completes a time-delayed large withdrawal
// ═══════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(transfer_id: [u8; 32])]
pub struct ExecuteScheduledUnlock<'info> {
    #[account(
        mut,
        seeds = [b"bridge_config"],
        bump = bridge_config.bump,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        mut,
        seeds = [b"unlock", transfer_id.as_ref()],
        bump = unlock_record.bump,
        // Must not already be executed
        constraint = !unlock_record.executed @ BridgeError::UnlockAlreadyExecuted,
    )]
    pub unlock_record: Account<'info, UnlockRecord>,

    /// CHECK: PDA vault — source of unlocked funds
    #[account(
        mut,
        seeds = [b"vault"],
        bump = bridge_config.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Recipient receives the unlocked SOL — must match unlock_record
    #[account(
        mut,
        constraint = unlock_record.recipient == recipient.key() @ BridgeError::Unauthorized,
    )]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn execute_scheduled_unlock_handler(
    ctx: Context<ExecuteScheduledUnlock>,
    transfer_id: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.bridge_config;
    let unlock_record = &ctx.accounts.unlock_record;

    // ── GUARD: Bridge must not be paused ──
    require!(!config.paused, BridgeError::BridgePaused);

    let clock = Clock::get()?;

    // ── GUARD: Timelock delay must have elapsed ──
    require!(
        clock.unix_timestamp >= unlock_record.scheduled_time,
        BridgeError::WithdrawalDelayNotElapsed
    );

    let amount = unlock_record.amount;

    // ── GUARD: Vault has sufficient funds ──
    let vault_lamports = ctx.accounts.vault.lamports();
    require!(
        vault_lamports >= amount,
        BridgeError::InsufficientVaultBalance
    );

    // ── Execute the transfer ──
    let config = &mut ctx.accounts.bridge_config;
    let vault_seeds: &[&[u8]] = &[b"vault", &[config.vault_bump]];
    let signer_seeds = &[vault_seeds];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // ── Update state ──
    config.total_unlocked = config.total_unlocked
        .checked_add(amount)
        .ok_or(BridgeError::ArithmeticOverflow)?;

    let unlock_record = &mut ctx.accounts.unlock_record;
    unlock_record.executed = true;

    // ── Emit unlock event ──
    emit!(BridgeUnlock {
        transfer_id,
        recipient: unlock_record.recipient,
        amount,
        burn_tx_hash: unlock_record.burn_tx_hash,
        timestamp: clock.unix_timestamp,
        signature_count: 0, // Already verified during initial unlock
    });

    msg!(
        "Scheduled unlock executed: {} lamports to {}, transfer_id: {:?}",
        amount,
        unlock_record.recipient,
        &transfer_id[..8]
    );

    Ok(())
}
