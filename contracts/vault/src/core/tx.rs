//! Bitcoin transactions the contract builds itself, their fees and their BIP143 sighashes.
//! Pure: no `env`.

use super::address::p2wsh_script_pubkey;
use super::errors::{CoreResult, ErrorCode, Rejection};
use super::spend::Outpoint;
use omni_transaction::bitcoin::types::{
    Amount, EcdsaSighashType, Hash, LockTime, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Txid,
    Version, Witness,
};
use omni_transaction::bitcoin::BitcoinTransaction;
use omni_transaction::{TransactionBuilder, TxBuilder, BITCOIN};
use sha2::{Digest, Sha256};

/// Outputs below this are non-standard; smaller change is added to the fee instead.
pub const DUST_LIMIT_SATS: u64 = 546;
/// Opts in to replace-by-fee (BIP125) so a Clawback can replace a pending withdrawal.
pub const RBF_SEQUENCE: u32 = 0xffff_fffd;
/// A DER signature with its sighash byte is at most 73 bytes.
const MAX_SIGNATURE_BYTES: u64 = 73;

/// A built, unsigned transaction and what each input must sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltTx {
    pub unsigned: Vec<u8>,
    pub sighashes: Vec<[u8; 32]>,
    pub fee_sats: u64,
    pub change_sats: u64,
}

fn varint_len(n: u64) -> u64 {
    match n {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

/// Witness bytes of one Withdrawal Path input: item count, two signatures, the 0x01 selector and
/// the script.
pub fn withdrawal_witness_size(script_len: usize) -> u64 {
    let script_len = script_len as u64;
    1 + 2 * (1 + MAX_SIGNATURE_BYTES) + (1 + 1) + varint_len(script_len) + script_len
}

/// Witness bytes of one Clawback Path input: item count, the CHECKMULTISIG dummy, the Guardian
/// and Co-signer signatures, the 0x01 selector, the empty outer selector and the script.
pub fn clawback_witness_size(script_len: usize) -> u64 {
    let script_len = script_len as u64;
    1 + 1 + 2 * (1 + MAX_SIGNATURE_BYTES) + (1 + 1) + 1 + varint_len(script_len) + script_len
}

/// Virtual size from the unsigned (non-witness) serialization plus per-input witness bytes.
pub fn vsize(unsigned_len: usize, inputs: usize, witness_per_input: u64) -> u64 {
    let weight = unsigned_len as u64 * 4 + 2 + inputs as u64 * witness_per_input;
    weight.div_ceil(4)
}

fn sha256d(data: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(data)).into()
}

/// omni-transaction's `Hash` holds a txid in display (RPC) order and reverses it when encoding,
/// so display-order txids are passed through unchanged.
fn txid(display_hex: &str) -> CoreResult<Txid> {
    let bad = || {
        Rejection::with(
            ErrorCode::BadOpState,
            "txid must be 32 bytes of lowercase hex",
        )
    };
    let bytes = super::script::from_hex(display_hex).map_err(|_| bad())?;
    let array: [u8; 32] = bytes.try_into().map_err(|_| bad())?;
    Ok(Txid(Hash(array)))
}

fn build(inputs: &[Outpoint], outputs: &[(Vec<u8>, u64)]) -> CoreResult<BitcoinTransaction> {
    let txins = inputs
        .iter()
        .map(|utxo| {
            Ok(TxIn {
                previous_output: OutPoint::new(txid(&utxo.txid)?, utxo.vout),
                script_sig: ScriptBuf::default(),
                sequence: Sequence(RBF_SEQUENCE),
                witness: Witness::default(),
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let txouts = outputs
        .iter()
        .map(|(script_pubkey, value)| TxOut {
            value: Amount::from_sat(*value),
            script_pubkey: ScriptBuf(script_pubkey.clone()),
        })
        .collect();
    Ok(TransactionBuilder::new::<BITCOIN>()
        .version(Version::Two)
        .inputs(txins)
        .outputs(txouts)
        .lock_time(LockTime::from_height(0).expect("0 is a valid height"))
        .build())
}

/// BIP143 sighash of every input, signing with `witness_script` as the script code.
pub fn sighashes(
    tx: &BitcoinTransaction,
    inputs: &[Outpoint],
    witness_script: &[u8],
) -> Vec<[u8; 32]> {
    let script_code = ScriptBuf(witness_script.to_vec());
    inputs
        .iter()
        .enumerate()
        .map(|(i, utxo)| {
            sha256d(&tx.build_for_signing_segwit(
                EcdsaSighashType::All,
                i,
                &script_code,
                utxo.value_sats.0,
            ))
        })
        .collect()
}

/// Inputs to a withdrawal-shaped spend: pay `amount` to `destination`, change back to `change_to`.
pub struct PaymentPlan<'a> {
    pub inputs: &'a [Outpoint],
    pub amount_sats: u64,
    pub destination: &'a [u8],
    pub change_to: &'a [u8],
    pub fee_rate_sat_vb: u32,
    /// The highest fee the Policy allows for this payment.
    pub fee_cap_sats: u64,
    pub witness_script: &'a [u8],
}

/// Builds a payment once: computes the fee from the contract's own vsize, folds dust change into
/// the fee, enforces the cap, and returns the unsigned transaction with its sighashes.
pub fn build_payment(plan: &PaymentPlan) -> CoreResult<BuiltTx> {
    let total: u64 = plan.inputs.iter().map(|u| u.value_sats.0).sum();
    let witness = withdrawal_witness_size(plan.witness_script.len());
    let rate = u64::from(plan.fee_rate_sat_vb);
    let short = || Rejection::new(ErrorCode::InsufficientFunds);

    // First try with a change output; drop it if the change would be dust.
    let with_change = build(
        plan.inputs,
        &[
            (plan.destination.to_vec(), plan.amount_sats),
            (plan.change_to.to_vec(), 0),
        ],
    )?;
    let fee = vsize(with_change.serialize().len(), plan.inputs.len(), witness) * rate;
    let change = total
        .checked_sub(plan.amount_sats)
        .and_then(|r| r.checked_sub(fee))
        .ok_or_else(short)?;

    let (outputs, fee, change) = if change >= DUST_LIMIT_SATS {
        (
            vec![
                (plan.destination.to_vec(), plan.amount_sats),
                (plan.change_to.to_vec(), change),
            ],
            fee,
            change,
        )
    } else {
        let alone = build(
            plan.inputs,
            &[(plan.destination.to_vec(), plan.amount_sats)],
        )?;
        let minimum = vsize(alone.serialize().len(), plan.inputs.len(), witness) * rate;
        let fee = total.checked_sub(plan.amount_sats).ok_or_else(short)?;
        if fee < minimum {
            return Err(short());
        }
        (vec![(plan.destination.to_vec(), plan.amount_sats)], fee, 0)
    };
    if fee > plan.fee_cap_sats {
        return Err(Rejection::with(
            ErrorCode::FeeTooHigh,
            format!("fee {fee} > cap {}", plan.fee_cap_sats),
        ));
    }
    let tx = build(plan.inputs, &outputs)?;
    Ok(BuiltTx {
        unsigned: tx.serialize(),
        sighashes: sighashes(&tx, plan.inputs, plan.witness_script),
        fee_sats: fee,
        change_sats: change,
    })
}

/// Sweeps every input to a single output (the Recovery Address); the fee is taken from the amount.
/// Sized for the Clawback Path witness.
pub fn build_sweep(
    inputs: &[Outpoint],
    to: &[u8],
    fee_rate_sat_vb: u32,
    fee_cap_sats: u64,
    witness_script: &[u8],
) -> CoreResult<BuiltTx> {
    sweep(
        inputs,
        to,
        fee_rate_sat_vb,
        fee_cap_sats,
        witness_script,
        clawback_witness_size(witness_script.len()),
    )
}

/// A Refresh: sweeps every input back to the P2WSH address of `vault_script` itself, sized for
/// the Withdrawal Path witness, with a fee of at most `withdrawal_fee_cap` of the input total.
/// It takes no destination, so its only output is the Vault Address by construction.
pub fn build_refresh(
    inputs: &[Outpoint],
    fee_rate_sat_vb: u32,
    policy_fee_cap_sats: u64,
    vault_script: &[u8],
) -> CoreResult<BuiltTx> {
    let total: u64 = inputs.iter().map(|u| u.value_sats.0).sum();
    sweep(
        inputs,
        &p2wsh_script_pubkey(vault_script),
        fee_rate_sat_vb,
        withdrawal_fee_cap(policy_fee_cap_sats, total),
        vault_script,
        withdrawal_witness_size(vault_script.len()),
    )
}

/// Every input to one output; the fee, sized with `witness_per_input`, comes out of the amount.
fn sweep(
    inputs: &[Outpoint],
    to: &[u8],
    fee_rate_sat_vb: u32,
    fee_cap_sats: u64,
    witness_script: &[u8],
    witness_per_input: u64,
) -> CoreResult<BuiltTx> {
    let total: u64 = inputs.iter().map(|u| u.value_sats.0).sum();
    let probe = build(inputs, &[(to.to_vec(), total)])?;
    let fee = vsize(probe.serialize().len(), inputs.len(), witness_per_input)
        * u64::from(fee_rate_sat_vb);
    if fee > fee_cap_sats {
        return Err(Rejection::with(
            ErrorCode::FeeTooHigh,
            format!("fee {fee} > cap {fee_cap_sats}"),
        ));
    }
    let amount = total.checked_sub(fee).filter(|a| *a >= DUST_LIMIT_SATS);
    let amount = amount.ok_or_else(|| Rejection::new(ErrorCode::InsufficientFunds))?;
    let tx = build(inputs, &[(to.to_vec(), amount)])?;
    Ok(BuiltTx {
        unsigned: tx.serialize(),
        sighashes: sighashes(&tx, inputs, witness_script),
        fee_sats: fee,
        change_sats: 0,
    })
}

/// Clawback fee cap: min(2 × Fee Cap, 10% of the amount moved), so a Clawback can outbid a
/// conflicting withdrawal.
pub fn clawback_fee_cap(policy_fee_cap: u64, amount_sats: u64) -> u64 {
    policy_fee_cap.saturating_mul(2).min(amount_sats / 10)
}

/// Withdrawal fee cap: min(Fee Cap, 5% of the amount moved).
pub fn withdrawal_fee_cap(policy_fee_cap: u64, amount_sats: u64) -> u64 {
    policy_fee_cap.min(amount_sats / 20)
}

/// Test helpers shared with the contract tests.
#[cfg(test)]
pub(crate) mod test_support {
    /// The outputs of an unsigned (non-witness) serialization: (value, scriptPubKey).
    pub(crate) fn outputs(unsigned: &[u8]) -> Vec<(u64, Vec<u8>)> {
        // Every count and script length here is below 0xfd, so each varint is one byte.
        let mut at = 4;
        let input_count = unsigned[at] as usize;
        at += 1;
        for _ in 0..input_count {
            at += 36;
            at += 1 + unsigned[at] as usize + 4;
        }
        let output_count = unsigned[at] as usize;
        at += 1;
        let mut found = Vec::new();
        for _ in 0..output_count {
            let value = u64::from_le_bytes(unsigned[at..at + 8].try_into().unwrap());
            let len = unsigned[at + 8] as usize;
            found.push((value, unsigned[at + 9..at + 9 + len].to_vec()));
            at += 9 + len;
        }
        assert_eq!(at + 4, unsigned.len(), "only the lock time is left");
        found
    }

    /// The nSequence of every input of an unsigned (non-witness) serialization.
    pub(crate) fn sequences(unsigned: &[u8]) -> Vec<u32> {
        let mut at = 4;
        let input_count = unsigned[at] as usize;
        at += 1;
        let mut found = Vec::new();
        for _ in 0..input_count {
            at += 36;
            at += 1 + unsigned[at] as usize;
            found.push(u32::from_le_bytes(unsigned[at..at + 4].try_into().unwrap()));
            at += 4;
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::outputs;
    use super::*;
    use crate::core::script::{build_vault_script, from_hex, hex};
    use near_sdk::json_types::U64;

    pub fn key(prefix: u8, byte: u8) -> [u8; 33] {
        let mut k = [byte; 33];
        k[0] = prefix;
        k
    }

    pub fn script() -> Vec<u8> {
        build_vault_script(
            &key(0x02, 0x11),
            &key(0x03, 0xaa),
            &[key(0x02, 0x22)],
            26_280,
        )
    }

    fn p2wsh(script: &[u8]) -> Vec<u8> {
        [vec![0x00, 0x20], Sha256::digest(script).to_vec()].concat()
    }

    pub fn inputs() -> Vec<Outpoint> {
        vec![
            Outpoint {
                txid: format!("{}01", "ab".repeat(31)),
                vout: 1,
                value_sats: U64(150_000),
            },
            Outpoint {
                txid: format!("{}02", "cd".repeat(31)),
                vout: 0,
                value_sats: U64(60_000),
            },
        ]
    }

    pub const DESTINATION: &str = "0014751e76e8199196d454941c45d1b3a323f1433bd6";

    pub fn plan<'a>(
        inputs: &'a [Outpoint],
        destination: &'a [u8],
        change: &'a [u8],
        script: &'a [u8],
        amount: u64,
        rate: u32,
    ) -> PaymentPlan<'a> {
        PaymentPlan {
            inputs,
            amount_sats: amount,
            destination,
            change_to: change,
            fee_rate_sat_vb: rate,
            fee_cap_sats: withdrawal_fee_cap(100_000, amount),
            witness_script: script,
        }
    }

    // Pinned against bitcoinjs-lib 7.0.5: Transaction.fromHex(UNSIGNED) keeps the display txids,
    // and hashForWitnessV0(i, SCRIPT, value, SIGHASH_ALL) equals each sighash below.
    const UNSIGNED: &str = "020000000201ababababababababababababababababababababababababababababababab0100000000fdffffff02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000fdffffff02a086010000000000160014751e76e8199196d454941c45d1b3a323f1433bd60eab010000000000220020d7e67e333274724565dbc12c6780807c65311d7bcccef2117477faf51e4fb53a00000000";
    const SIGHASHES: [&str; 2] = [
        "bb8873f2f1a14d1b5809ee3b88e7f1f83711480e3ee790850226d67a75a54709",
        "719a66f5097c081884cc06f543e70a02adf494f143443e45f58a1afb12639998",
    ];

    fn built(amount: u64, rate: u32) -> CoreResult<BuiltTx> {
        let (inputs, script) = (inputs(), script());
        let (dest, change) = (from_hex(DESTINATION).unwrap(), p2wsh(&script));
        build_payment(&plan(&inputs, &dest, &change, &script, amount, rate))
    }

    #[test]
    fn builds_rbf_v2_payments_with_bitcoinjs_identical_sighashes() {
        let tx = built(100_000, 2).unwrap();
        assert_eq!(hex(&tx.unsigned), UNSIGNED);
        let sighashes: Vec<String> = tx.sighashes.iter().map(|s| hex(s)).collect();
        assert_eq!(sighashes, SIGHASHES);
        assert_eq!(tx.fee_sats, 674);
        assert_eq!(tx.change_sats, 210_000 - 100_000 - 674);
    }

    #[test]
    fn folds_dust_change_into_the_fee() {
        // 210,000 in; leave less than 546 sats after a 2 sat/vB fee.
        let tx = built(210_000 - 674 - 500, 2).unwrap();
        assert_eq!(tx.change_sats, 0);
        assert_eq!(tx.fee_sats, 674 + 500);
    }

    #[test]
    fn enforces_the_fee_cap_and_funds() {
        assert_eq!(built(100_000, 100).unwrap_err().code, ErrorCode::FeeTooHigh);
        assert_eq!(
            built(210_000, 2).unwrap_err().code,
            ErrorCode::InsufficientFunds
        );
        assert_eq!(withdrawal_fee_cap(100_000, 1_000_000), 50_000);
        assert_eq!(withdrawal_fee_cap(100_000, 10_000_000), 100_000);
    }

    #[test]
    fn sizes_the_withdrawal_witness() {
        assert_eq!(withdrawal_witness_size(188), 1 + 74 + 74 + 2 + 1 + 188);
        assert_eq!(withdrawal_witness_size(300), 1 + 74 + 74 + 2 + 3 + 300);
    }

    // Pinned against bitcoinjs-lib 7.0.5 (hashForWitnessV0 with the Vault Script, SIGHASH_ALL).
    const SWEEP_UNSIGNED: &str = "020000000201ababababababababababababababababababababababababababababababab0100000000fdffffff02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000fdffffff01db30030000000000160014751e76e8199196d454941c45d1b3a323f1433bd600000000";

    #[test]
    fn sweeps_everything_to_one_output_with_bitcoinjs_identical_sighashes() {
        let (inputs, script) = (inputs(), script());
        let to = from_hex(DESTINATION).unwrap();
        let built =
            build_sweep(&inputs, &to, 3, clawback_fee_cap(100_000, 210_000), &script).unwrap();
        assert_eq!(hex(&built.unsigned), SWEEP_UNSIGNED);
        let sighashes: Vec<String> = built.sighashes.iter().map(|s| hex(s)).collect();
        assert_eq!(
            sighashes,
            [
                "4b8b23120d6d9f5019a5f3e08d279d76c1cdf62dd13083345c4a2dea5d21900b",
                "9101d069a9ce33c38dc871f9bb13eab703717b62b90f266e708fbf3b0a2784ff"
            ]
        );
        assert_eq!(built.fee_sats, 885);
    }

    #[test]
    fn caps_clawback_fees_and_rejects_dust() {
        let (inputs, script) = (inputs(), script());
        let to = from_hex(DESTINATION).unwrap();
        assert_eq!(clawback_fee_cap(100_000, 210_000), 21_000);
        assert_eq!(clawback_fee_cap(100_000, 10_000_000), 200_000);
        assert_eq!(
            build_sweep(&inputs, &to, 100, 21_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
        let tiny = vec![Outpoint {
            value_sats: U64(600),
            ..inputs[0].clone()
        }];
        assert_eq!(
            build_sweep(&tiny, &to, 1, 21_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::InsufficientFunds
        );
        assert!(clawback_witness_size(188) > withdrawal_witness_size(188));
    }

    fn coins(count: u8, value: u64) -> Vec<Outpoint> {
        (1..=count)
            .map(|n| Outpoint {
                txid: format!("{n:02x}").repeat(32),
                vout: u32::from(n),
                value_sats: U64(value),
            })
            .collect()
    }

    #[test]
    fn a_refresh_has_exactly_one_output_the_vault_address() {
        let script = script();
        let vault = p2wsh(&script);
        for count in 1..=5u8 {
            for rate in [1, 2, 10, 25] {
                let inputs = coins(count, 150_000);
                let total = 150_000 * u64::from(count);
                let built = build_refresh(&inputs, rate, 100_000, &script).unwrap();
                assert_eq!(
                    outputs(&built.unsigned),
                    vec![(total - built.fee_sats, vault.clone())],
                    "{count} inputs at {rate} sat/vB"
                );
                assert_eq!(built.change_sats, 0);
                assert_eq!(built.sighashes.len(), inputs.len());
                assert!(built.fee_sats <= withdrawal_fee_cap(100_000, total));
                let size = vsize(
                    built.unsigned.len(),
                    inputs.len(),
                    withdrawal_witness_size(script.len()),
                );
                assert_eq!(built.fee_sats, size * u64::from(rate));
                assert_eq!(built.sighashes, sighashes_of(&inputs, &built, &script));
            }
        }
    }

    fn sighashes_of(inputs: &[Outpoint], built: &BuiltTx, script: &[u8]) -> Vec<[u8; 32]> {
        let tx = build(
            inputs,
            &outputs(&built.unsigned)
                .into_iter()
                .map(|(value, script_pubkey)| (script_pubkey, value))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        sighashes(&tx, inputs, script)
    }

    #[test]
    fn a_refresh_is_sized_with_the_withdrawal_witness() {
        let (inputs, script) = (inputs(), script());
        let refresh = build_refresh(&inputs, 3, 100_000, &script).unwrap();
        // The same sweep sized for the Clawback witness: same shape, a larger fee.
        let clawback = build_sweep(&inputs, &p2wsh(&script), 3, 100_000, &script).unwrap();
        assert_eq!(refresh.unsigned.len(), clawback.unsigned.len());
        assert!(refresh.fee_sats < clawback.fee_sats);
    }

    #[test]
    fn a_refresh_respects_the_fee_cap_and_dust() {
        let script = script();
        // 5 % of 210,000 is 10,500; 100 sat/vB on two inputs is far more.
        assert_eq!(
            build_refresh(&inputs(), 100, 100_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
        // The Policy Fee Cap binds when it is below 5 %.
        assert_eq!(
            build_refresh(&inputs(), 2, 300, &script).unwrap_err().code,
            ErrorCode::FeeTooHigh
        );
        // At any positive rate a tiny coin trips the 5 % cap first; at 0 sat/vB the output itself
        // is dust.
        assert_eq!(
            build_refresh(&coins(1, 500), 0, 100_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::InsufficientFunds
        );
        assert_eq!(
            build_refresh(&coins(1, 600), 1, 100_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
    }

    /// The refresh fee of two inputs at 1 sat/vB, i.e. its vsize.
    fn refresh_vsize(inputs: &[Outpoint], script: &[u8]) -> u64 {
        build_refresh(inputs, 1, u64::MAX, script).unwrap().fee_sats
    }

    #[test]
    fn a_refresh_uses_the_withdrawal_cap_not_the_clawback_cap() {
        let (inputs, script) = (inputs(), script());
        let vsize = refresh_vsize(&inputs, &script);

        // Fee Cap side: a fee above the Fee Cap but within 2 × Fee Cap is refused.
        let rate = 20;
        let fee = vsize * u64::from(rate);
        assert!(fee <= clawback_fee_cap(fee - 1, 210_000));
        assert_eq!(
            build_refresh(&inputs, rate, fee - 1, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
        assert_eq!(
            build_refresh(&inputs, rate, fee, &script).unwrap().fee_sats,
            fee
        );

        // 5 % side: a fee above 5 % of the inputs (10,500) but within 10 % (21,000) is refused.
        let rate = u32::try_from(10_500 / vsize + 1).unwrap();
        let fee = vsize * u64::from(rate);
        assert!(fee > 10_500 && fee <= clawback_fee_cap(100_000, 210_000));
        assert_eq!(
            build_refresh(&inputs, rate, 100_000, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
    }

    #[test]
    fn a_refresh_fee_may_equal_five_percent_but_not_one_sat_more() {
        let script = script();
        let vsize = refresh_vsize(&inputs(), &script);
        let fee = vsize * 10;
        // Two coins worth exactly 20 × fee: 5 % is the fee itself.
        let at_cap = |total: u64| {
            let mut coins = inputs();
            coins[0].value_sats = U64(total / 2);
            coins[1].value_sats = U64(total - total / 2);
            coins
        };
        let built = build_refresh(&at_cap(20 * fee), 10, u64::MAX, &script).unwrap();
        assert_eq!(built.fee_sats, fee);
        assert_eq!(
            build_refresh(&at_cap(20 * fee - 20), 10, u64::MAX, &script)
                .unwrap_err()
                .code,
            ErrorCode::FeeTooHigh
        );
    }
}
