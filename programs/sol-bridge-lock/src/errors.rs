use anchor_lang::prelude::*;

/// Bridge-specific error codes with security context
#[error_code]
pub enum BridgeError {
    /// Bridge is currently paused — no deposits or unlocks allowed
    #[msg("Bridge is paused — emergency halt active")]
    BridgePaused,

    /// Deposit amount is below minimum threshold
    #[msg("Deposit amount below minimum")]
    DepositTooSmall,

    /// Deposit amount exceeds maximum threshold
    #[msg("Deposit amount exceeds maximum")]
    DepositTooLarge,

    /// Nonce mismatch — possible replay attack or out-of-order submission
    #[msg("Invalid nonce — must be monotonically increasing")]
    InvalidNonce,

    /// Transfer ID already exists — replay attack detected
    #[msg("Transfer ID already processed — replay rejected")]
    DuplicateTransfer,

    /// Insufficient validator signatures for unlock
    #[msg("Insufficient validator signatures — need M-of-N")]
    InsufficientSignatures,

    /// Invalid validator signature
    #[msg("Invalid validator signature")]
    InvalidSignature,

    /// Validator not registered or inactive
    #[msg("Validator not in active set")]
    ValidatorNotActive,

    /// Duplicate validator signature in unlock request
    #[msg("Duplicate validator signature detected")]
    DuplicateValidatorSignature,

    /// Daily outflow limit exceeded — circuit breaker triggered
    #[msg("Daily outflow limit exceeded — circuit breaker")]
    DailyOutflowExceeded,

    /// Single unlock amount exceeds maximum
    #[msg("Unlock amount exceeds single-transaction maximum")]
    UnlockAmountExceeded,

    /// Large withdrawal time delay not yet elapsed
    #[msg("Large withdrawal time delay not elapsed")]
    WithdrawalDelayNotElapsed,

    /// Vault has insufficient funds (should never happen if invariants hold)
    #[msg("CRITICAL: Vault balance insufficient — possible invariant violation")]
    InsufficientVaultBalance,

    /// Arithmetic overflow detected
    #[msg("Arithmetic overflow — operation rejected")]
    ArithmeticOverflow,

    /// Unauthorized caller
    #[msg("Unauthorized — caller lacks required authority")]
    Unauthorized,

    /// Invalid DCC recipient address format
    #[msg("Invalid DecentralChain recipient address")]
    InvalidDccAddress,

    /// Maximum validator count reached
    #[msg("Maximum validator count reached")]
    MaxValidatorsReached,

    /// Validator already registered
    #[msg("Validator already registered")]
    ValidatorAlreadyRegistered,

    /// Cannot remove validator — would breach minimum threshold
    #[msg("Cannot remove validator — minimum threshold would be breached")]
    ValidatorRemovalBreachesMinimum,

    /// Invalid chain ID in signature domain
    #[msg("Chain ID mismatch — domain separation failure")]
    ChainIdMismatch,

    /// Transfer has expired
    #[msg("Transfer has expired")]
    TransferExpired,

    /// Unlock record already executed
    #[msg("Unlock already executed — replay rejected")]
    UnlockAlreadyExecuted,

    /// Invalid configuration parameter
    #[msg("Invalid configuration parameter")]
    InvalidConfig,

    /// Transfer ID does not match expected value
    #[msg("Transfer ID mismatch — computed value differs from supplied")]
    InvalidTransferId,
}
