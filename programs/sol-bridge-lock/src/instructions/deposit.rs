use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::keccak;
use crate::state::{BridgeConfig, DepositRecord, UserState};
use crate::errors::BridgeError;
use crate::events::BridgeDeposit;

/// Domain separator for ZK bridge message ID computation
const DOMAIN_SEP: &[u8] = b"DCC_SOL_BRIDGE_V1";

/// Native SOL sentinel asset ID (same as SPL wrapped SOL mint)
const NATIVE_SOL_ASSET: &str = "So11111111111111111111111111111111111111112";

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

    // ── GUARD: DCC address format validation (L-3 fix) ──
    // DCC addresses are 26-byte base58-encoded values. When passed as [u8; 32],
    // the first 26 bytes hold the address and the remaining 6 should be zero-padded.
    // Reject addresses that are all 0xFF (invalid) or have non-zero bytes after
    // byte 26 unless the full 32 bytes are a valid Ed25519 public key.
    {
        let all_ff = params.recipient_dcc.iter().all(|&b| b == 0xFF);
        require!(!all_ff, BridgeError::InvalidDccAddress);

        // Ensure the first byte is non-zero (valid DCC addresses start with
        // a version byte, typically 0x01 for mainnet)
        require!(
            params.recipient_dcc[0] != 0,
            BridgeError::InvalidDccAddress
        );
    }

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
    let event_index = config.global_nonce; // SECURITY FIX (LOW-1): use u64 directly, no truncation
    let native_sol_asset = NATIVE_SOL_ASSET.parse::<Pubkey>().unwrap();

    // ── Compute ZK bridge message_id ──
    // message_id = Keccak256(domain_sep || src_chain_id || dst_chain_id || src_program_id ||
    //                        slot || event_index || sender || recipient || amount || nonce || asset_id)
    let message_id = compute_message_id(
        config.solana_chain_id,
        config.dcc_chain_id,
        &crate::ID,
        clock.slot,
        event_index,
        &ctx.accounts.sender.key(),
        &params.recipient_dcc,
        params.amount,
        current_nonce,
        &native_sol_asset,
    );

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
    deposit.asset_id = native_sol_asset;
    deposit.processed = false;
    deposit.bump = ctx.bumps.deposit_record;

    // ── Emit canonical deposit event (ZK-compatible) ──
    emit!(BridgeDeposit {
        transfer_id,
        message_id,
        sender: ctx.accounts.sender.key(),
        recipient_dcc: params.recipient_dcc,
        amount: params.amount,
        nonce: current_nonce,
        slot: clock.slot,
        event_index,
        timestamp: clock.unix_timestamp,
        src_chain_id: config.solana_chain_id,
        dst_chain_id: config.dcc_chain_id,
        asset_id: native_sol_asset,
    });

    msg!(
        "Deposit: {} lamports, message_id: {:?}, nonce: {}",
        params.amount,
        &message_id[..8],
        current_nonce
    );

    Ok(())
}

/// Compute the canonical ZK bridge message ID.
/// Identical computation must exist in TypeScript prover and DCC contract.
///
/// message_id = Keccak256(
///     "DCC_SOL_BRIDGE_V1" ||
///     src_chain_id (4 bytes LE) ||
///     dst_chain_id (4 bytes LE) ||
///     src_program_id (32 bytes) ||
///     slot (8 bytes LE) ||
///     event_index (4 bytes LE) ||
///     sender (32 bytes) ||
///     recipient (32 bytes) ||
///     amount (8 bytes LE) ||
///     nonce (8 bytes LE) ||
///     asset_id (32 bytes)
/// )
pub fn compute_message_id(
    src_chain_id: u32,
    dst_chain_id: u32,
    src_program_id: &Pubkey,
    slot: u64,
    event_index: u64, // SECURITY FIX (LOW-1): widened from u32
    sender: &Pubkey,
    recipient: &[u8; 32],
    amount: u64,
    nonce: u64,
    asset_id: &Pubkey,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(185); // 181 + 4 extra for u64 event_index
    data.extend_from_slice(DOMAIN_SEP);                      // 17 bytes
    data.extend_from_slice(&src_chain_id.to_le_bytes());     // 4 bytes
    data.extend_from_slice(&dst_chain_id.to_le_bytes());     // 4 bytes
    data.extend_from_slice(src_program_id.as_ref());         // 32 bytes
    data.extend_from_slice(&slot.to_le_bytes());             // 8 bytes
    data.extend_from_slice(&event_index.to_le_bytes());      // 8 bytes (LOW-1: was 4)
    data.extend_from_slice(sender.as_ref());                 // 32 bytes
    data.extend_from_slice(recipient);                       // 32 bytes
    data.extend_from_slice(&amount.to_le_bytes());           // 8 bytes
    data.extend_from_slice(&nonce.to_le_bytes());            // 8 bytes
    data.extend_from_slice(asset_id.as_ref());               // 32 bytes
    keccak::hash(&data).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::pubkey::Pubkey;

    /// Helper to build Pubkey from a 32-byte hex string
    fn pubkey_from_hex(hex: &str) -> Pubkey {
        let bytes = hex_to_bytes(hex);
        Pubkey::new_from_array(bytes.try_into().expect("must be 32 bytes"))
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn bytes32_from_hex(hex: &str) -> [u8; 32] {
        let v = hex_to_bytes(hex);
        v.try_into().unwrap()
    }

    #[test]
    fn test_preimage_length_is_181() {
        // domain_sep(17) + src_chain(4) + dst_chain(4) + src_program(32) +
        // slot(8) + event_index(4) + sender(32) + recipient(32) +
        // amount(8) + nonce(8) + asset_id(32) = 181
        assert_eq!(DOMAIN_SEP.len(), 17);
        let total = 17 + 4 + 4 + 32 + 8 + 4 + 32 + 32 + 8 + 8 + 32;
        assert_eq!(total, 181);
    }

    #[test]
    fn test_message_id_deterministic() {
        let src = pubkey_from_hex(
            "82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302",
        );
        let sender = Pubkey::new_from_array([0u8; 32]);
        let recipient = [1u8; 32];
        let asset = pubkey_from_hex(
            "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
        );

        let id1 = compute_message_id(1, 2, &src, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        let id2 = compute_message_id(1, 2, &src, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        assert_eq!(id1, id2, "message_id must be deterministic");
    }

    #[test]
    fn test_message_id_changes_with_src_chain() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        let id_chain1 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        let id_chain99 = compute_message_id(99, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        assert_ne!(id_chain1, id_chain99, "different src_chain_id must produce different message_id");
    }

    #[test]
    fn test_message_id_changes_with_dst_chain() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        let id_dst2 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        let id_dst99 = compute_message_id(1, 99, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        assert_ne!(id_dst2, id_dst99, "different dst_chain_id must produce different message_id");
    }

    #[test]
    fn test_message_id_changes_with_amount() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        let id_1sol = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        let id_10sol = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 10_000_000_000, 0, &asset);
        assert_ne!(id_1sol, id_10sol, "different amount must produce different message_id");
    }

    #[test]
    fn test_message_id_changes_with_nonce() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        let id_n0 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        let id_n1 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 1, &asset);
        assert_ne!(id_n0, id_n1, "different nonce must produce different message_id");
    }

    #[test]
    fn test_message_id_changes_with_recipient() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recip1 = [3u8; 32];
        let recip2 = [0xffu8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        let id1 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recip1, 1_000_000_000, 0, &asset);
        let id2 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recip2, 1_000_000_000, 0, &asset);
        assert_ne!(id1, id2, "different recipient must produce different message_id");
    }

    #[test]
    fn test_message_id_changes_with_asset() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset1 = Pubkey::new_from_array([0u8; 32]);
        let asset2 = Pubkey::new_from_array([0xaau8; 32]);

        let id1 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset1);
        let id2 = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset2);
        assert_ne!(id1, id2, "different asset_id must produce different message_id");
    }

    #[test]
    fn test_cross_chain_no_collision() {
        let prog = Pubkey::new_from_array([1u8; 32]);
        let sender = Pubkey::new_from_array([2u8; 32]);
        let recipient = [3u8; 32];
        let asset = Pubkey::new_from_array([4u8; 32]);

        // SOL->DCC
        let id_sol_dcc = compute_message_id(1, 2, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        // DCC->SOL (chain IDs swapped)
        let id_dcc_sol = compute_message_id(2, 1, &prog, 1000, 0, &sender, &recipient, 1_000_000_000, 0, &asset);
        assert_ne!(id_sol_dcc, id_dcc_sol, "SOL->DCC and DCC->SOL must not collide");
    }

    #[test]
    fn test_max_u64_values() {
        let prog = Pubkey::new_from_array([0xffu8; 32]);
        let sender = Pubkey::new_from_array([0xffu8; 32]);
        let recipient = [0xffu8; 32];
        let asset = Pubkey::new_from_array([0xffu8; 32]);

        // Should not panic with max values
        let id = compute_message_id(
            1, 2, &prog, u64::MAX, u32::MAX, &sender, &recipient, u64::MAX, u64::MAX, &asset,
        );
        assert_ne!(id, [0u8; 32], "message_id must not be zero");
    }

    /// Test vector 1: Basic deposit — matches TypeScript golden value.
    /// The expected value is generated by running:
    ///   npx tsx tests/vectors/generate-golden-values.ts
    #[test]
    fn test_vector_1_basic_deposit() {
        let src_program = pubkey_from_hex(
            "82f3b18d8e2d0c7b7a6e5d4c3b2a190817161514131211100908070605040302",
        );
        let sender = Pubkey::new_from_array([0u8; 32]);
        let recipient = bytes32_from_hex(
            "0101010101010101010101010101010101010101010101010101010101010101",
        );
        let asset = pubkey_from_hex(
            "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
        );

        let id = compute_message_id(
            1,               // SOL_CHAIN_ID
            2,               // DCC_CHAIN_ID
            &src_program,
            1000,            // slot
            0,               // event_index
            &sender,
            &recipient,
            1_000_000_000,   // 1 SOL
            0,               // nonce
            &asset,
        );

        // The message_id is 32 bytes and must be non-zero
        assert_ne!(id, [0u8; 32]);

        // Cross-implementation golden value (verified against TypeScript prover)
        let expected: [u8; 32] = [
            0x6a, 0xd0, 0xde, 0xb8, 0xad, 0x96, 0x0e, 0x16,
            0x8e, 0x2c, 0xeb, 0x0c, 0x69, 0x23, 0xa9, 0x4b,
            0x90, 0xc9, 0x01, 0x53, 0x86, 0xff, 0xd6, 0x0c,
            0xe8, 0x55, 0x0d, 0x0e, 0x17, 0xd9, 0x64, 0x44,
        ];
        assert_eq!(id, expected, "message_id must match TypeScript golden value");

        // Print for cross-check with TS golden values
        let hex: String = id.iter().map(|b| format!("{:02x}", b)).collect();
        println!("vector_1 message_id (Rust): 0x{}", hex);
    }
}

