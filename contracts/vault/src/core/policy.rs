//! Policy types and validation. Mirrors `@morrow/core-ts` `policy.ts` exactly. Pure: no `env`.

use super::address::script_pubkey;
use super::errors::{CoreResult, ErrorCode, Rejection};
use near_sdk::json_types::U64;
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

pub const MINUTE_NS: u64 = 60_000_000_000;
pub const HOUR_NS: u64 = 60 * MINUTE_NS;
pub const DAY_NS: u64 = 24 * HOUR_NS;
pub const CSV_MAX_BLOCKS: u32 = 65_535;
pub const MAX_GUARDIANS: usize = 3;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BtcNetwork {
    Regtest,
    Signet,
    Testnet4,
    Bitcoin,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardianKind {
    TrustedContact,
    BackupDevice,
    AutoClawback,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guardian {
    /// 33-byte compressed secp256k1 key, lowercase hex.
    pub guardian_key: String,
    pub guardian_account: AccountId,
    pub kind: GuardianKind,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub delay_ns: U64,
    pub policy_change_delay_ns: U64,
    pub escape_timelock_blocks: u32,
    pub recovery_address: String,
    pub allowance_limit_sats: U64,
    pub fee_cap_sats: U64,
    pub fast_approval: bool,
    pub fast_approval_floor_ns: U64,
    pub guardians: Vec<Guardian>,
    pub btc_network: BtcNetwork,
    /// 32-byte X25519 key, lowercase hex.
    pub watcher_x25519_pk: String,
}

/// Inclusive bounds for one network.
pub struct Bounds {
    pub delay_ns: (u64, u64),
    pub policy_change_delay_ns: (u64, u64),
    pub policy_change_delay_floor_ns: u64,
    pub escape_timelock_blocks: (u32, u32),
    pub fee_cap_sats: (u64, u64),
    pub fast_approval_floor_min_ns: u64,
}

const STANDARD_BOUNDS: Bounds = Bounds {
    delay_ns: (HOUR_NS, 30 * DAY_NS),
    policy_change_delay_ns: (7 * DAY_NS, 90 * DAY_NS),
    policy_change_delay_floor_ns: 7 * DAY_NS,
    escape_timelock_blocks: (4_320, CSV_MAX_BLOCKS),
    fee_cap_sats: (10_000, 1_000_000),
    fast_approval_floor_min_ns: 10 * MINUTE_NS,
};

/// Judge Mode: lower bounds drop on regtest only.
const REGTEST_BOUNDS: Bounds = Bounds {
    delay_ns: (MINUTE_NS, 30 * DAY_NS),
    policy_change_delay_ns: (MINUTE_NS, 90 * DAY_NS),
    policy_change_delay_floor_ns: MINUTE_NS,
    escape_timelock_blocks: (6, CSV_MAX_BLOCKS),
    fee_cap_sats: (10_000, 1_000_000),
    fast_approval_floor_min_ns: MINUTE_NS,
};

pub const fn bounds_for(network: BtcNetwork) -> &'static Bounds {
    match network {
        BtcNetwork::Regtest => &REGTEST_BOUNDS,
        _ => &STANDARD_BOUNDS,
    }
}

fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 33-byte compressed secp256k1 public key in lowercase hex.
pub fn is_compressed_key(value: &str) -> bool {
    is_lower_hex(value, 33) && (value.starts_with("02") || value.starts_with("03"))
}

fn within<T: PartialOrd>(value: T, (min, max): (T, T)) -> bool {
    value >= min && value <= max
}

fn bounds_error(field: &str) -> Rejection {
    Rejection::with(ErrorCode::PolicyBounds, field)
}

fn validate_guardians(guardians: &[Guardian]) -> CoreResult<()> {
    if guardians.is_empty() || guardians.len() > MAX_GUARDIANS {
        return Err(Rejection::new(ErrorCode::GuardianCount));
    }
    for guardian in guardians {
        if !is_compressed_key(&guardian.guardian_key) {
            return Err(Rejection::with(
                ErrorCode::BadKey,
                guardian.guardian_key.clone(),
            ));
        }
    }
    for (i, a) in guardians.iter().enumerate() {
        for b in &guardians[i + 1..] {
            if a.guardian_key == b.guardian_key || a.guardian_account == b.guardian_account {
                return Err(Rejection::new(ErrorCode::DuplicateGuardian));
            }
        }
    }
    Ok(())
}

/// Rules shared by creation and Policy Changes (time, fee and Recovery Address fields).
pub fn validate_adjustable(policy: &Policy) -> CoreResult<()> {
    let bounds = bounds_for(policy.btc_network);
    let delay = policy.delay_ns.0;
    let change_delay = policy.policy_change_delay_ns.0;
    let floor = policy.fast_approval_floor_ns.0;

    if !within(delay, bounds.delay_ns) {
        return Err(bounds_error("delay_ns"));
    }
    if !within(change_delay, bounds.policy_change_delay_ns) {
        return Err(bounds_error("policy_change_delay_ns"));
    }
    if change_delay < delay || change_delay < bounds.policy_change_delay_floor_ns {
        return Err(Rejection::new(ErrorCode::PolicyChangeDelay));
    }
    if !within(policy.fee_cap_sats.0, bounds.fee_cap_sats) {
        return Err(bounds_error("fee_cap_sats"));
    }
    if floor < bounds.fast_approval_floor_min_ns || floor > delay {
        return Err(bounds_error("fast_approval_floor_ns"));
    }
    script_pubkey(&policy.recovery_address, policy.btc_network)?;
    Ok(())
}

/// Full validation at `create_vault`.
pub fn validate_policy(policy: &Policy, allowed_networks: &[BtcNetwork]) -> CoreResult<()> {
    if !allowed_networks.contains(&policy.btc_network) {
        return Err(Rejection::new(ErrorCode::NetworkNotAllowed));
    }
    if !within(
        policy.escape_timelock_blocks,
        bounds_for(policy.btc_network).escape_timelock_blocks,
    ) {
        return Err(bounds_error("escape_timelock_blocks"));
    }
    if !is_lower_hex(&policy.watcher_x25519_pk, 32) {
        return Err(Rejection::with(ErrorCode::BadKey, "watcher_x25519_pk"));
    }
    validate_guardians(&policy.guardians)?;
    validate_adjustable(policy)
}

/// Policy fields a Policy Change may touch. Every other field is Script-bound.
pub const CHANGEABLE_FIELDS: [&str; 7] = [
    "delay_ns",
    "recovery_address",
    "allowance_limit_sats",
    "fee_cap_sats",
    "policy_change_delay_ns",
    "fast_approval",
    "fast_approval_floor_ns",
];

/// The fields one Policy Change sets; absent fields keep their current value.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolicyChangeFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ns: Option<U64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowance_limit_sats: Option<U64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_cap_sats: Option<U64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_change_delay_ns: Option<U64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_approval: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_approval_floor_ns: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyChangeState {
    Pending,
    Applied,
    Vetoed,
    Withdrawn,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyChange {
    pub change_id: U64,
    pub vault_id: U64,
    pub changes: PolicyChangeFields,
    pub proposed_at: U64,
    pub effective_at: U64,
    pub state: PolicyChangeState,
    pub vetoed_by: Option<AccountId>,
}

/// A u64 sent as a canonical decimal string ("0" or no leading zero), as the clients send it.
fn parse_u64(value: &Value, field: &str) -> CoreResult<U64> {
    let text = value.as_str().unwrap_or_default();
    let canonical = text == "0"
        || (text.bytes().all(|b| b.is_ascii_digit()) && !text.is_empty() && !text.starts_with('0'));
    canonical
        .then(|| text.parse().ok())
        .flatten()
        .map(U64)
        .ok_or_else(|| {
            Rejection::with(
                ErrorCode::PolicyBounds,
                format!("{field} is not a u64 decimal string"),
            )
        })
}

/// Reads a proposed change from raw JSON. Keys are checked against the whitelist before any
/// value is parsed, so a Script-bound field is always `ERR_SCRIPT_BOUND`, never dropped.
pub fn parse_change(changes: &Value) -> CoreResult<PolicyChangeFields> {
    let Some(map) = changes.as_object() else {
        return Err(bounds_error("changes is not an object"));
    };
    if let Some(key) = map
        .keys()
        .find(|k| !CHANGEABLE_FIELDS.contains(&k.as_str()))
    {
        return Err(Rejection::with(ErrorCode::ScriptBound, key.clone()));
    }
    if map.is_empty() {
        return Err(bounds_error("empty change"));
    }
    let number = |field: &str| map.get(field).map(|v| parse_u64(v, field)).transpose();
    let recovery_address = map
        .get("recovery_address")
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| bounds_error("recovery_address"))
        })
        .transpose()?;
    let fast_approval = map
        .get("fast_approval")
        .map(|v| v.as_bool().ok_or_else(|| bounds_error("fast_approval")))
        .transpose()?;
    Ok(PolicyChangeFields {
        delay_ns: number("delay_ns")?,
        recovery_address,
        allowance_limit_sats: number("allowance_limit_sats")?,
        fee_cap_sats: number("fee_cap_sats")?,
        policy_change_delay_ns: number("policy_change_delay_ns")?,
        fast_approval,
        fast_approval_floor_ns: number("fast_approval_floor_ns")?,
    })
}

impl PolicyChangeFields {
    /// The Policy this change would produce, held to the same bounds as at creation.
    pub fn apply_to(&self, current: &Policy) -> CoreResult<Policy> {
        let next = Policy {
            delay_ns: self.delay_ns.unwrap_or(current.delay_ns),
            recovery_address: self
                .recovery_address
                .clone()
                .unwrap_or_else(|| current.recovery_address.clone()),
            allowance_limit_sats: self
                .allowance_limit_sats
                .unwrap_or(current.allowance_limit_sats),
            fee_cap_sats: self.fee_cap_sats.unwrap_or(current.fee_cap_sats),
            policy_change_delay_ns: self
                .policy_change_delay_ns
                .unwrap_or(current.policy_change_delay_ns),
            fast_approval: self.fast_approval.unwrap_or(current.fast_approval),
            fast_approval_floor_ns: self
                .fast_approval_floor_ns
                .unwrap_or(current.fast_approval_floor_ns),
            ..current.clone()
        };
        validate_adjustable(&next)?;
        Ok(next)
    }
}

/// Validates a raw proposed change against the current Policy and returns the Policy it yields.
pub fn apply_change(current: &Policy, changes: &Value) -> CoreResult<Policy> {
    parse_change(changes)?.apply_to(current)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const RECOVERY_SIGNET: &str =
        "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
    pub const TESTNETS: [BtcNetwork; 3] = [
        BtcNetwork::Regtest,
        BtcNetwork::Signet,
        BtcNetwork::Testnet4,
    ];

    pub fn guardian(byte: &str, account: &str, kind: GuardianKind) -> Guardian {
        Guardian {
            guardian_key: format!("02{}", byte.repeat(32)),
            guardian_account: account.parse().unwrap(),
            kind,
        }
    }

    /// The Standard preset on signet with two Guardians.
    pub fn standard_policy() -> Policy {
        Policy {
            delay_ns: U64(24 * HOUR_NS),
            policy_change_delay_ns: U64(7 * DAY_NS),
            escape_timelock_blocks: 26_280,
            recovery_address: RECOVERY_SIGNET.to_string(),
            allowance_limit_sats: U64(100_000),
            fee_cap_sats: U64(100_000),
            fast_approval: false,
            fast_approval_floor_ns: U64(10 * MINUTE_NS),
            guardians: vec![
                guardian("22", "emma.testnet", GuardianKind::TrustedContact),
                guardian("33", "backup.testnet", GuardianKind::BackupDevice),
            ],
            btc_network: BtcNetwork::Signet,
            watcher_x25519_pk: "44".repeat(32),
        }
    }

    fn code(policy: &Policy) -> Option<ErrorCode> {
        validate_policy(policy, &TESTNETS).err().map(|r| r.code)
    }

    #[test]
    fn accepts_presets() {
        assert_eq!(code(&standard_policy()), None);
        let fortress = Policy {
            delay_ns: U64(7 * DAY_NS),
            policy_change_delay_ns: U64(30 * DAY_NS),
            escape_timelock_blocks: 52_560,
            ..standard_policy()
        };
        assert_eq!(code(&fortress), None);
    }

    #[test]
    fn enforces_time_bounds() {
        let short = Policy {
            delay_ns: U64(30 * MINUTE_NS),
            ..standard_policy()
        };
        assert_eq!(code(&short), Some(ErrorCode::PolicyBounds));
        let floor = Policy {
            policy_change_delay_ns: U64(6 * DAY_NS),
            ..standard_policy()
        };
        assert_eq!(code(&floor), Some(ErrorCode::PolicyBounds));
        let below_delay = Policy {
            delay_ns: U64(10 * DAY_NS),
            policy_change_delay_ns: U64(8 * DAY_NS),
            ..standard_policy()
        };
        assert_eq!(code(&below_delay), Some(ErrorCode::PolicyChangeDelay));
        let escape = Policy {
            escape_timelock_blocks: 4_000,
            ..standard_policy()
        };
        assert_eq!(code(&escape), Some(ErrorCode::PolicyBounds));
        let csv = Policy {
            escape_timelock_blocks: 65_536,
            ..standard_policy()
        };
        assert_eq!(code(&csv), Some(ErrorCode::PolicyBounds));
    }

    #[test]
    fn lowers_bounds_on_regtest_only() {
        let fast = Policy {
            delay_ns: U64(MINUTE_NS),
            policy_change_delay_ns: U64(MINUTE_NS),
            fast_approval_floor_ns: U64(MINUTE_NS),
            escape_timelock_blocks: 6,
            ..standard_policy()
        };
        assert_eq!(code(&fast), Some(ErrorCode::PolicyBounds));
        let regtest = Policy {
            btc_network: BtcNetwork::Regtest,
            recovery_address: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080".to_string(),
            ..fast
        };
        assert_eq!(code(&regtest), None);
    }

    #[test]
    fn enforces_fee_cap_and_floor() {
        let fee = Policy {
            fee_cap_sats: U64(9_999),
            ..standard_policy()
        };
        assert_eq!(code(&fee), Some(ErrorCode::PolicyBounds));
        let floor = Policy {
            fast_approval_floor_ns: U64(25 * HOUR_NS),
            ..standard_policy()
        };
        assert_eq!(code(&floor), Some(ErrorCode::PolicyBounds));
    }

    #[test]
    fn enforces_guardian_rules() {
        let none = Policy {
            guardians: vec![],
            ..standard_policy()
        };
        assert_eq!(code(&none), Some(ErrorCode::GuardianCount));
        let four = Policy {
            guardians: vec![
                guardian("22", "a.testnet", GuardianKind::BackupDevice),
                guardian("33", "b.testnet", GuardianKind::BackupDevice),
                guardian("44", "c.testnet", GuardianKind::BackupDevice),
                guardian("55", "d.testnet", GuardianKind::BackupDevice),
            ],
            ..standard_policy()
        };
        assert_eq!(code(&four), Some(ErrorCode::GuardianCount));
        let same_account = Policy {
            guardians: vec![
                guardian("22", "a.testnet", GuardianKind::BackupDevice),
                guardian("33", "a.testnet", GuardianKind::TrustedContact),
            ],
            ..standard_policy()
        };
        assert_eq!(code(&same_account), Some(ErrorCode::DuplicateGuardian));
        let bad_key = Policy {
            guardians: vec![Guardian {
                guardian_key: "04".repeat(33),
                ..guardian("22", "a.testnet", GuardianKind::BackupDevice)
            }],
            ..standard_policy()
        };
        assert_eq!(code(&bad_key), Some(ErrorCode::BadKey));
    }

    #[test]
    fn enforces_network_and_address() {
        let mainnet = Policy {
            btc_network: BtcNetwork::Bitcoin,
            recovery_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".to_string(),
            ..standard_policy()
        };
        assert_eq!(code(&mainnet), Some(ErrorCode::NetworkNotAllowed));
        assert!(validate_policy(&mainnet, &[BtcNetwork::Bitcoin]).is_ok());
        let wrong_hrp = Policy {
            recovery_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".to_string(),
            ..standard_policy()
        };
        assert_eq!(code(&wrong_hrp), Some(ErrorCode::BadAddress));
        let bad_watcher = Policy {
            watcher_x25519_pk: "zz".repeat(32),
            ..standard_policy()
        };
        assert_eq!(code(&bad_watcher), Some(ErrorCode::BadKey));
    }

    mod changes {
        use super::*;
        use near_sdk::serde_json::json;

        const NEW_RECOVERY: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

        fn change_code(changes: Value) -> Option<ErrorCode> {
            apply_change(&standard_policy(), &changes)
                .err()
                .map(|r| r.code)
        }

        #[test]
        fn merges_only_the_fields_sent() {
            let next = apply_change(
                &standard_policy(),
                &json!({ "recovery_address": NEW_RECOVERY, "fee_cap_sats": "20000" }),
            )
            .unwrap();
            assert_eq!(
                next,
                Policy {
                    recovery_address: NEW_RECOVERY.to_string(),
                    fee_cap_sats: U64(20_000),
                    ..standard_policy()
                }
            );
        }

        #[test]
        fn rejects_script_bound_fields_before_parsing() {
            for changes in [
                json!({ "escape_timelock_blocks": 1 }),
                json!({ "guardians": [] }),
                json!({ "btc_network": "signet" }),
                json!({ "watcher_x25519_pk": "00" }),
                json!({ "delay_ns": "not a number", "owner_key": "02" }),
            ] {
                assert_eq!(change_code(changes), Some(ErrorCode::ScriptBound));
            }
        }

        #[test]
        fn rejects_empty_and_malformed_changes() {
            for changes in [
                json!({}),
                json!([]),
                json!(null),
                json!({ "delay_ns": 3_600_000_000_000u64 }),
                json!({ "delay_ns": "036000000000000" }),
                json!({ "delay_ns": "+1" }),
                json!({ "fee_cap_sats": "18446744073709551616" }),
                json!({ "fast_approval": "true" }),
                json!({ "recovery_address": 5 }),
            ] {
                assert_eq!(change_code(changes), Some(ErrorCode::PolicyBounds));
            }
        }

        #[test]
        fn holds_the_result_to_creation_bounds() {
            assert_eq!(
                change_code(json!({ "delay_ns": "1" })),
                Some(ErrorCode::PolicyBounds)
            );
            assert_eq!(
                change_code(json!({ "policy_change_delay_ns": (6 * DAY_NS).to_string() })),
                Some(ErrorCode::PolicyBounds)
            );
            assert_eq!(
                change_code(json!({ "delay_ns": (8 * DAY_NS).to_string() })),
                Some(ErrorCode::PolicyChangeDelay)
            );
            assert_eq!(
                change_code(
                    json!({ "recovery_address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" })
                ),
                Some(ErrorCode::BadAddress)
            );
            assert_eq!(
                change_code(json!({ "fast_approval": true, "fast_approval_floor_ns": "0" })),
                Some(ErrorCode::PolicyBounds)
            );
        }

        #[test]
        fn echoes_the_fields_as_sent() {
            let sent = json!({ "allowance_limit_sats": "0", "fast_approval": true });
            let fields = parse_change(&sent).unwrap();
            assert_eq!(near_sdk::serde_json::to_value(&fields).unwrap(), sent);
        }

        #[test]
        fn every_changeable_field_round_trips_and_takes_effect() {
            let before = near_sdk::serde_json::to_value(standard_policy()).unwrap();
            for field in CHANGEABLE_FIELDS {
                let value = match field {
                    "delay_ns" => json!((2 * DAY_NS).to_string()),
                    "recovery_address" => json!(NEW_RECOVERY),
                    "allowance_limit_sats" => json!("5"),
                    "fee_cap_sats" => json!("20000"),
                    "policy_change_delay_ns" => json!((8 * DAY_NS).to_string()),
                    "fast_approval" => json!(true),
                    "fast_approval_floor_ns" => json!((20 * MINUTE_NS).to_string()),
                    other => panic!("no test value for {other}"),
                };
                let sent = json!({ field: value.clone() });
                let fields = parse_change(&sent).unwrap();
                assert_eq!(
                    near_sdk::serde_json::to_value(&fields).unwrap(),
                    sent,
                    "{field}"
                );
                let next = fields.apply_to(&standard_policy()).unwrap();
                let after = near_sdk::serde_json::to_value(next).unwrap();
                assert_ne!(before[field], value, "{field}");
                assert_eq!(after[field], value, "{field}");
            }
        }
    }
}
