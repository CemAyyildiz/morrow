//! Vault Script, Allowance script, Co-signer key handling and witness templates. Pure: no `env`.

use super::errors::{CoreResult, ErrorCode, Rejection};
use near_sdk::near;

const OP_0: u8 = 0x00;
const OP_1: u8 = 0x51;
const OP_IF: u8 = 0x63;
const OP_ELSE: u8 = 0x67;
const OP_ENDIF: u8 = 0x68;
const OP_DROP: u8 = 0x75;
const OP_CHECKSIG: u8 = 0xac;
const OP_CHECKSIGVERIFY: u8 = 0xad;
const OP_CHECKMULTISIG: u8 = 0xae;
const OP_CHECKSEQUENCEVERIFY: u8 = 0xb2;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(value: &str) -> CoreResult<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return Err(Rejection::with(ErrorCode::BadKey, value));
    }
    (0..value.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&value[i..i + 2], 16)
                .map_err(|_| Rejection::with(ErrorCode::BadKey, value))
        })
        .collect()
}

/// Converts the MPC signer's `derived_public_key` result ("secp256k1:<base58 of x‖y>") into a
/// 33-byte compressed key.
pub fn compress_derived_key(derived: &str) -> CoreResult<[u8; 33]> {
    let bad = || Rejection::with(ErrorCode::BadKey, derived);
    let encoded = derived.strip_prefix("secp256k1:").ok_or_else(bad)?;
    let raw = bs58::decode(encoded).into_vec().map_err(|_| bad())?;
    let point: [u8; 64] = raw.try_into().map_err(|_| bad())?;
    let mut compressed = [0u8; 33];
    compressed[0] = if point[63] & 1 == 0 { 0x02 } else { 0x03 };
    compressed[1..].copy_from_slice(&point[..32]);
    Ok(compressed)
}

fn push_key(script: &mut Vec<u8>, key: &[u8; 33]) {
    script.push(33);
    script.extend_from_slice(key);
}

/// Minimal push of a positive script number (OP_1..OP_16, otherwise minimal CScriptNum bytes).
fn push_number(script: &mut Vec<u8>, value: u32) {
    if (1..=16).contains(&value) {
        script.push(OP_1 + (value as u8 - 1));
        return;
    }
    if value == 0 {
        script.push(OP_0);
        return;
    }
    let mut bytes = Vec::new();
    let mut rest = value;
    while rest > 0 {
        bytes.push((rest & 0xff) as u8);
        rest >>= 8;
    }
    if bytes.last().is_some_and(|b| b & 0x80 != 0) {
        bytes.push(0x00);
    }
    script.push(bytes.len() as u8);
    script.extend_from_slice(&bytes);
}

/// The three-path script shared by the Vault Address and the Allowance Address:
/// Withdrawal (Owner + Co-signer), Clawback (Co-signer + 1-of-n Guardians), Escape (Owner after CSV).
pub fn build_vault_script(
    owner_key: &[u8; 33],
    cosigner_key: &[u8; 33],
    guardian_keys: &[[u8; 33]],
    escape_timelock_blocks: u32,
) -> Vec<u8> {
    let mut s = Vec::with_capacity(300);
    s.push(OP_IF);
    push_key(&mut s, owner_key);
    s.push(OP_CHECKSIGVERIFY);
    push_key(&mut s, cosigner_key);
    s.push(OP_CHECKSIG);
    s.push(OP_ELSE);
    s.push(OP_IF);
    push_key(&mut s, cosigner_key);
    s.push(OP_CHECKSIGVERIFY);
    s.push(OP_1);
    for key in guardian_keys {
        push_key(&mut s, key);
    }
    push_number(&mut s, guardian_keys.len() as u32);
    s.push(OP_CHECKMULTISIG);
    s.push(OP_ELSE);
    push_number(&mut s, escape_timelock_blocks);
    s.push(OP_CHECKSEQUENCEVERIFY);
    s.push(OP_DROP);
    push_key(&mut s, owner_key);
    s.push(OP_CHECKSIG);
    s.push(OP_ENDIF);
    s.push(OP_ENDIF);
    s
}

pub fn parse_key(value: &str) -> CoreResult<[u8; 33]> {
    from_hex(value)?
        .try_into()
        .map_err(|_| Rejection::with(ErrorCode::BadKey, value))
}

#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WitnessSlot {
    Signature { signer: String },
    Selector { hex: String },
    Empty,
    Script,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessTemplate {
    pub path: String,
    pub slots: Vec<WitnessSlot>,
}

fn signature(signer: &str) -> WitnessSlot {
    WitnessSlot::Signature {
        signer: signer.to_string(),
    }
}

fn selector_true() -> WitnessSlot {
    WitnessSlot::Selector {
        hex: "01".to_string(),
    }
}

/// Witness slot order per path, bottom of the stack first. Clients fill slots, never reorder them.
pub fn witness_templates() -> Vec<WitnessTemplate> {
    vec![
        WitnessTemplate {
            path: "withdrawal".into(),
            slots: vec![
                signature("cosigner"),
                signature("owner"),
                selector_true(),
                WitnessSlot::Script,
            ],
        },
        WitnessTemplate {
            path: "clawback".into(),
            slots: vec![
                WitnessSlot::Empty,
                signature("guardian"),
                signature("cosigner"),
                selector_true(),
                WitnessSlot::Empty,
                WitnessSlot::Script,
            ],
        },
        WitnessTemplate {
            path: "escape".into(),
            slots: vec![
                signature("owner"),
                WitnessSlot::Empty,
                WitnessSlot::Empty,
                WitnessSlot::Script,
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::address::p2wsh_address;
    use crate::core::policy::BtcNetwork;

    fn key(prefix: u8, byte: u8) -> [u8; 33] {
        let mut k = [byte; 33];
        k[0] = prefix;
        k
    }

    // Expected bytes and addresses computed independently with bitcoinjs-lib 7.0.5.
    const THREE_GUARDIANS: &str = "6321021111111111111111111111111111111111111111111111111111111111111111ad2103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac67632103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad5121022222222222222222222222222222222222222222222222222222222222222222210233333333333333333333333333333333333333333333333333333333333333332102444444444444444444444444444444444444444444444444444444444444444453ae6702a866b27521021111111111111111111111111111111111111111111111111111111111111111ac6868";
    const ONE_GUARDIAN_REGTEST: &str = "6321021111111111111111111111111111111111111111111111111111111111111111ad2103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac67632103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad512102222222222222222222222222222222222222222222222222222222222222222251ae6756b27521021111111111111111111111111111111111111111111111111111111111111111ac6868";

    #[test]
    fn builds_the_three_guardian_script_byte_for_byte() {
        let script = build_vault_script(
            &key(0x02, 0x11),
            &key(0x03, 0xaa),
            &[key(0x02, 0x22), key(0x02, 0x33), key(0x02, 0x44)],
            26_280,
        );
        assert_eq!(hex(&script), THREE_GUARDIANS);
        assert!(script.len() < 300);
        assert_eq!(
            p2wsh_address(&script, BtcNetwork::Signet),
            "tb1qjzz9rvff0n247nl76zcwwylrjkej02l4pa8l5he6zzyn9kagp3aq2u9zku"
        );
        assert_eq!(
            p2wsh_address(&script, BtcNetwork::Bitcoin),
            "bc1qjzz9rvff0n247nl76zcwwylrjkej02l4pa8l5he6zzyn9kagp3aqa5ndvn"
        );
    }

    #[test]
    fn pushes_small_timelocks_as_op_n() {
        let script = build_vault_script(&key(0x02, 0x11), &key(0x03, 0xaa), &[key(0x02, 0x22)], 6);
        assert_eq!(hex(&script), ONE_GUARDIAN_REGTEST);
        assert_eq!(
            p2wsh_address(&script, BtcNetwork::Regtest),
            "bcrt1q7sx62zjs49gr9eklsszt4smasje2aa3ppkyuqcmd5aqnvuaavgwsxspak7"
        );
    }

    #[test]
    fn encodes_script_numbers_minimally() {
        let encode = |n| {
            let mut s = Vec::new();
            push_number(&mut s, n);
            hex(&s)
        };
        assert_eq!(encode(16), "60");
        assert_eq!(encode(17), "0111");
        assert_eq!(encode(128), "028000");
        assert_eq!(encode(4_320), "02e010");
        assert_eq!(encode(65_535), "03ffff00");
    }

    #[test]
    fn compresses_derived_keys_by_y_parity() {
        let mut point = [0x11u8; 64];
        point[63] = 0x01;
        let odd = format!("secp256k1:{}", bs58::encode(point).into_string());
        let compressed = compress_derived_key(&odd).unwrap();
        assert_eq!(compressed[0], 0x03);
        assert_eq!(compressed[1..], [0x11; 32]);
        point[63] = 0x02;
        let even = format!("secp256k1:{}", bs58::encode(point).into_string());
        assert_eq!(compress_derived_key(&even).unwrap()[0], 0x02);
        // The key returned by v1.signer-prod.testnet during the day-1 spike.
        let live = "secp256k1:5Rn31MPPHMbMb2etDnih1mQ6qFdCdYwZ5ybC2SLex5hr1xkmBYnGdojGZXTbVjuYTXqXj3dTW2xdca1pNeNcRmqY";
        assert_eq!(compress_derived_key(live).unwrap().len(), 33);
    }

    #[test]
    fn rejects_malformed_derived_keys() {
        assert!(compress_derived_key("ed25519:abc").is_err());
        assert!(compress_derived_key("secp256k1:0OIl").is_err());
        assert!(compress_derived_key(&format!(
            "secp256k1:{}",
            bs58::encode([1u8; 33]).into_string()
        ))
        .is_err());
    }

    #[test]
    fn publishes_the_frozen_witness_templates() {
        let json = near_sdk::serde_json::to_value(witness_templates()).unwrap();
        assert_eq!(json[0]["path"], "withdrawal");
        assert_eq!(
            json[0]["slots"][0],
            near_sdk::serde_json::json!({ "kind": "signature", "signer": "cosigner" })
        );
        assert_eq!(
            json[1]["slots"][0],
            near_sdk::serde_json::json!({ "kind": "empty" })
        );
        assert_eq!(
            json[1]["slots"][3],
            near_sdk::serde_json::json!({ "kind": "selector", "hex": "01" })
        );
        assert_eq!(json[2]["slots"].as_array().unwrap().len(), 4);
    }
}
