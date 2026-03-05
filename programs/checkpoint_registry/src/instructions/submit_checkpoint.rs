use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use crate::state::{CheckpointConfig, CheckpointEntry, CheckpointStatus, CommitteeMember};
use crate::errors::CheckpointError;
use crate::events::CheckpointSubmitted;

/// Committee member attestation for a checkpoint
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MemberAttestation {
    pub member: Pubkey,
    pub signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SubmitCheckpointParams {
    /// Solana slot this checkpoint covers
    pub slot: u64,
    /// Merkle root of deposit events in this window
    pub commitment_root: [u8; 32],
    /// Number of events included
    pub event_count: u32,
    /// Committee member attestations
    pub attestations: Vec<MemberAttestation>,
}

#[derive(Accounts)]
#[instruction(params: SubmitCheckpointParams)]
pub struct SubmitCheckpoint<'info> {
    #[account(
        mut,
        seeds = [b"checkpoint_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, CheckpointConfig>,

    #[account(
        init,
        payer = submitter,
        space = CheckpointEntry::LEN,
        seeds = [b"checkpoint", config.next_checkpoint_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub checkpoint: Account<'info, CheckpointEntry>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Ed25519 program for signature verification
    #[account(address = ed25519_program::ID)]
    pub ed25519_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

pub fn handler(ctx: Context<SubmitCheckpoint>, params: SubmitCheckpointParams) -> Result<()> {
    let config = &ctx.accounts.config;

    // ── GUARD: Not paused ──
    require!(!config.paused, CheckpointError::RegistryPaused);

    // ── GUARD: Pending limit ──
    require!(
        config.pending_count < config.max_pending,
        CheckpointError::MaxPendingReached
    );

    // ── GUARD: Slot must advance ──
    require!(
        params.slot > config.last_checkpoint_slot,
        CheckpointError::SlotNotAdvancing
    );

    // ── GUARD: Root cannot be zero ──
    require!(
        params.commitment_root != [0u8; 32],
        CheckpointError::ZeroRoot
    );

    // ── GUARD: Finality safety margin ──
    // The current slot must be at least (checkpoint_slot + safety_margin)
    let clock = Clock::get()?;
    let current_slot = clock.slot;
    let required_slot = params.slot
        .checked_add(config.finality_safety_margin)
        .ok_or(CheckpointError::ArithmeticOverflow)?;
    require!(
        current_slot >= required_slot,
        CheckpointError::FinalitySafetyMarginNotMet
    );

    // ── GUARD: Sufficient committee signatures ──
    require!(
        params.attestations.len() >= config.min_signatures as usize,
        CheckpointError::InsufficientSignatures
    );

    // ── Verify committee signatures ──
    let message = construct_checkpoint_message(
        config.next_checkpoint_id,
        params.slot,
        &params.commitment_root,
        params.event_count,
        config.solana_chain_id,
        config.dcc_chain_id,
    );

    let mut seen_members: Vec<Pubkey> = Vec::new();
    let mut valid_sigs = 0u8;

    // Pre-compute the CommitteeMember discriminator (first 8 bytes of SHA256("account:CommitteeMember"))
    let member_discriminator: [u8; 8] = {
        let mut hasher = anchor_lang::solana_program::hash::Hasher::default();
        hasher.hash(b"account:CommitteeMember");
        let hash = hasher.result();
        let mut disc = [0u8; 8];
        disc.copy_from_slice(&hash.to_bytes()[..8]);
        disc
    };

    for attestation in &params.attestations {
        // No duplicate signers
        require!(
            !seen_members.contains(&attestation.member),
            CheckpointError::DuplicateMemberSignature
        );
        seen_members.push(attestation.member);

        // SECURITY FIX (CRIT-2): Validate remaining_accounts are legitimate CommitteeMember PDAs.
        // Each account MUST be:
        //   1. Owned by this program (prevents forged accounts on other programs)
        //   2. Have correct Anchor discriminator for CommitteeMember
        //   3. Derive from expected PDA seeds [b"member", member_pubkey]
        //   4. Be marked as active
        let member_found = ctx.remaining_accounts.iter().any(|acc| {
            // CHECK 1: Account must be owned by THIS program
            if acc.owner != ctx.program_id {
                return false;
            }

            // CHECK 2: Verify PDA derivation
            let (expected_pda, _bump) = Pubkey::find_program_address(
                &[b"member", attestation.member.as_ref()],
                ctx.program_id,
            );
            if acc.key() != expected_pda {
                return false;
            }

            let data = acc.try_borrow_data();
            if let Ok(data) = data {
                if data.len() >= CommitteeMember::LEN {
                    // CHECK 3: Verify Anchor account discriminator
                    if data[..8] != member_discriminator {
                        return false;
                    }
                    let pubkey = Pubkey::try_from(&data[8..40]).unwrap_or_default();
                    let active = data[40] != 0;
                    pubkey == attestation.member && active
                } else {
                    false
                }
            } else {
                false
            }
        });
        require!(member_found, CheckpointError::MemberNotActive);

        // Verify Ed25519 signature via instruction introspection
        let sig_valid = verify_ed25519_introspect(
            &ctx.accounts.instructions_sysvar,
            &attestation.member,
            &message,
            &attestation.signature,
        )?;
        require!(sig_valid, CheckpointError::InvalidMemberSignature);

        valid_sigs += 1;
    }

    require!(
        valid_sigs >= config.min_signatures,
        CheckpointError::InsufficientSignatures
    );

    // ── Create checkpoint entry ──
    let checkpoint = &mut ctx.accounts.checkpoint;
    checkpoint.checkpoint_id = config.next_checkpoint_id;
    checkpoint.slot = params.slot;
    checkpoint.commitment_root = params.commitment_root;
    checkpoint.event_count = params.event_count;
    checkpoint.submitted_at = clock.unix_timestamp;
    checkpoint.activates_at = clock.unix_timestamp
        .checked_add(config.timelock_seconds)
        .ok_or(CheckpointError::ArithmeticOverflow)?;
    checkpoint.expires_at_slot = current_slot
        .checked_add(config.checkpoint_ttl_slots)
        .ok_or(CheckpointError::ArithmeticOverflow)?;
    checkpoint.status = CheckpointStatus::Pending;
    checkpoint.signature_count = valid_sigs;
    checkpoint.bump = ctx.bumps.checkpoint;

    // ── Update config ──
    let config = &mut ctx.accounts.config;
    config.last_checkpoint_slot = params.slot;
    config.next_checkpoint_id = config.next_checkpoint_id
        .checked_add(1)
        .ok_or(CheckpointError::ArithmeticOverflow)?;
    config.pending_count = config.pending_count
        .checked_add(1)
        .ok_or(CheckpointError::ArithmeticOverflow)?;

    // ── Emit event ──
    emit!(CheckpointSubmitted {
        checkpoint_id: checkpoint.checkpoint_id,
        slot: checkpoint.slot,
        commitment_root: checkpoint.commitment_root,
        event_count: checkpoint.event_count,
        submitted_at: checkpoint.submitted_at,
        activates_at: checkpoint.activates_at,
        signature_count: checkpoint.signature_count,
    });

    msg!(
        "Checkpoint #{} submitted for slot {}, activates at {}",
        checkpoint.checkpoint_id,
        checkpoint.slot,
        checkpoint.activates_at
    );

    Ok(())
}

/// Construct the canonical message that committee members must sign.
fn construct_checkpoint_message(
    checkpoint_id: u64,
    slot: u64,
    commitment_root: &[u8; 32],
    event_count: u32,
    solana_chain_id: u32,
    dcc_chain_id: u32,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(96);
    msg.extend_from_slice(b"DCC_SOL_BRIDGE_V1_CHECKPOINT");
    msg.extend_from_slice(&checkpoint_id.to_le_bytes());
    msg.extend_from_slice(&slot.to_le_bytes());
    msg.extend_from_slice(commitment_root);
    msg.extend_from_slice(&event_count.to_le_bytes());
    msg.extend_from_slice(&solana_chain_id.to_le_bytes());
    msg.extend_from_slice(&dcc_chain_id.to_le_bytes());
    msg
}

/// Verify Ed25519 signature via instruction introspection (same pattern as bridge vault).
fn verify_ed25519_introspect(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
    expected_signature: &[u8; 64],
) -> Result<bool> {
    let current_ix_index = ix_sysvar::load_current_index_checked(instructions_sysvar)
        .map_err(|_| CheckpointError::InvalidMemberSignature)?;

    for ix_index in 0..current_ix_index {
        let ix = ix_sysvar::load_instruction_at_checked(ix_index as usize, instructions_sysvar)
            .map_err(|_| CheckpointError::InvalidMemberSignature)?;

        if ix.program_id != ed25519_program::ID {
            continue;
        }

        let data = &ix.data;
        if data.len() < 2 {
            continue;
        }

        let num_signatures = data[0] as usize;
        if num_signatures == 0 {
            continue;
        }

        let header_size = 2 + num_signatures * 14;
        if data.len() < header_size {
            continue;
        }

        for sig_idx in 0..num_signatures {
            let offset = 2 + sig_idx * 14;
            let sig_offset = u16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            let sig_ix_index = u16::from_le_bytes([data[offset + 2], data[offset + 3]]);
            let pk_offset = u16::from_le_bytes([data[offset + 4], data[offset + 5]]) as usize;
            let pk_ix_index = u16::from_le_bytes([data[offset + 6], data[offset + 7]]);
            let msg_offset = u16::from_le_bytes([data[offset + 8], data[offset + 9]]) as usize;
            let msg_size = u16::from_le_bytes([data[offset + 10], data[offset + 11]]) as usize;
            let msg_ix_index = u16::from_le_bytes([data[offset + 12], data[offset + 13]]);

            let self_ref = u16::MAX;
            if sig_ix_index != self_ref || pk_ix_index != self_ref || msg_ix_index != self_ref {
                continue;
            }

            if pk_offset + 32 > data.len() { continue; }
            let ix_pubkey = &data[pk_offset..pk_offset + 32];
            if ix_pubkey != expected_pubkey.as_ref() { continue; }

            if sig_offset + 64 > data.len() { continue; }
            let ix_signature = &data[sig_offset..sig_offset + 64];
            if ix_signature != expected_signature.as_slice() { continue; }

            if msg_offset + msg_size > data.len() { continue; }
            let ix_message = &data[msg_offset..msg_offset + msg_size];
            if ix_message == expected_message {
                return Ok(true);
            }
        }
    }

    Ok(false)
}
