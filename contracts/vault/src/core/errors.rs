//! Error codes shared with `@morrow/core-ts` (`ERROR_CODES`). Append-only.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Unauthorized,
    VaultNotFound,
    VaultNotActive,
    PolicyBounds,
    PolicyChangeDelay,
    GuardianCount,
    DuplicateGuardian,
    NetworkNotAllowed,
    BadAddress,
    BadKey,
    DepositTooLow,
    CreatorNotAllowed,
    OpNotFound,
    BadOpState,
    BadEnvelope,
    NotExecutable,
    OutpointReserved,
    TooManyInputs,
    NoInputs,
    InsufficientFunds,
    ClawedBack,
    StorageBudget,
    FeeTooHigh,
    InputIndex,
    SignerFailed,
    RefreshTooSoon,
    ScriptBound,
    ChangePending,
    ChangeNotFound,
    ChangeNotEffective,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "ERR_UNAUTHORIZED",
            Self::VaultNotFound => "ERR_VAULT_NOT_FOUND",
            Self::VaultNotActive => "ERR_VAULT_NOT_ACTIVE",
            Self::PolicyBounds => "ERR_POLICY_BOUNDS",
            Self::PolicyChangeDelay => "ERR_POLICY_CHANGE_DELAY",
            Self::GuardianCount => "ERR_GUARDIAN_COUNT",
            Self::DuplicateGuardian => "ERR_DUPLICATE_GUARDIAN",
            Self::NetworkNotAllowed => "ERR_NETWORK_NOT_ALLOWED",
            Self::BadAddress => "ERR_BAD_ADDRESS",
            Self::BadKey => "ERR_BAD_KEY",
            Self::DepositTooLow => "ERR_DEPOSIT_TOO_LOW",
            Self::CreatorNotAllowed => "ERR_CREATOR_NOT_ALLOWED",
            Self::OpNotFound => "ERR_OP_NOT_FOUND",
            Self::BadOpState => "ERR_BAD_OP_STATE",
            Self::BadEnvelope => "ERR_BAD_ENVELOPE",
            Self::NotExecutable => "ERR_NOT_EXECUTABLE",
            Self::OutpointReserved => "ERR_OUTPOINT_RESERVED",
            Self::TooManyInputs => "ERR_TOO_MANY_INPUTS",
            Self::NoInputs => "ERR_NO_INPUTS",
            Self::InsufficientFunds => "ERR_INSUFFICIENT_FUNDS",
            Self::ClawedBack => "ERR_CLAWED_BACK",
            Self::StorageBudget => "ERR_STORAGE_BUDGET",
            Self::FeeTooHigh => "ERR_FEE_TOO_HIGH",
            Self::InputIndex => "ERR_INPUT_INDEX",
            Self::SignerFailed => "ERR_SIGNER_FAILED",
            Self::RefreshTooSoon => "ERR_REFRESH_TOO_SOON",
            Self::ScriptBound => "ERR_SCRIPT_BOUND",
            Self::ChangePending => "ERR_CHANGE_PENDING",
            Self::ChangeNotFound => "ERR_CHANGE_NOT_FOUND",
            Self::ChangeNotEffective => "ERR_CHANGE_NOT_EFFECTIVE",
        }
    }
}

/// A rejected call: the code plus an optional detail for the panic message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl Rejection {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }

    /// Panic text the clients parse: `ERR_CODE` or `ERR_CODE: detail`.
    pub fn message(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{}: {}", self.code.as_str(), detail),
            None => self.code.as_str().to_string(),
        }
    }
}

pub type CoreResult<T> = Result<T, Rejection>;
