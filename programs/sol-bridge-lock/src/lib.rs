pub mod state;
pub mod errors;
pub mod events;
pub mod instructions;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF");

/// SOL Bridge Lock Program
/// 
/// Security-critical vault program that locks SOL for cross-chain bridging
/// to DecentralChain. Uses PDA-controlled custody with no external key authority.
///
/// INVARIANTS:
/// - No SOL leaves vault without valid burn proof from DCC
/// - Nonces are strictly monotonic per user
/// - Transfer IDs are globally unique (hash of sender + nonce + slot)
/// - Deposits are rate-limited and size-capped
/// - Emergency pause halts all operations
/// - Reentrancy protection via Anchor's CPI guard
#[program]
pub mod sol_bridge_lock {
    use super::*;

    /// Initialize the bridge configuration. 
    /// Can only be called once by the deployer.
    pub fn initialize(
        ctx: Context<Initialize>,
        params: InitializeParams,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Deposit SOL into the bridge vault.
    /// Emits a BridgeDeposit event for validators to observe.
    pub fn deposit(
        ctx: Context<Deposit>,
        params: DepositParams,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, params)
    }

    /// Deposit SPL tokens into the bridge vault.
    /// Transfers tokens from sender's ATA to the bridge vault ATA.
    /// Emits a BridgeDepositSpl event with the SPL mint for DCC routing.
    pub fn deposit_spl(
        ctx: Context<DepositSpl>,
        params: DepositSplParams,
    ) -> Result<()> {
        instructions::deposit_spl::handler(ctx, params)
    }

    /// Unlock SOL from the vault after validators confirm a burn on DCC.
    /// Requires M-of-N validator signatures.
    pub fn unlock(
        ctx: Context<Unlock>,
        params: UnlockParams,
    ) -> Result<()> {
        instructions::unlock::handler(ctx, params)
    }

    /// Execute a scheduled (large) unlock after its timelock delay has elapsed.
    pub fn execute_scheduled_unlock(
        ctx: Context<ExecuteScheduledUnlock>,
        transfer_id: [u8; 32],
    ) -> Result<()> {
        instructions::unlock::execute_scheduled_unlock_handler(ctx, transfer_id)
    }

    /// Emergency pause — halts all deposits and unlocks.
    pub fn emergency_pause(ctx: Context<EmergencyPause>) -> Result<()> {
        instructions::emergency::pause_handler(ctx)
    }

    /// Step 1: Request resume — starts a timelock countdown.
    /// The bridge remains paused until resume() is called after the delay.
    pub fn request_resume(ctx: Context<RequestResume>) -> Result<()> {
        instructions::emergency::request_resume_handler(ctx)
    }

    /// Step 2: Execute resume after the timelock delay has elapsed.
    pub fn emergency_resume(ctx: Context<EmergencyResume>) -> Result<()> {
        instructions::emergency::resume_handler(ctx)
    }

    /// Cancel a pending resume request.
    /// Authority or guardian can cancel — defense-in-depth.
    pub fn cancel_resume_request(ctx: Context<CancelResumeRequest>) -> Result<()> {
        instructions::emergency::cancel_resume_handler(ctx)
    }

    /// Update bridge configuration (rate limits, validator set, etc.)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        params: UpdateConfigParams,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, params)
    }

    /// Register a validator's public key for signature verification.
    pub fn register_validator(
        ctx: Context<RegisterValidator>,
        params: RegisterValidatorParams,
    ) -> Result<()> {
        instructions::register_validator::handler(ctx, params)
    }

    /// Remove a validator from the active set.
    pub fn remove_validator(
        ctx: Context<RemoveValidator>,
        validator_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::remove_validator::handler(ctx, validator_pubkey)
    }
}
