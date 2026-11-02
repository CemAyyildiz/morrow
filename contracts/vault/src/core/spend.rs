//! Spend Ops: types and the input checks every spend shares. Pure: no `env`.

use super::errors::{CoreResult, ErrorCode, Rejection};
use super::script::WitnessTemplate;
use near_sdk::json_types::U64;
use near_sdk::near;

pub const MAX_INPUTS_PER_OP: usize = 5;
pub const ENVELOPE_HEX_LENGTH: usize = 160;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outpoint {
    /// Display (RPC) byte order, lowercase hex.
    pub txid: String,
    pub vout: u32,
    pub value_sats: U64,
}

impl Outpoint {
    pub fn key(&self) -> String {
        format!("{}:{}", self.txid, self.vout)
    }
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpendOpKind {
    Withdrawal,
    Allowance,
    Refresh,
    Clawback,
}

/// Which address a spend's coins come from; decides the witness script and the signing path.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpendSource {
    #[default]
    Vault,
    Allowance,
}

impl SpendSource {
    pub const fn role(self) -> &'static str {
        match self {
            Self::Vault => "vault",
            Self::Allowance => "allowance",
        }
    }
}

/// Stored states. `executable` is derived from `executable_at` and never stored.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpendOpState {
    Pending,
    Frozen,
    Signed,
    Cancelled,
    Voided,
}

impl SpendOpState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Signed | Self::Cancelled | Self::Voided)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendOp {
    pub op_id: U64,
    pub vault_id: U64,
    pub kind: SpendOpKind,
    pub source: SpendSource,
    pub state: SpendOpState,
    pub amount_sats: U64,
    pub destination: String,
    pub fee_rate_sat_vb: u32,
    pub utxos: Vec<Outpoint>,
    pub created_at: U64,
    pub executable_at: Option<U64>,
    pub unsigned_tx_hex: Option<String>,
    pub sighashes: Vec<String>,
    pub signatures: Vec<Option<String>>,
    pub witness_template: Option<WitnessTemplate>,
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A Watcher Envelope is exactly 80 bytes (160 lowercase hex chars).
pub fn check_envelope(envelope: Option<&str>) -> CoreResult<()> {
    match envelope {
        Some(e) if e.len() == ENVELOPE_HEX_LENGTH && is_lower_hex(e) => Ok(()),
        _ => Err(Rejection::new(ErrorCode::BadEnvelope)),
    }
}

/// 1–5 distinct, well-formed outpoints. Returns their total value.
pub fn check_inputs(utxos: &[Outpoint]) -> CoreResult<u64> {
    if utxos.is_empty() {
        return Err(Rejection::new(ErrorCode::NoInputs));
    }
    if utxos.len() > MAX_INPUTS_PER_OP {
        return Err(Rejection::new(ErrorCode::TooManyInputs));
    }
    let mut total: u64 = 0;
    for (i, utxo) in utxos.iter().enumerate() {
        if utxo.txid.len() != 64 || !is_lower_hex(&utxo.txid) {
            return Err(Rejection::with(
                ErrorCode::BadOpState,
                "txid must be 32 bytes of lowercase hex",
            ));
        }
        if utxos[..i].iter().any(|other| other.key() == utxo.key()) {
            return Err(Rejection::with(
                ErrorCode::OutpointReserved,
                "duplicate outpoint",
            ));
        }
        total = total
            .checked_add(utxo.value_sats.0)
            .ok_or_else(|| Rejection::new(ErrorCode::InsufficientFunds))?;
    }
    Ok(total)
}

/// The requested amount must be positive and covered by the inputs.
pub fn check_amount(amount_sats: u64, input_total: u64) -> CoreResult<()> {
    if amount_sats == 0 || amount_sats > input_total {
        return Err(Rejection::new(ErrorCode::InsufficientFunds));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn utxo(n: u8, value: u64) -> Outpoint {
        Outpoint {
            txid: format!("{n:02x}").repeat(32),
            vout: 0,
            value_sats: U64(value),
        }
    }

    #[test]
    fn checks_envelopes() {
        assert!(check_envelope(Some(&"ab".repeat(80))).is_ok());
        for bad in [
            "a".repeat(159),
            "a".repeat(161),
            "AB".repeat(80),
            "zz".repeat(80),
        ] {
            assert_eq!(
                check_envelope(Some(&bad)).unwrap_err().code,
                ErrorCode::BadEnvelope
            );
        }
        assert_eq!(
            check_envelope(None).unwrap_err().code,
            ErrorCode::BadEnvelope
        );
    }

    #[test]
    fn checks_inputs() {
        assert_eq!(check_inputs(&[utxo(1, 10), utxo(2, 20)]), Ok(30));
        assert_eq!(check_inputs(&[]).unwrap_err().code, ErrorCode::NoInputs);
        let six: Vec<_> = (1..=6).map(|n| utxo(n, 1)).collect();
        assert_eq!(
            check_inputs(&six).unwrap_err().code,
            ErrorCode::TooManyInputs
        );
        assert_eq!(
            check_inputs(&[utxo(1, 1), utxo(1, 1)]).unwrap_err().code,
            ErrorCode::OutpointReserved
        );
        let bad = Outpoint {
            txid: "xyz".into(),
            ..utxo(1, 1)
        };
        assert!(check_inputs(&[bad]).is_err());
    }

    #[test]
    fn checks_amounts() {
        assert!(check_amount(10, 10).is_ok());
        assert_eq!(
            check_amount(0, 10).unwrap_err().code,
            ErrorCode::InsufficientFunds
        );
        assert_eq!(
            check_amount(11, 10).unwrap_err().code,
            ErrorCode::InsufficientFunds
        );
    }
}
