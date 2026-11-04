//! Signer-discipline property suite (Story 7.4).
//!
//! Random hostile call sequences (Owner, each Guardian, a stranger, the Owner and the Guardian of
//! another Vault, and time jumps) run against the real contract methods in the NEAR unit-test
//! environment. After every step three invariant families are checked:
//!
//! 1. No signature outside the Policy: every MPC sign request is for an op whose freeze was
//!    legal, triggered by an authorised caller, on the op's own path, for the sighash this file
//!    recomputes (BIP143) from the frozen transaction, and that transaction pays only what the
//!    Policy allows.
//! 2. No fee above the cap, recomputed here from the transaction's inputs and outputs.
//! 3. No change to Script-bound data, and a Policy field changes only through an applied Policy
//!    Change after its `effective_at`.
//!
//! The checks use their own transaction decoder, address decoder and BIP143 code, never the
//! contract's builder. A panicking call is a refusal: the contract struct and the storage are
//! rolled back to before the call, as NEAR reverts a failed receipt.
//!
//! Run: `cargo test -p morrow-vault --release property -- --nocapture`. `MORROW_PROPTEST_SEED`
//! (hex) picks the seed; `MORROW_PROPTEST_CASES` the number of cases (default 1,000).

use super::withdrawals_support::{envelope, signing_mpc, DESTINATION, NOW};
use super::*;
use crate::core::policy::tests::{guardian, standard_policy, RECOVERY_SIGNET};
use crate::core::policy::{Guardian, GuardianKind, HOUR_NS};
use crate::core::spend::{Outpoint, SpendOp, SpendOpKind, SpendOpState, SpendSource};
use crate::core::tx::{clawback_fee_cap, withdrawal_fee_cap};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Map;
use near_sdk::test_utils::get_created_receipts;
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::select;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, RngAlgorithm, TestCaseError, TestError, TestRng, TestRunner};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::AssertUnwindSafe;

const DEFAULT_SEED: u64 = 0x6d6f_7272_6f77; // "morrow"
const DEFAULT_CASES: u32 = 1_000;
const MAX_STEPS: usize = 30;

const SIGNER: &str = "v1.signer-prod.testnet";
const OWNER: &str = "owner.testnet";
const EMMA: &str = "emma.testnet";
const BACKUP: &str = "backup.testnet";
const STRANGER: &str = "stranger.testnet";
const OTHER_OWNER: &str = "other-owner.testnet";
const OTHER_GUARDIAN: &str = "other-guardian.testnet";
/// The contract's own account in the unit-test context: the MPC callback comes from it.
const SELF: &str = "alice.near";

const MAIN: u64 = 1;
const OTHER: u64 = 2;
const MISSING: u64 = 99;
const POOL_SIZE: usize = 10;

// Signet addresses from BIP173/BIP350 test vectors, plus addresses of other networks.
const TAPROOT_SIGNET: &str = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c";
const WSH_SIGNET: &str = "tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy";
const MAINNET: &str = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const REGTEST: &str = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const BAD_CHECKSUM: &str = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8";

// ---------------------------------------------------------------------------------------------
// Generated actions.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Who {
    Owner,
    Emma,
    Backup,
    Stranger,
    OtherOwner,
    OtherGuardian,
}

impl Who {
    const fn account(self) -> &'static str {
        match self {
            Self::Owner => OWNER,
            Self::Emma => EMMA,
            Self::Backup => BACKUP,
            Self::Stranger => STRANGER,
            Self::OtherOwner => OTHER_OWNER,
            Self::OtherGuardian => OTHER_GUARDIAN,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum VaultPick {
    Main,
    Other,
    Missing,
}

impl VaultPick {
    const fn id(self) -> u64 {
        match self {
            Self::Main => MAIN,
            Self::Other => OTHER,
            Self::Missing => MISSING,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Env {
    Valid,
    Short,
    Upper,
    NotHex,
}

impl Env {
    fn text(self) -> String {
        match self {
            Self::Valid => envelope(),
            Self::Short => "ab".repeat(79),
            Self::Upper => "AB".repeat(80),
            Self::NotHex => "zz".repeat(80),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum CoinValue {
    Pool,
    Zero,
    BelowDust,
    Max,
    Sats(u64),
}

#[derive(Clone, Copy, Debug)]
struct Coin {
    n: u8,
    value: CoinValue,
}

#[derive(Clone, Debug)]
enum Utxos {
    Coins(Vec<Coin>),
    Empty,
    Six,
    Duplicate(Coin),
    FakeTxid(u8),
}

#[derive(Clone, Copy, Debug)]
enum Amount {
    Zero,
    BelowDust,
    Dust,
    LimitMinus1,
    Limit,
    LimitPlus1,
    RemainingMinus1,
    Remaining,
    RemainingPlus1,
    Max,
    /// A percentage of the chosen coins.
    Share(u8),
    Sats(u64),
}

#[derive(Clone, Copy, Debug)]
enum Dest {
    Main,
    Taproot,
    Wsh,
    Recovery,
    OwnVault,
    OwnAllowance,
    Mainnet,
    Regtest,
    BadChecksum,
    Garbage,
}

#[derive(Clone, Copy, Debug)]
enum Rate {
    Zero,
    One,
    Normal(u32),
    Huge,
    Max,
}

impl Rate {
    const fn sat_vb(self) -> u32 {
        match self {
            Self::Zero => 0,
            Self::One => 1,
            Self::Normal(rate) => rate,
            Self::Huge => 1_000,
            Self::Max => u32::MAX,
        }
    }
}

#[derive(Clone, Debug)]
enum Field {
    Delay(u64),
    Recovery(Dest),
    Limit(u64),
    FeeCap(u64),
    ChangeDelay(u64),
    Fast(bool),
    Floor(u64),
    ScriptBound(usize),
    NonCanonical(usize),
}

#[derive(Clone, Debug)]
enum Change {
    Fields(Vec<Field>),
    NotObject,
}

#[derive(Clone, Copy, Debug)]
enum Time {
    Zero,
    OneNano,
    /// A pending withdrawal's `executable_at` plus -1, 0 or +1 ns.
    ExecutableAt(u8, i8),
    /// The Main Vault's pending change's `effective_at` plus -1, 0 or +1 ns.
    EffectiveAt(i8),
    Delay,
    Day,
    Random(u64),
}

#[derive(Clone, Debug)]
enum Plant {
    /// Test-only hook: moves a pending withdrawal's stored `executable_at` 1 ns earlier.
    ExecutableAtOneNanoEarlier(u8),
}

#[derive(Clone, Debug)]
enum Action {
    Request {
        who: Who,
        vault: VaultPick,
        amount: Amount,
        dest: Dest,
        rate: Rate,
        utxos: Utxos,
        env: Env,
    },
    Execute {
        who: Who,
        op: u8,
        env: Env,
    },
    Sign {
        who: Who,
        op: u8,
        input: u8,
    },
    Cancel {
        who: Who,
        op: u8,
        env: Option<Env>,
    },
    Refresh {
        who: Who,
        vault: VaultPick,
        utxos: Utxos,
        rate: Rate,
        env: Env,
        source: Option<SpendSource>,
    },
    Allowance {
        who: Who,
        vault: VaultPick,
        amount: Amount,
        dest: Dest,
        rate: Rate,
        utxos: Utxos,
        env: Env,
    },
    Clawback {
        who: Who,
        vault: VaultPick,
        utxos: Utxos,
        rate: Rate,
        source: Option<SpendSource>,
    },
    Propose {
        who: Who,
        vault: VaultPick,
        change: Change,
        env: Env,
    },
    Veto {
        who: Who,
        change: u8,
        env: Option<Env>,
    },
    Apply {
        who: Who,
        change: u8,
    },
    TopUp {
        who: Who,
        vault: VaultPick,
        deposit: u8,
    },
    Advance(Time),
    /// Meta-tests only: never generated.
    Plant(Plant),
}

#[derive(Clone, Debug)]
struct Setup {
    allowance_limit: u64,
    fee_cap: u64,
    pool: Vec<u64>,
}

#[derive(Clone, Debug)]
struct Case {
    setup: Setup,
    steps: Vec<Action>,
}

// ---------------------------------------------------------------------------------------------
// Strategies.

/// A caller: the Main Vault's Owner and Guardians weighted by the action, plus a stranger and the
/// Owner and the Guardian of the other Vault.
fn who(owner: u32, guardian: u32) -> impl Strategy<Value = Who> {
    prop_oneof![
        owner => Just(Who::Owner),
        guardian => Just(Who::Emma),
        guardian => Just(Who::Backup),
        1 => Just(Who::Stranger),
        1 => Just(Who::OtherOwner),
        1 => Just(Who::OtherGuardian),
    ]
}

/// Callers of Owner methods.
fn owner_side() -> impl Strategy<Value = Who> {
    who(12, 1)
}

fn vault_pick() -> impl Strategy<Value = VaultPick> {
    prop_oneof![
        20 => Just(VaultPick::Main),
        1 => Just(VaultPick::Other),
        1 => Just(VaultPick::Missing),
    ]
}

fn env_pick() -> impl Strategy<Value = Env> {
    prop_oneof![
        30 => Just(Env::Valid),
        1 => Just(Env::Short),
        1 => Just(Env::Upper),
        1 => Just(Env::NotHex),
    ]
}

fn optional_env() -> impl Strategy<Value = Option<Env>> {
    prop_oneof![10 => env_pick().prop_map(Some), 1 => Just(None)]
}

fn coin() -> impl Strategy<Value = Coin> {
    let value = prop_oneof![
        40 => Just(CoinValue::Pool),
        1 => Just(CoinValue::Zero),
        1 => Just(CoinValue::BelowDust),
        1 => Just(CoinValue::Max),
        1 => (1u64..=3_000_000).prop_map(CoinValue::Sats),
    ];
    (0..POOL_SIZE as u8, value).prop_map(|(n, value)| Coin { n, value })
}

fn utxos() -> impl Strategy<Value = Utxos> {
    prop_oneof![
        30 => vec(coin(), 1..=4).prop_map(Utxos::Coins),
        1 => Just(Utxos::Empty),
        1 => Just(Utxos::Six),
        1 => coin().prop_map(Utxos::Duplicate),
        1 => any::<u8>().prop_map(Utxos::FakeTxid),
    ]
}

fn amount() -> impl Strategy<Value = Amount> {
    let edges = select(vec![
        Amount::Zero,
        Amount::BelowDust,
        Amount::Dust,
        Amount::LimitMinus1,
        Amount::Limit,
        Amount::LimitPlus1,
        Amount::RemainingMinus1,
        Amount::Remaining,
        Amount::RemainingPlus1,
        Amount::Max,
    ]);
    prop_oneof![
        4 => edges,
        12 => (20u8..=100).prop_map(Amount::Share),
        2 => (1u8..=100).prop_map(Amount::Share),
        2 => (1u64..=2_000_000).prop_map(Amount::Sats),
    ]
}

fn dest() -> impl Strategy<Value = Dest> {
    let others = select(vec![
        Dest::Taproot,
        Dest::Wsh,
        Dest::Recovery,
        Dest::OwnVault,
        Dest::OwnAllowance,
        Dest::Mainnet,
        Dest::Regtest,
        Dest::BadChecksum,
        Dest::Garbage,
    ]);
    prop_oneof![14 => Just(Dest::Main), 4 => others]
}

fn rate() -> impl Strategy<Value = Rate> {
    prop_oneof![
        1 => Just(Rate::Zero),
        2 => Just(Rate::One),
        14 => (2u32..=10).prop_map(Rate::Normal),
        2 => (11u32..=60).prop_map(Rate::Normal),
        1 => Just(Rate::Huge),
        1 => Just(Rate::Max),
    ]
}

fn source() -> impl Strategy<Value = Option<SpendSource>> {
    prop_oneof![
        2 => Just(None),
        1 => Just(Some(SpendSource::Vault)),
        2 => Just(Some(SpendSource::Allowance)),
    ]
}

fn field() -> impl Strategy<Value = Field> {
    prop_oneof![
        3 => select(vec![HOUR_NS - 1, HOUR_NS, DAY_NS, 2 * DAY_NS, 7 * DAY_NS, 30 * DAY_NS + 1, 0])
            .prop_map(Field::Delay),
        3 => select(vec![Dest::Main, Dest::Taproot, Dest::Recovery, Dest::Mainnet, Dest::Garbage])
            .prop_map(Field::Recovery),
        3 => select(vec![0, 1, 546, 100_000, 1_000_000, u64::MAX]).prop_map(Field::Limit),
        3 => select(vec![0, 9_999, 10_000, 50_000, 1_000_000, 1_000_001]).prop_map(Field::FeeCap),
        2 => select(vec![7 * DAY_NS - 1, 7 * DAY_NS, 8 * DAY_NS, 90 * DAY_NS, 90 * DAY_NS + 1])
            .prop_map(Field::ChangeDelay),
        1 => any::<bool>().prop_map(Field::Fast),
        1 => select(vec![9 * MINUTE_NS, 10 * MINUTE_NS, HOUR_NS, DAY_NS, 30 * DAY_NS])
            .prop_map(Field::Floor),
        2 => (0..SCRIPT_BOUND_KEYS.len()).prop_map(Field::ScriptBound),
        1 => (0..NON_CANONICAL.len()).prop_map(Field::NonCanonical),
    ]
}

fn change() -> impl Strategy<Value = Change> {
    prop_oneof![
        20 => vec(field(), 0..=3).prop_map(Change::Fields),
        1 => Just(Change::NotObject),
    ]
}

fn time() -> impl Strategy<Value = Time> {
    prop_oneof![
        1 => Just(Time::Zero),
        1 => Just(Time::OneNano),
        6 => (any::<u8>(), -1i8..=1).prop_map(|(op, d)| Time::ExecutableAt(op, d)),
        3 => (-1i8..=1).prop_map(Time::EffectiveAt),
        3 => Just(Time::Delay),
        3 => Just(Time::Day),
        2 => (0..=40 * DAY_NS).prop_map(Time::Random),
    ]
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        6 => (owner_side(), vault_pick(), amount(), dest(), rate(), utxos(), env_pick()).prop_map(
            |(who, vault, amount, dest, rate, utxos, env)| Action::Request {
                who, vault, amount, dest, rate, utxos, env,
            }
        ),
        6 => (owner_side(), any::<u8>(), env_pick())
            .prop_map(|(who, op, env)| Action::Execute { who, op, env }),
        8 => (who(8, 3), any::<u8>(), any::<u8>())
            .prop_map(|(who, op, input)| Action::Sign { who, op, input }),
        2 => (who(6, 3), any::<u8>(), optional_env())
            .prop_map(|(who, op, env)| Action::Cancel { who, op, env }),
        3 => (owner_side(), vault_pick(), utxos(), rate(), env_pick(), source()).prop_map(
            |(who, vault, utxos, rate, env, source)| Action::Refresh {
                who, vault, utxos, rate, env, source,
            }
        ),
        4 => (owner_side(), vault_pick(), amount(), dest(), rate(), utxos(), env_pick()).prop_map(
            |(who, vault, amount, dest, rate, utxos, env)| Action::Allowance {
                who, vault, amount, dest, rate, utxos, env,
            }
        ),
        1 => (who(3, 3), vault_pick(), utxos(), rate(), source()).prop_map(
            |(who, vault, utxos, rate, source)| Action::Clawback {
                who, vault, utxos, rate, source,
            }
        ),
        4 => (owner_side(), vault_pick(), change(), env_pick())
            .prop_map(|(who, vault, change, env)| Action::Propose { who, vault, change, env }),
        1 => (who(3, 3), any::<u8>(), optional_env())
            .prop_map(|(who, change, env)| Action::Veto { who, change, env }),
        3 => (who(2, 2), any::<u8>()).prop_map(|(who, change)| Action::Apply { who, change }),
        1 => (who(1, 1), vault_pick(), 0u8..3)
            .prop_map(|(who, vault, deposit)| Action::TopUp { who, vault, deposit }),
        8 => time().prop_map(Action::Advance),
    ]
}

fn case() -> impl Strategy<Value = Case> {
    let setup = (
        select(vec![0u64, 100_000, 1_000_000]),
        select(vec![10_000u64, 100_000]),
        vec(
            select(vec![600u64, 10_000, 60_000, 150_000, 1_000_000, 5_000_000]),
            POOL_SIZE,
        ),
    )
        .prop_map(|(allowance_limit, fee_cap, pool)| Setup {
            allowance_limit,
            fee_cap,
            pool,
        });
    (setup, vec(action(), 1..=MAX_STEPS)).prop_map(|(setup, steps)| Case { setup, steps })
}

const SCRIPT_BOUND_KEYS: [&str; 8] = [
    "guardians",
    "escape_timelock_blocks",
    "btc_network",
    "watcher_x25519_pk",
    "owner_key",
    "cosigner_pubkeys",
    "addresses",
    "owner_account",
];

/// Whitelisted keys with values in a form the contract must refuse.
const NON_CANONICAL: [(&str, &str); 5] = [
    ("delay_ns", "86400000000000.0"),
    ("fee_cap_sats", "010000"),
    ("allowance_limit_sats", "-1"),
    ("fast_approval", "yes"),
    ("policy_change_delay_ns", " 604800000000000"),
];

// ---------------------------------------------------------------------------------------------
// Independent Bitcoin decoding: hex, addresses, transactions and BIP143 sighashes.

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn sha256d(data: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(data)).into()
}

/// The output script of a signet SegWit address, or `None` if it is not one.
fn signet_script(address: &str) -> Option<Vec<u8>> {
    let (hrp, version, program) = bech32::segwit::decode(address).ok()?;
    if hrp != bech32::hrp::TB {
        return None;
    }
    let version = version.to_u8();
    let opcode = if version == 0 { 0x00 } else { 0x50 + version };
    Some([vec![opcode, u8::try_from(program.len()).ok()?], program].concat())
}

fn p2wsh(script: &[u8]) -> Vec<u8> {
    [vec![0x00, 0x20], Sha256::digest(script).to_vec()].concat()
}

#[derive(Clone, Debug)]
struct TxInput {
    /// Serialized (internal) byte order.
    txid: [u8; 32],
    vout: u32,
    sequence: u32,
}

#[derive(Clone, Debug)]
struct Tx {
    version: [u8; 4],
    inputs: Vec<TxInput>,
    outputs: Vec<(u64, Vec<u8>)>,
    lock_time: [u8; 4],
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let slice = self.bytes.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(slice)
    }
    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        self.take(N)?.try_into().ok()
    }
    fn varint(&mut self) -> Option<u64> {
        match self.array::<1>()?[0] {
            0xfd => Some(u64::from(u16::from_le_bytes(self.array()?))),
            0xfe => Some(u64::from(u32::from_le_bytes(self.array()?))),
            0xff => Some(u64::from_le_bytes(self.array()?)),
            n => Some(u64::from(n)),
        }
    }
    fn count(&mut self) -> Option<usize> {
        usize::try_from(self.varint()?).ok()
    }
}

/// Decodes an unsigned (non-witness) transaction serialization.
fn parse_tx(tx_hex: &str) -> Option<Tx> {
    let bytes = decode_hex(tx_hex)?;
    let mut r = Reader {
        bytes: &bytes,
        at: 0,
    };
    let version = r.array()?;
    let inputs = (0..r.count()?)
        .map(|_| {
            let txid = r.array()?;
            let vout = u32::from_le_bytes(r.array()?);
            let script_len = r.count()?;
            r.take(script_len)?;
            let sequence = u32::from_le_bytes(r.array()?);
            Some(TxInput {
                txid,
                vout,
                sequence,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let outputs = (0..r.count()?)
        .map(|_| {
            let value = u64::from_le_bytes(r.array()?);
            let len = r.count()?;
            Some((value, r.take(len)?.to_vec()))
        })
        .collect::<Option<Vec<_>>>()?;
    let lock_time = r.array()?;
    (r.at == bytes.len()).then_some(Tx {
        version,
        inputs,
        outputs,
        lock_time,
    })
}

fn push_varint(out: &mut Vec<u8>, n: usize) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend((n as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend((n as u32).to_le_bytes());
        }
    }
}

/// BIP143 SIGHASH_ALL digest of input `index`, with `script` as the script code.
fn bip143(tx: &Tx, index: usize, script: &[u8], value: u64) -> [u8; 32] {
    let mut prevouts = Vec::new();
    let mut sequences = Vec::new();
    for input in &tx.inputs {
        prevouts.extend(input.txid);
        prevouts.extend(input.vout.to_le_bytes());
        sequences.extend(input.sequence.to_le_bytes());
    }
    let mut outputs = Vec::new();
    for (value, script_pubkey) in &tx.outputs {
        outputs.extend(value.to_le_bytes());
        push_varint(&mut outputs, script_pubkey.len());
        outputs.extend(script_pubkey);
    }
    let input = &tx.inputs[index];
    let mut preimage = Vec::new();
    preimage.extend(tx.version);
    preimage.extend(sha256d(&prevouts));
    preimage.extend(sha256d(&sequences));
    preimage.extend(input.txid);
    preimage.extend(input.vout.to_le_bytes());
    push_varint(&mut preimage, script.len());
    preimage.extend(script);
    preimage.extend(value.to_le_bytes());
    preimage.extend(input.sequence.to_le_bytes());
    preimage.extend(sha256d(&outputs));
    preimage.extend(tx.lock_time);
    preimage.extend(1u32.to_le_bytes());
    sha256d(&preimage)
}

/// The display (RPC) txid of a serialized input.
fn display_txid(input: &TxInput) -> String {
    let mut txid = input.txid;
    txid.reverse();
    to_hex(&txid)
}

// ---------------------------------------------------------------------------------------------
// The model the invariants are checked against.

#[derive(Clone, Debug)]
struct Violation {
    family: u8,
    message: String,
}

type Checked = Result<(), Violation>;

fn family(family: u8, message: impl Into<String>) -> Violation {
    Violation {
        family,
        message: message.into(),
    }
}

/// Invariant 1: no signature outside the Policy.
fn signature(message: impl Into<String>) -> Violation {
    family(1, message)
}

/// Invariant 2: no fee above the cap.
fn fee(message: impl Into<String>) -> Violation {
    family(2, message)
}

/// Invariant 3: no change to Script-bound data; Policy fields change only by an applied change.
fn bound(message: impl Into<String>) -> Violation {
    family(3, message)
}

impl Violation {
    fn name(&self) -> &'static str {
        match self.family {
            1 => "no signature outside Policy",
            2 => "no fee above the cap",
            _ => "no change to Script-bound data",
        }
    }
}

/// The Script-bound data of a Vault: fixed for its whole life.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ScriptBound {
    owner_key: String,
    cosigner_pubkeys: Option<KeyPair>,
    addresses: Option<KeyPair>,
    guardians: Vec<Guardian>,
    escape_timelock_blocks: u32,
    btc_network: BtcNetwork,
    watcher_x25519_pk: String,
}

impl ScriptBound {
    fn of(vault: &Vault) -> Self {
        Self {
            owner_key: vault.owner_key.clone(),
            cosigner_pubkeys: vault.cosigner_pubkeys.clone(),
            addresses: vault.addresses.clone(),
            guardians: vault.policy.guardians.clone(),
            escape_timelock_blocks: vault.policy.escape_timelock_blocks,
            btc_network: vault.policy.btc_network,
            watcher_x25519_pk: vault.policy.watcher_x25519_pk.clone(),
        }
    }

    fn changed_fields(&self, now: &Self) -> Vec<&'static str> {
        let mut changed = Vec::new();
        let mut note = |differs: bool, name| {
            if differs {
                changed.push(name);
            }
        };
        note(self.owner_key != now.owner_key, "owner_key");
        note(
            self.cosigner_pubkeys != now.cosigner_pubkeys,
            "cosigner_pubkeys",
        );
        note(self.addresses != now.addresses, "addresses");
        note(self.guardians != now.guardians, "guardians");
        note(
            self.escape_timelock_blocks != now.escape_timelock_blocks,
            "escape_timelock_blocks",
        );
        note(self.btc_network != now.btc_network, "btc_network");
        note(
            self.watcher_x25519_pk != now.watcher_x25519_pk,
            "watcher_x25519_pk",
        );
        changed
    }
}

fn policy_fields_changed(was: &Policy, now: &Policy) -> Vec<&'static str> {
    let mut changed = Vec::new();
    let mut note = |differs: bool, name| {
        if differs {
            changed.push(name);
        }
    };
    note(was.delay_ns != now.delay_ns, "delay_ns");
    note(
        was.policy_change_delay_ns != now.policy_change_delay_ns,
        "policy_change_delay_ns",
    );
    note(
        was.recovery_address != now.recovery_address,
        "recovery_address",
    );
    note(
        was.allowance_limit_sats != now.allowance_limit_sats,
        "allowance_limit_sats",
    );
    note(was.fee_cap_sats != now.fee_cap_sats, "fee_cap_sats");
    note(was.fast_approval != now.fast_approval, "fast_approval");
    note(
        was.fast_approval_floor_ns != now.fast_approval_floor_ns,
        "fast_approval_floor_ns",
    );
    changed
}

/// A whitelisted field with its proposed value.
#[derive(Clone, Debug)]
enum Proposed {
    Delay(u64),
    Recovery(String),
    Limit(u64),
    FeeCap(u64),
    ChangeDelay(u64),
    Fast(bool),
    Floor(u64),
}

impl Proposed {
    fn apply(&self, policy: &mut Policy) {
        match self {
            Self::Delay(v) => policy.delay_ns = U64(*v),
            Self::Recovery(v) => policy.recovery_address = v.clone(),
            Self::Limit(v) => policy.allowance_limit_sats = U64(*v),
            Self::FeeCap(v) => policy.fee_cap_sats = U64(*v),
            Self::ChangeDelay(v) => policy.policy_change_delay_ns = U64(*v),
            Self::Fast(v) => policy.fast_approval = *v,
            Self::Floor(v) => policy.fast_approval_floor_ns = U64(*v),
        }
    }
}

#[derive(Clone, Debug)]
struct ModelChange {
    id: u64,
    fields: Vec<Proposed>,
    effective_at: u64,
}

struct ModelVault {
    owner: String,
    guardians: Vec<String>,
    policy: Policy,
    closed: bool,
    pending: Option<ModelChange>,
    script_bound: ScriptBound,
    vault_script: Vec<u8>,
    allowance_script: Vec<u8>,
    vault_address: String,
    allowance_address: String,
}

impl ModelVault {
    fn witness_script(&self, source: SpendSource) -> &[u8] {
        match source {
            SpendSource::Vault => &self.vault_script,
            SpendSource::Allowance => &self.allowance_script,
        }
    }
}

#[derive(Clone, Debug)]
struct Frozen {
    tx_hex: String,
    sighashes: Vec<String>,
}

#[derive(Clone, Debug)]
struct ModelOp {
    vault: u64,
    kind: SpendOpKind,
    source: SpendSource,
    state: SpendOpState,
    created_at: u64,
    /// The amount the caller asked to pay (withdrawals and allowance spends).
    amount: u64,
    destination: String,
    /// The coins exactly as the caller passed them, with the values it claimed.
    utxos: Vec<Outpoint>,
    /// The Delay in effect when the withdrawal was requested.
    delay_at_request: u64,
    frozen: Option<Frozen>,
    signed: Vec<bool>,
}

impl ModelOp {
    fn new(vault: u64, kind: SpendOpKind, source: SpendSource, now: u64) -> Self {
        Self {
            vault,
            kind,
            source,
            state: SpendOpState::Frozen,
            created_at: now,
            amount: 0,
            destination: String::new(),
            utxos: Vec::new(),
            delay_at_request: 0,
            frozen: None,
            signed: Vec::new(),
        }
    }

    fn executable_at(&self) -> u64 {
        self.created_at.saturating_add(self.delay_at_request)
    }
}

const fn kind_index(kind: SpendOpKind) -> usize {
    match kind {
        SpendOpKind::Withdrawal => 0,
        SpendOpKind::Allowance => 1,
        SpendOpKind::Refresh => 2,
        SpendOpKind::Clawback => 3,
    }
}

const KIND_NAMES: [&str; 4] = ["withdrawal", "allowance", "refresh", "clawback"];

#[derive(Clone, Debug, Default)]
struct Stats {
    steps: u64,
    refusals: u64,
    freezes: [u64; 4],
    sign_requests: [u64; 4],
    signatures_stored: u64,
    changes_applied: u64,
    changes_stopped: u64,
    /// Refusals by error code (`ERR_…`, or the panic text if it has none).
    refused_with: BTreeMap<String, u64>,
}

impl Stats {
    fn add(&mut self, other: &Self) {
        self.steps += other.steps;
        self.refusals += other.refusals;
        for i in 0..4 {
            self.freezes[i] += other.freezes[i];
            self.sign_requests[i] += other.sign_requests[i];
        }
        self.signatures_stored += other.signatures_stored;
        self.changes_applied += other.changes_applied;
        self.changes_stopped += other.changes_stopped;
        for (code, n) in &other.refused_with {
            *self.refused_with.entry(code.clone()).or_default() += n;
        }
    }

    fn refusals_line(&self) -> String {
        let mut codes: Vec<_> = self.refused_with.iter().collect();
        codes.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let codes: Vec<String> = codes.iter().map(|(c, n)| format!("{c} {n}")).collect();
        format!("Refusals: {}", codes.join(", "))
    }

    fn line(&self) -> String {
        let per_kind = |counts: &[u64; 4]| {
            KIND_NAMES
                .iter()
                .zip(counts)
                .map(|(name, n)| format!("{n} {name}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        format!(
            "Coverage: {} steps, {} refusals; frozen: {}; sign requests: {}; {} signatures stored; {} Policy Changes applied, {} vetoed or withdrawn",
            self.steps,
            self.refusals,
            per_kind(&self.freezes),
            per_kind(&self.sign_requests),
            self.signatures_stored,
            self.changes_applied,
            self.changes_stopped,
        )
    }
}

/// One MPC `sign` call the contract scheduled.
#[derive(Clone, Debug)]
struct SignRequest {
    receiver: String,
    payload: String,
    path: String,
}

fn scheduled_sign_requests() -> Vec<SignRequest> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.to_string();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::FunctionCallWeight {
                        method_name, args, ..
                    } if method_name == b"sign" => {
                        let args: Value = near_sdk::serde_json::from_slice(&args).ok()?;
                        let request = &args["request"];
                        Some(SignRequest {
                            receiver: receiver.clone(),
                            payload: request["payload_v2"]["Ecdsa"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                            path: request["path"].as_str().unwrap_or_default().to_string(),
                        })
                    }
                    _ => None,
                })
        })
        .collect()
}

fn no_sign_requests(requests: &[SignRequest], method: &str) -> Checked {
    if requests.is_empty() {
        Ok(())
    } else {
        Err(signature(format!(
            "{method} scheduled MPC sign requests {requests:?}; only sign_input may"
        )))
    }
}

thread_local! {
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

/// Refused calls panic by design; keep them off the console. Other panics still print.
fn install_quiet_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                previous(info);
            }
        }));
    });
}

/// The unit-test VM and fee configs are rebuilt from the protocol parameter tables on every
/// call, which costs more than a contract call; build each once per thread.
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    thread_local! {
        static CACHE: RefCell<HashMap<std::any::TypeId, Box<dyn std::any::Any>>> =
            RefCell::new(HashMap::new());
    }
    CACHE.with(|cache| {
        cache
            .borrow_mut()
            .entry(std::any::TypeId::of::<T>())
            .or_insert_with(|| Box::new(make()))
            .downcast_ref::<T>()
            .expect("one value per type")
            .clone()
    })
}

/// Starts a new call context on the current storage.
fn next_call(caller: &str, now: u64, deposit: NearToken) {
    let storage = near_sdk::mock::with_mocked_blockchain(|chain| chain.take_storage());
    install_chain(caller, now, deposit, storage);
}

fn install_chain(caller: &str, now: u64, deposit: NearToken, storage: HashMap<Vec<u8>, Vec<u8>>) {
    let context = VMContextBuilder::new()
        .predecessor_account_id(caller.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(now)
        .build();
    env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        context,
        cached(near_sdk::test_vm_config),
        cached(near_sdk::RuntimeFeesConfig::test),
        vec![],
        storage,
        Default::default(),
        None,
    ));
}

fn derived(byte: u8) -> String {
    let mut point = [byte; 64];
    point[63] = 1;
    format!("secp256k1:{}", bs58::encode(point).into_string())
}

// ---------------------------------------------------------------------------------------------
// The harness: runs actions against the real contract and checks the invariants.

struct Harness {
    contract: VaultContract,
    now: u64,
    pool: Vec<u64>,
    vaults: BTreeMap<u64, ModelVault>,
    ops: BTreeMap<u64, ModelOp>,
    /// Vetoed or withdrawn changes: never to be applied.
    stopped: BTreeSet<u64>,
    stats: Stats,
}

impl Harness {
    fn new(setup: &Setup) -> Self {
        install_chain(
            "deployer.testnet",
            NOW,
            NearToken::from_yoctonear(0),
            HashMap::new(),
        );
        let mut contract = VaultContract::new(
            SIGNER.parse().unwrap(),
            vec![
                BtcNetwork::Regtest,
                BtcNetwork::Signet,
                BtcNetwork::Testnet4,
            ],
            vec![],
        );
        next_call(OWNER, NOW, MIN_VAULT_STORAGE);
        let main = create(
            &mut contract,
            Policy {
                allowance_limit_sats: U64(setup.allowance_limit),
                fee_cap_sats: U64(setup.fee_cap),
                ..standard_policy()
            },
        );
        contract.on_keys_derived(main, Ok(derived(0x11)), Ok(derived(0x55)));
        next_call(OTHER_OWNER, NOW, MIN_VAULT_STORAGE);
        let other = create(
            &mut contract,
            Policy {
                guardians: vec![guardian("66", OTHER_GUARDIAN, GuardianKind::AutoClawback)],
                ..standard_policy()
            },
        );
        contract.on_keys_derived(other, Ok(derived(0x11)), Ok(derived(0x55)));
        assert_eq!((main.0, other.0), (MAIN, OTHER));

        let mut vaults = BTreeMap::new();
        for id in [MAIN, OTHER] {
            let vault = contract.get_vault(U64(id));
            let kit = contract.get_vault_kit(U64(id));
            let addresses = vault
                .addresses
                .clone()
                .expect("an active Vault has addresses");
            let vault_script = decode_hex(&kit.vault_script_hex).unwrap();
            let allowance_script = decode_hex(&kit.allowance_script_hex).unwrap();
            // The scripts the checker signs with are the ones the addresses commit to.
            assert_eq!(signet_script(&addresses.vault), Some(p2wsh(&vault_script)));
            assert_eq!(
                signet_script(&addresses.allowance),
                Some(p2wsh(&allowance_script))
            );
            vaults.insert(
                id,
                ModelVault {
                    owner: vault.owner_account.to_string(),
                    guardians: vault
                        .policy
                        .guardians
                        .iter()
                        .map(|g| g.guardian_account.to_string())
                        .collect(),
                    policy: vault.policy.clone(),
                    closed: false,
                    pending: None,
                    script_bound: ScriptBound::of(&vault),
                    vault_script,
                    allowance_script,
                    vault_address: addresses.vault,
                    allowance_address: addresses.allowance,
                },
            );
        }
        Self {
            contract,
            now: NOW,
            pool: setup.pool.clone(),
            vaults,
            ops: BTreeMap::new(),
            stopped: BTreeSet::new(),
            stats: Stats::default(),
        }
    }

    /// Runs every step and checks the invariants after each. On a violation returns its step
    /// (1-based; 0 is the setup) and the violation.
    fn run(&mut self, steps: &[Action]) -> Result<(), (usize, Violation)> {
        self.check_state().map_err(|v| (0, v))?;
        for (i, action) in steps.iter().enumerate() {
            self.stats.steps += 1;
            self.step(action)
                .and_then(|()| self.check_state())
                .map_err(|v| (i + 1, v))?;
        }
        Ok(())
    }

    /// One contract call as its own receipt: state persisted before, rolled back on a panic.
    /// Returns the call's value and the MPC sign requests it scheduled, or the refusal message.
    fn call<R>(
        &mut self,
        caller: &str,
        deposit: NearToken,
        f: impl FnOnce(&mut VaultContract) -> R,
    ) -> Result<(R, Vec<SignRequest>), String> {
        // Persist the previous call (NEAR writes state when a method returns) and start from a
        // freshly loaded contract, as every NEAR call does.
        self.contract.flush_all();
        let saved = near_sdk::borsh::to_vec(&self.contract).expect("the state serializes");
        self.contract = near_sdk::borsh::from_slice(&saved).expect("the state deserializes");
        let storage = near_sdk::mock::with_mocked_blockchain(|chain| chain.take_storage());
        install_chain(caller, self.now, deposit, storage.clone());

        QUIET.with(|quiet| quiet.set(true));
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| f(&mut self.contract)));
        QUIET.with(|quiet| quiet.set(false));
        match outcome {
            Ok(value) => Ok((value, scheduled_sign_requests())),
            Err(payload) => {
                // The failed call's writes are discarded: drop its contract (whose collections
                // flush into the failed call's storage) and restore the storage from before.
                let restored = near_sdk::borsh::from_slice(&saved).expect("the state deserializes");
                drop(std::mem::replace(&mut self.contract, restored));
                install_chain(caller, self.now, NearToken::from_yoctonear(0), storage);
                self.stats.refusals += 1;
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_default();
                *self
                    .stats
                    .refused_with
                    .entry(error_code(&message))
                    .or_default() += 1;
                Err(message)
            }
        }
    }

    // Argument resolution.

    fn coin(&self, coin: Coin) -> Outpoint {
        let n = coin.n % POOL_SIZE as u8;
        Outpoint {
            txid: format!("{:02x}", n + 1).repeat(32),
            vout: u32::from(n % 2),
            value_sats: U64(match coin.value {
                CoinValue::Pool => self.pool[usize::from(n)],
                CoinValue::Zero => 0,
                CoinValue::BelowDust => 545,
                CoinValue::Max => u64::MAX,
                CoinValue::Sats(sats) => sats,
            }),
        }
    }

    fn utxos(&self, utxos: &Utxos) -> Vec<Outpoint> {
        let pool = |n: u8| Coin {
            n,
            value: CoinValue::Pool,
        };
        match utxos {
            Utxos::Coins(coins) => coins.iter().map(|c| self.coin(*c)).collect(),
            Utxos::Empty => vec![],
            Utxos::Six => (0..6).map(|n| self.coin(pool(n))).collect(),
            Utxos::Duplicate(coin) => vec![self.coin(*coin), self.coin(*coin)],
            Utxos::FakeTxid(byte) => {
                let mut fake = self.coin(pool(byte % POOL_SIZE as u8));
                fake.txid = match byte % 3 {
                    0 => "AB".repeat(32),
                    1 => "ab".repeat(31),
                    _ => "zz".repeat(32),
                };
                vec![fake]
            }
        }
    }

    /// The rolling 24-hour allowance total of a Vault, from the model.
    fn window(&self, vault: u64) -> u128 {
        let since = self.now.saturating_sub(DAY_NS);
        self.ops
            .values()
            .filter(|m| {
                m.vault == vault
                    && m.kind == SpendOpKind::Allowance
                    && matches!(m.state, SpendOpState::Frozen | SpendOpState::Signed)
                    && m.created_at > since
            })
            .map(|m| u128::from(m.amount))
            .sum()
    }

    fn amount(&self, amount: Amount, vault: u64, utxos: &[Outpoint]) -> u64 {
        let limit = self
            .vaults
            .get(&vault)
            .map_or(0, |v| v.policy.allowance_limit_sats.0);
        let remaining =
            u64::try_from(u128::from(limit).saturating_sub(self.window(vault))).unwrap_or(u64::MAX);
        let total: u128 = utxos.iter().map(|u| u128::from(u.value_sats.0)).sum();
        match amount {
            Amount::Zero => 0,
            Amount::BelowDust => 545,
            Amount::Dust => 546,
            Amount::LimitMinus1 => limit.saturating_sub(1),
            Amount::Limit => limit,
            Amount::LimitPlus1 => limit.saturating_add(1),
            Amount::RemainingMinus1 => remaining.saturating_sub(1),
            Amount::Remaining => remaining,
            Amount::RemainingPlus1 => remaining.saturating_add(1),
            Amount::Max => u64::MAX,
            Amount::Share(percent) => {
                u64::try_from(total * u128::from(percent) / 100).unwrap_or(u64::MAX)
            }
            Amount::Sats(sats) => sats,
        }
    }

    fn dest(&self, dest: Dest, vault: u64) -> String {
        let own = self.vaults.get(&vault);
        match dest {
            Dest::Main => DESTINATION.to_string(),
            Dest::Taproot => TAPROOT_SIGNET.to_string(),
            Dest::Wsh => WSH_SIGNET.to_string(),
            Dest::Recovery => RECOVERY_SIGNET.to_string(),
            Dest::OwnVault => own.map_or(DESTINATION.to_string(), |v| v.vault_address.clone()),
            Dest::OwnAllowance => {
                own.map_or(DESTINATION.to_string(), |v| v.allowance_address.clone())
            }
            Dest::Mainnet => MAINNET.to_string(),
            Dest::Regtest => REGTEST.to_string(),
            Dest::BadChecksum => BAD_CHECKSUM.to_string(),
            Dest::Garbage => "not an address".to_string(),
        }
    }

    /// An op id: usually one the model knows (preferring those `prefer` picks), sometimes any
    /// id, including unknown ones.
    fn pick_op(&self, pick: u8, prefer: impl Fn(&ModelOp) -> bool) -> u64 {
        let preferred: Vec<u64> = self
            .ops
            .iter()
            .filter(|(_, m)| prefer(m))
            .map(|(id, _)| *id)
            .collect();
        let known: Vec<u64> = self.ops.keys().copied().collect();
        match pick {
            0..=159 if !preferred.is_empty() => preferred[usize::from(pick) % preferred.len()],
            0..=219 if !known.is_empty() => known[usize::from(pick) % known.len()],
            _ => u64::from(pick) % (self.contract.next_op_id + 2),
        }
    }

    fn pick_change(&self, pick: u8) -> u64 {
        let pending: Vec<u64> = self
            .vaults
            .values()
            .filter_map(|v| v.pending.as_ref().map(|c| c.id))
            .collect();
        let known: Vec<u64> = pending.iter().chain(&self.stopped).copied().collect();
        match pick {
            0..=179 if !pending.is_empty() => pending[usize::from(pick) % pending.len()],
            0..=229 if !known.is_empty() => known[usize::from(pick) % known.len()],
            _ => u64::from(pick) % (self.contract.next_change_id + 2),
        }
    }

    fn change(&self, change: &Change, vault: u64) -> (Value, Vec<Proposed>, Option<String>) {
        let Change::Fields(fields) = change else {
            return (json!(["delay_ns"]), vec![], Some("a non-object".into()));
        };
        let mut map = Map::new();
        let mut proposed = Vec::new();
        // A later field with the same key replaces an earlier one, as in the JSON object.
        let mut refused: BTreeMap<&str, String> = BTreeMap::new();
        let number = |v: u64| Value::String(v.to_string());
        for field in fields {
            let (key, value, typed) = match field {
                Field::Delay(v) => ("delay_ns", number(*v), Some(Proposed::Delay(*v))),
                Field::Recovery(dest) => {
                    let address = self.dest(*dest, vault);
                    (
                        "recovery_address",
                        Value::String(address.clone()),
                        Some(Proposed::Recovery(address)),
                    )
                }
                Field::Limit(v) => (
                    "allowance_limit_sats",
                    number(*v),
                    Some(Proposed::Limit(*v)),
                ),
                Field::FeeCap(v) => ("fee_cap_sats", number(*v), Some(Proposed::FeeCap(*v))),
                Field::ChangeDelay(v) => (
                    "policy_change_delay_ns",
                    number(*v),
                    Some(Proposed::ChangeDelay(*v)),
                ),
                Field::Fast(v) => ("fast_approval", Value::Bool(*v), Some(Proposed::Fast(*v))),
                Field::Floor(v) => (
                    "fast_approval_floor_ns",
                    number(*v),
                    Some(Proposed::Floor(*v)),
                ),
                Field::ScriptBound(i) => {
                    let key = SCRIPT_BOUND_KEYS[*i];
                    refused.insert(key, format!("Script-bound field {key}"));
                    (key, json!([STRANGER]), None)
                }
                Field::NonCanonical(i) => {
                    let (key, raw) = NON_CANONICAL[*i];
                    refused.insert(key, format!("{key} as {raw:?}"));
                    (key, Value::String(raw.to_string()), None)
                }
            };
            if typed.is_some() {
                refused.remove(key);
            }
            map.insert(key.to_string(), value);
            proposed.extend(typed);
        }
        (Value::Object(map), proposed, refused.into_values().next())
    }

    // Steps.

    fn step(&mut self, action: &Action) -> Checked {
        let zero = NearToken::from_yoctonear(0);
        match action {
            Action::Request {
                who,
                vault,
                amount,
                dest,
                rate,
                utxos,
                env,
            } => {
                let (vault_id, caller) = (vault.id(), who.account());
                let utxos = self.utxos(utxos);
                let amount = self.amount(*amount, vault_id, &utxos);
                let destination = self.dest(*dest, vault_id);
                let (coins, to, envelope) = (utxos.clone(), destination.clone(), env.text());
                let Ok((op_id, requests)) = self.call(caller, zero, |c| {
                    c.request_withdrawal(
                        U64(vault_id),
                        U64(amount),
                        to,
                        rate.sat_vb(),
                        coins,
                        envelope,
                    )
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "request_withdrawal")?;
                self.owner_call_allowed(vault_id, caller, *env, "request_withdrawal")?;
                self.fresh_op(op_id.0)?;
                let delay = self.vaults[&vault_id].policy.delay_ns.0;
                self.ops.insert(
                    op_id.0,
                    ModelOp {
                        state: SpendOpState::Pending,
                        amount,
                        destination,
                        utxos,
                        delay_at_request: delay,
                        ..ModelOp::new(
                            vault_id,
                            SpendOpKind::Withdrawal,
                            SpendSource::Vault,
                            self.now,
                        )
                    },
                );
                Ok(())
            }
            Action::Execute { who, op, env } => {
                let op_id = self.pick_op(*op, |m| {
                    m.kind == SpendOpKind::Withdrawal && m.state == SpendOpState::Pending
                });
                let (caller, envelope) = (who.account(), env.text());
                let before = self.ops.get(&op_id).cloned();
                let Ok((op, requests)) =
                    self.call(caller, zero, |c| c.begin_execute(U64(op_id), envelope))
                else {
                    return Ok(());
                };
                no_sign_requests(&requests, "begin_execute")?;
                let m = before.ok_or_else(|| {
                    signature(format!(
                        "begin_execute froze op {op_id}, which was never requested"
                    ))
                })?;
                if m.kind != SpendOpKind::Withdrawal {
                    return Err(signature(format!(
                        "begin_execute accepted a {:?} op",
                        m.kind
                    )));
                }
                self.owner_call_allowed(m.vault, caller, *env, "begin_execute")?;
                match m.state {
                    SpendOpState::Pending => {
                        let executable_at = m.executable_at();
                        if self.now < executable_at {
                            return Err(signature(format!(
                                "withdrawal {op_id} frozen at {}, {} ns before executable_at {executable_at} (requested at {} with a Delay of {} ns)",
                                self.now,
                                executable_at - self.now,
                                m.created_at,
                                m.delay_at_request
                            )));
                        }
                        self.freeze(op_id, &op, m)
                    }
                    SpendOpState::Frozen | SpendOpState::Signed => {
                        let frozen = m.frozen.as_ref().expect("a frozen model op has its tx");
                        if op.unsigned_tx_hex.as_deref() != Some(frozen.tx_hex.as_str()) {
                            return Err(signature(format!(
                                "begin_execute rebuilt the frozen withdrawal {op_id}"
                            )));
                        }
                        Ok(())
                    }
                    state => Err(signature(format!(
                        "begin_execute froze withdrawal {op_id} in state {state:?}"
                    ))),
                }
            }
            Action::Sign { who, op, input } => self.sign(*who, *op, *input),
            Action::Cancel { who, op, env } => {
                let op_id = self.pick_op(*op, |m| !m.state.is_terminal());
                let envelope = env.map(Env::text);
                let Ok(((), requests)) =
                    self.call(who.account(), zero, |c| c.cancel(U64(op_id), envelope))
                else {
                    return Ok(());
                };
                no_sign_requests(&requests, "cancel")?;
                let m = self
                    .ops
                    .get_mut(&op_id)
                    .ok_or_else(|| signature(format!("cancel succeeded on unknown op {op_id}")))?;
                m.state = SpendOpState::Cancelled;
                Ok(())
            }
            Action::Refresh {
                who,
                vault,
                utxos,
                rate,
                env,
                source,
            } => {
                let (vault_id, caller) = (vault.id(), who.account());
                let utxos = self.utxos(utxos);
                let (coins, envelope, source) = (utxos.clone(), env.text(), *source);
                let Ok((op, requests)) = self.call(caller, zero, |c| {
                    c.refresh(U64(vault_id), coins, rate.sat_vb(), envelope, source)
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "refresh")?;
                self.owner_call_allowed(vault_id, caller, *env, "refresh")?;
                self.fresh_op(op.op_id.0)?;
                let source = source.unwrap_or_default();
                let m = ModelOp {
                    utxos,
                    ..ModelOp::new(vault_id, SpendOpKind::Refresh, source, self.now)
                };
                self.freeze(op.op_id.0, &op, m)
            }
            Action::Allowance {
                who,
                vault,
                amount,
                dest,
                rate,
                utxos,
                env,
            } => {
                let (vault_id, caller) = (vault.id(), who.account());
                let utxos = self.utxos(utxos);
                let amount = self.amount(*amount, vault_id, &utxos);
                let destination = self.dest(*dest, vault_id);
                let (coins, to, envelope) = (utxos.clone(), destination.clone(), env.text());
                let Ok((op, requests)) = self.call(caller, zero, |c| {
                    c.spend_allowance(
                        U64(vault_id),
                        U64(amount),
                        to,
                        rate.sat_vb(),
                        coins,
                        envelope,
                    )
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "spend_allowance")?;
                self.owner_call_allowed(vault_id, caller, *env, "spend_allowance")?;
                self.fresh_op(op.op_id.0)?;
                let limit = self.vaults[&vault_id].policy.allowance_limit_sats.0;
                let window = self.window(vault_id) + u128::from(amount);
                if limit == 0 || window > u128::from(limit) {
                    return Err(signature(format!(
                        "allowance spend of {amount} frozen with a rolling 24 h total of {window} over the limit {limit}"
                    )));
                }
                let m = ModelOp {
                    amount,
                    destination,
                    utxos,
                    ..ModelOp::new(
                        vault_id,
                        SpendOpKind::Allowance,
                        SpendSource::Allowance,
                        self.now,
                    )
                };
                self.freeze(op.op_id.0, &op, m)
            }
            Action::Clawback {
                who,
                vault,
                utxos,
                rate,
                source,
            } => {
                let (vault_id, caller) = (vault.id(), who.account());
                let utxos = self.utxos(utxos);
                let (coins, source) = (utxos.clone(), *source);
                let Ok((op_id, requests)) = self.call(caller, zero, |c| {
                    c.begin_clawback(U64(vault_id), coins, rate.sat_vb(), source)
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "begin_clawback")?;
                let v = self.vaults.get(&vault_id).ok_or_else(|| {
                    signature(format!(
                        "begin_clawback succeeded on unknown Vault {vault_id}"
                    ))
                })?;
                if !v.guardians.iter().any(|g| g == caller) {
                    return Err(signature(format!(
                        "begin_clawback on Vault {vault_id} by {caller}, not one of its Guardians"
                    )));
                }
                self.fresh_op(op_id.0)?;
                let op = self.contract.get_op(op_id);
                let source = source.unwrap_or_default();
                let m = ModelOp {
                    destination: v.policy.recovery_address.clone(),
                    utxos,
                    ..ModelOp::new(vault_id, SpendOpKind::Clawback, source, self.now)
                };
                // The tx is checked against the Policy in effect at the Clawback.
                self.freeze(op_id.0, &op, m)?;
                for m in self.ops.values_mut() {
                    if m.vault == vault_id
                        && m.kind != SpendOpKind::Clawback
                        && !m.state.is_terminal()
                    {
                        m.state = SpendOpState::Voided;
                    }
                }
                let v = self.vaults.get_mut(&vault_id).expect("checked above");
                v.closed = true;
                if let Some(change) = v.pending.take() {
                    self.stopped.insert(change.id);
                    self.stats.changes_stopped += 1;
                }
                Ok(())
            }
            Action::Propose {
                who,
                vault,
                change,
                env,
            } => {
                let (vault_id, caller) = (vault.id(), who.account());
                let (changes, proposed, refused) = self.change(change, vault_id);
                let envelope = env.text();
                let Ok((change_id, requests)) = self.call(caller, zero, |c| {
                    c.propose_policy_change(U64(vault_id), changes, envelope)
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "propose_policy_change")?;
                if let Some(refused) = refused {
                    return Err(bound(format!(
                        "a Policy Change with {refused} was accepted"
                    )));
                }
                let now = self.now;
                let v = self.vaults.get_mut(&vault_id).ok_or_else(|| {
                    bound(format!(
                        "a Policy Change was accepted for unknown Vault {vault_id}"
                    ))
                })?;
                if caller != v.owner || *env != Env::Valid || v.closed {
                    return Err(bound(format!(
                        "a Policy Change on Vault {vault_id} was accepted from {caller} with envelope {env:?} (closed: {})",
                        v.closed
                    )));
                }
                if let Some(pending) = &v.pending {
                    return Err(bound(format!(
                        "change {} was accepted while change {} is pending",
                        change_id.0, pending.id
                    )));
                }
                v.pending = Some(ModelChange {
                    id: change_id.0,
                    fields: proposed,
                    effective_at: now.saturating_add(v.policy.policy_change_delay_ns.0),
                });
                Ok(())
            }
            Action::Veto { who, change, env } => {
                let change_id = self.pick_change(*change);
                let envelope = env.map(Env::text);
                let Ok(((), requests)) = self.call(who.account(), zero, |c| {
                    c.veto_policy_change(U64(change_id), envelope)
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "veto_policy_change")?;
                for v in self.vaults.values_mut() {
                    if v.pending.as_ref().is_some_and(|c| c.id == change_id) {
                        v.pending = None;
                        self.stopped.insert(change_id);
                        self.stats.changes_stopped += 1;
                    }
                }
                Ok(())
            }
            Action::Apply { who, change } => {
                let change_id = self.pick_change(*change);
                let Ok(((), requests)) = self.call(who.account(), zero, |c| {
                    c.apply_policy_change(U64(change_id))
                }) else {
                    return Ok(());
                };
                no_sign_requests(&requests, "apply_policy_change")?;
                let now = self.now;
                let stopped = self.stopped.contains(&change_id);
                let v = self
                    .vaults
                    .values_mut()
                    .find(|v| v.pending.as_ref().is_some_and(|c| c.id == change_id))
                    .ok_or_else(|| {
                        bound(format!(
                            "change {change_id} was applied, but it was {}",
                            if stopped {
                                "vetoed or withdrawn"
                            } else {
                                "never pending"
                            }
                        ))
                    })?;
                let change = v.pending.take().expect("found above");
                if now < change.effective_at {
                    return Err(bound(format!(
                        "change {change_id} applied at {now}, {} ns before effective_at {}",
                        change.effective_at - now,
                        change.effective_at
                    )));
                }
                for field in &change.fields {
                    field.apply(&mut v.policy);
                }
                self.stats.changes_applied += 1;
                Ok(())
            }
            Action::TopUp {
                who,
                vault,
                deposit,
            } => {
                let deposit = match deposit {
                    0 => NearToken::from_yoctonear(0),
                    1 => NearToken::from_yoctonear(1),
                    _ => NearToken::from_millinear(100),
                };
                let vault_id = vault.id();
                if let Ok(((), requests)) =
                    self.call(who.account(), deposit, |c| c.top_up_storage(U64(vault_id)))
                {
                    no_sign_requests(&requests, "top_up_storage")?;
                }
                Ok(())
            }
            Action::Advance(time) => {
                let target = match *time {
                    Time::Zero => self.now,
                    Time::OneNano => self.now + 1,
                    Time::ExecutableAt(pick, offset) => {
                        let pending: Vec<u64> = self
                            .ops
                            .values()
                            .filter(|m| {
                                m.kind == SpendOpKind::Withdrawal
                                    && m.state == SpendOpState::Pending
                            })
                            .map(ModelOp::executable_at)
                            .collect();
                        if pending.is_empty() {
                            self.now
                        } else {
                            offset_by(pending[usize::from(pick) % pending.len()], offset)
                        }
                    }
                    Time::EffectiveAt(offset) => self.vaults[&MAIN]
                        .pending
                        .as_ref()
                        .map_or(self.now, |c| offset_by(c.effective_at, offset)),
                    Time::Delay => self.now + self.vaults[&MAIN].policy.delay_ns.0,
                    Time::Day => self.now + DAY_NS,
                    Time::Random(ns) => self.now + ns,
                };
                // Time never runs backwards.
                self.now = self.now.max(target);
                Ok(())
            }
            Action::Plant(Plant::ExecutableAtOneNanoEarlier(pick)) => {
                let op_id = self.pick_op(*pick, |m| {
                    m.kind == SpendOpKind::Withdrawal && m.state == SpendOpState::Pending
                });
                if let Some(op) = self.contract.ops.get_mut(&op_id) {
                    op.executable_at = op.executable_at.map(|t| U64(t.0 - 1));
                }
                Ok(())
            }
        }
    }

    /// An Owner method succeeded: it must have come from the Vault's Owner, with a valid
    /// envelope, on an open Vault.
    fn owner_call_allowed(&self, vault_id: u64, caller: &str, env: Env, method: &str) -> Checked {
        let v = self
            .vaults
            .get(&vault_id)
            .ok_or_else(|| signature(format!("{method} succeeded on unknown Vault {vault_id}")))?;
        if caller != v.owner || env != Env::Valid || v.closed {
            return Err(signature(format!(
                "{method} on Vault {vault_id} succeeded for {caller} with envelope {env:?} (closed: {})",
                v.closed
            )));
        }
        Ok(())
    }

    fn fresh_op(&self, op_id: u64) -> Checked {
        if self.ops.contains_key(&op_id) {
            return Err(signature(format!("op id {op_id} was reused")));
        }
        Ok(())
    }

    /// A new freeze: checks the transaction against the Policy in effect now, then records it.
    fn freeze(&mut self, op_id: u64, op: &SpendOp, mut m: ModelOp) -> Checked {
        if op.kind != m.kind || op.source != m.source || op.vault_id.0 != m.vault {
            return Err(signature(format!(
                "op {op_id} was frozen as a {:?} {:?} op of Vault {}, but the call made a {:?} {:?} op of Vault {}",
                op.kind, op.source, op.vault_id.0, m.kind, m.source, m.vault
            )));
        }
        let tx_hex = op
            .unsigned_tx_hex
            .clone()
            .ok_or_else(|| signature(format!("frozen op {op_id} has no transaction")))?;
        let tx = parse_tx(&tx_hex)
            .ok_or_else(|| signature(format!("frozen op {op_id}: transaction does not decode")))?;
        let v = &self.vaults[&m.vault];
        check_tx(&tx, &op.sighashes, &m, v, &v.policy)?;
        m.state = SpendOpState::Frozen;
        m.signed = vec![false; m.utxos.len()];
        m.frozen = Some(Frozen {
            tx_hex,
            sighashes: op.sighashes.clone(),
        });
        self.stats.freezes[kind_index(m.kind)] += 1;
        self.ops.insert(op_id, m);
        Ok(())
    }

    fn sign(&mut self, who: Who, op: u8, input: u8) -> Checked {
        let op_id = self.pick_op(op, |m| m.state == SpendOpState::Frozen);
        let caller = who.account();
        let before = self.ops.get(&op_id).cloned();
        // Usually one of the op's inputs, sometimes any index up to 6.
        let index = match &before {
            Some(m) if input < 200 && !m.utxos.is_empty() => {
                u32::try_from(usize::from(input) % m.utxos.len()).unwrap()
            }
            _ => u32::from(input % 7),
        };
        let Ok((stored, requests)) = self.call(caller, NearToken::from_yoctonear(0), |c| {
            match c.sign_input(U64(op_id), index) {
                PromiseOrValue::Value(signature) => Some(signature),
                PromiseOrValue::Promise(promise) => {
                    // Dropping the Promise schedules its receipts.
                    drop(promise);
                    None
                }
            }
        }) else {
            return Ok(());
        };
        if stored.is_some() && !requests.is_empty() {
            return Err(signature(
                "sign_input returned a stored signature and also asked the signer",
            ));
        }
        if requests.len() > 1 {
            return Err(signature(format!(
                "one sign_input scheduled {} sign requests",
                requests.len()
            )));
        }
        let Some(request) = requests.first() else {
            return Ok(());
        };
        self.check_sign_request(op_id, index, caller, request, before.as_ref())?;
        let kind = before.as_ref().map_or(0, |m| kind_index(m.kind));
        self.stats.sign_requests[kind] += 1;

        // The MPC network answers with a well-formed signature; the callback stores it.
        let byte = (op_id as u8).wrapping_mul(31).wrapping_add(input) | 1;
        if let Ok((_, more)) = self.call(SELF, NearToken::from_yoctonear(0), |c| {
            c.on_signed(U64(op_id), index, Ok(signing_mpc(byte)))
        }) {
            no_sign_requests(&more, "on_signed")?;
            let m = self
                .ops
                .get_mut(&op_id)
                .expect("checked by check_sign_request");
            m.signed[index as usize] = true;
            if m.signed.iter().all(|s| *s) {
                m.state = SpendOpState::Signed;
            }
            self.stats.signatures_stored += 1;
        }
        Ok(())
    }

    /// Invariant 1 for one MPC sign request scheduled by `sign_input(op_id, index)` from
    /// `caller`, against the model op as it was before the call.
    fn check_sign_request(
        &self,
        op_id: u64,
        index: u32,
        caller: &str,
        request: &SignRequest,
        before: Option<&ModelOp>,
    ) -> Checked {
        if request.receiver != SIGNER {
            return Err(signature(format!(
                "sign request sent to {}, not the MPC signer",
                request.receiver
            )));
        }
        let m = before.ok_or_else(|| {
            signature(format!(
                "sign request for op {op_id}, which was never frozen"
            ))
        })?;
        let frozen = m.frozen.as_ref().ok_or_else(|| {
            signature(format!(
                "sign request for op {op_id} in state {:?}, never legally frozen",
                m.state
            ))
        })?;
        if !matches!(m.state, SpendOpState::Frozen | SpendOpState::Signed) {
            return Err(signature(format!(
                "sign request for op {op_id} in state {:?}",
                m.state
            )));
        }
        let v = &self.vaults[&m.vault];
        let authorised = if m.kind == SpendOpKind::Clawback {
            v.guardians.iter().any(|g| g == caller)
        } else {
            caller == v.owner && !v.closed
        };
        if !authorised {
            return Err(signature(format!(
                "sign request for {:?} op {op_id} triggered by {caller}",
                m.kind
            )));
        }
        let path = format!("morrow/v1/{}/{}", m.vault, m.source.role());
        if request.path != path {
            return Err(signature(format!(
                "sign request for op {op_id} on path {}, not {path}",
                request.path
            )));
        }
        let i = index as usize;
        let utxo = m.utxos.get(i).ok_or_else(|| {
            signature(format!(
                "sign request for input {i} of a {}-input op",
                m.utxos.len()
            ))
        })?;
        let tx = parse_tx(&frozen.tx_hex).expect("decoded when frozen");
        let expected = to_hex(&bip143(
            &tx,
            i,
            v.witness_script(m.source),
            utxo.value_sats.0,
        ));
        if request.payload != expected {
            return Err(signature(format!(
                "sign request for input {i} of op {op_id} carries {}, not its sighash {expected}",
                request.payload
            )));
        }
        Ok(())
    }

    /// Invariants after every step: Script-bound data and the Policy as the model has them, and
    /// every op's state and frozen transaction unchanged behind the model's back.
    fn check_state(&self) -> Checked {
        for (id, v) in &self.vaults {
            let stored = self.contract.get_vault(U64(*id));
            let changed = v.script_bound.changed_fields(&ScriptBound::of(&stored));
            if !changed.is_empty() {
                return Err(bound(format!(
                    "Script-bound data of Vault {id} changed: {}",
                    changed.join(", ")
                )));
            }
            let changed = policy_fields_changed(&v.policy, &stored.policy);
            if !changed.is_empty() {
                return Err(bound(format!(
                    "Policy of Vault {id} changed outside an applied Policy Change: {}",
                    changed.join(", ")
                )));
            }
            let pending = stored.pending_change.as_ref().map(|c| c.change_id.0);
            if pending != v.pending.as_ref().map(|c| c.id) {
                return Err(bound(format!(
                    "Vault {id} has pending change {pending:?}; the model has {:?}",
                    v.pending.as_ref().map(|c| c.id)
                )));
            }
            if (stored.state == VaultState::ClawedBack) != v.closed {
                return Err(signature(format!(
                    "Vault {id} is {:?}; the model has it {}",
                    stored.state,
                    if v.closed { "clawed back" } else { "open" }
                )));
            }
        }
        for (id, m) in &self.ops {
            let stored = self.contract.get_op(U64(*id));
            if stored.state != m.state {
                return Err(signature(format!(
                    "op {id} is {:?}; the model has {:?}",
                    stored.state, m.state
                )));
            }
            if let Some(frozen) = &m.frozen {
                if stored.unsigned_tx_hex.as_deref() != Some(frozen.tx_hex.as_str())
                    || stored.sighashes != frozen.sighashes
                {
                    return Err(signature(format!(
                        "the frozen transaction of op {id} changed"
                    )));
                }
            }
        }
        Ok(())
    }
}

/// The `ERR_…` code of a refusal, or its text when it has none.
fn error_code(message: &str) -> String {
    message
        .find("ERR_")
        .map(|start| {
            message[start..]
                .chars()
                .take_while(|c| c.is_ascii_uppercase() || *c == '_')
                .collect()
        })
        .unwrap_or_else(|| message.to_string())
}

fn offset_by(at: u64, offset: i8) -> u64 {
    match offset {
        -1 => at.saturating_sub(1),
        1 => at.saturating_add(1),
        _ => at,
    }
}

/// Invariants 1 and 2 for a frozen transaction: it spends exactly the op's coins, pays only
/// what the Policy allows for its kind, its fee is within the cap, and every stored sighash is
/// the BIP143 sighash of its input.
fn check_tx(
    tx: &Tx,
    sighashes: &[String],
    m: &ModelOp,
    v: &ModelVault,
    policy: &Policy,
) -> Checked {
    let name = KIND_NAMES[kind_index(m.kind)];
    let same_coins = tx.inputs.len() == m.utxos.len()
        && tx
            .inputs
            .iter()
            .zip(&m.utxos)
            .all(|(input, utxo)| display_txid(input) == utxo.txid && input.vout == utxo.vout);
    if !same_coins {
        return Err(signature(format!(
            "the {name} transaction spends coins other than the op's"
        )));
    }

    let outputs = tx.outputs.as_slice();
    let pays_only_allowed = match m.kind {
        SpendOpKind::Withdrawal | SpendOpKind::Allowance => {
            let destination = signet_script(&m.destination).ok_or_else(|| {
                signature(format!(
                    "the {name} pays {:?}, not a signet address",
                    m.destination
                ))
            })?;
            let change = p2wsh(v.witness_script(m.source));
            let pays = |output: &(u64, Vec<u8>)| *output == (m.amount, destination.clone());
            match outputs {
                [payment] => pays(payment),
                [payment, (_, to)] => pays(payment) && *to == change,
                _ => false,
            }
        }
        SpendOpKind::Refresh => {
            matches!(outputs, [(_, to)] if *to == p2wsh(v.witness_script(m.source)))
        }
        SpendOpKind::Clawback => {
            let recovery = signet_script(&policy.recovery_address).ok_or_else(|| {
                signature("the Recovery Address in effect is not a signet address")
            })?;
            matches!(outputs, [(_, to)] if *to == recovery)
        }
    };
    if !pays_only_allowed {
        return Err(signature(format!(
            "the {name} pays {outputs:?}, outside its Policy (amount {}, destination {:?})",
            m.amount, m.destination
        )));
    }

    let inputs: u128 = m.utxos.iter().map(|u| u128::from(u.value_sats.0)).sum();
    let paid: u128 = outputs.iter().map(|(value, _)| u128::from(*value)).sum();
    let fee_sats = inputs.checked_sub(paid).ok_or_else(|| {
        fee(format!(
            "the {name} pays {paid}, more than its inputs {inputs}"
        ))
    })?;
    let moved = u64::try_from(inputs).unwrap_or(u64::MAX);
    let fee_cap = policy.fee_cap_sats.0;
    let cap = match m.kind {
        SpendOpKind::Withdrawal | SpendOpKind::Allowance => withdrawal_fee_cap(fee_cap, m.amount),
        SpendOpKind::Refresh => withdrawal_fee_cap(fee_cap, moved),
        SpendOpKind::Clawback => clawback_fee_cap(fee_cap, moved),
    };
    if fee_sats > u128::from(cap) {
        return Err(fee(format!(
            "the {name} fee is {fee_sats} sats, over its cap {cap} (Fee Cap {fee_cap})"
        )));
    }

    if sighashes.len() != tx.inputs.len() {
        return Err(signature(format!(
            "the {name} has {} sighashes for {} inputs",
            sighashes.len(),
            tx.inputs.len()
        )));
    }
    let script = v.witness_script(m.source);
    for (i, (stored, utxo)) in sighashes.iter().zip(&m.utxos).enumerate() {
        let expected = to_hex(&bip143(tx, i, script, utxo.value_sats.0));
        if *stored != expected {
            return Err(signature(format!(
                "the {name} stores sighash {stored} for input {i}, not {expected}"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The runner.

fn parse_seed(raw: Option<&str>) -> Result<u64, String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_SEED);
    };
    let digits = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(raw);
    let valid =
        !digits.is_empty() && digits.len() <= 16 && digits.bytes().all(|b| b.is_ascii_hexdigit());
    valid
        .then(|| u64::from_str_radix(digits, 16).ok())
        .flatten()
        .ok_or_else(|| {
            format!(
                "MORROW_PROPTEST_SEED must be 1 to 16 hex digits, optionally after 0x; got {raw:?}"
            )
        })
}

fn parse_cases(raw: Option<&str>) -> Result<u32, String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_CASES);
    };
    raw.parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("MORROW_PROPTEST_CASES must be a positive integer; got {raw:?}"))
}

fn runner(seed: u64, cases: u32) -> TestRunner {
    let mut material = b"morrow property suite".to_vec();
    material.extend(seed.to_le_bytes());
    let rng_seed: [u8; 32] = Sha256::digest(&material).into();
    let config = Config {
        cases,
        failure_persistence: None,
        source_file: None,
        ..Config::default()
    };
    TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &rng_seed))
}

fn report(step: usize, violation: &Violation, steps: &[Action]) -> String {
    let at = steps
        .get(step.wrapping_sub(1))
        .map_or_else(|| "setup".to_string(), |a| format!("{a:?}"));
    format!(
        "invariant {} ({}) violated at step {step} ({at}): {}",
        violation.family,
        violation.name(),
        violation.message
    )
}

#[test]
fn property_signer_discipline_suite() {
    let seed = parse_seed(std::env::var("MORROW_PROPTEST_SEED").ok().as_deref())
        .unwrap_or_else(|e| panic!("{e}"));
    let cases = parse_cases(std::env::var("MORROW_PROPTEST_CASES").ok().as_deref())
        .unwrap_or_else(|e| panic!("{e}"));
    install_quiet_panic_hook();
    let ran = Cell::new(0u32);
    let totals = RefCell::new(Stats::default());
    let result = runner(seed, cases).run(&case(), |case| {
        ran.set(ran.get() + 1);
        let mut harness = Harness::new(&case.setup);
        let outcome = harness.run(&case.steps);
        totals.borrow_mut().add(&harness.stats);
        outcome.map_err(|(step, v)| TestCaseError::fail(report(step, &v, &case.steps)))
    });
    match result {
        Ok(()) => {
            println!("Property suite: {cases} cases, seed 0x{seed:x}, 0 violations");
            let totals = totals.into_inner();
            println!("{}", totals.line());
            println!("{}", totals.refusals_line());
            // The suite must exercise every signing path, not only refusals.
            if cases >= DEFAULT_CASES {
                assert!(
                    totals.freezes.iter().all(|n| *n > 0)
                        && totals.sign_requests.iter().all(|n| *n > 0)
                        && totals.signatures_stored > 0
                        && totals.changes_applied > 0
                        && totals.changes_stopped > 0,
                    "the suite no longer reaches every path: {}",
                    totals.line()
                );
            }
        }
        Err(TestError::Fail(reason, case)) => panic!(
            "Property suite: violation after {} cases, seed 0x{seed:x} (rerun with MORROW_PROPTEST_SEED=0x{seed:x}): {reason}\nShrunk case: {case:#?}",
            ran.get()
        ),
        Err(TestError::Abort(reason)) => {
            panic!("Property suite aborted, seed 0x{seed:x}: {reason}")
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Meta-tests: the checkers have teeth.

fn fixed_setup() -> Setup {
    Setup {
        allowance_limit: 100_000,
        fee_cap: 100_000,
        pool: vec![150_000; POOL_SIZE],
    }
}

fn pool_coins(ns: &[u8]) -> Utxos {
    Utxos::Coins(
        ns.iter()
            .map(|n| Coin {
                n: *n,
                value: CoinValue::Pool,
            })
            .collect(),
    )
}

fn owner_request(coin: u8) -> Action {
    Action::Request {
        who: Who::Owner,
        vault: VaultPick::Main,
        amount: Amount::Share(50),
        dest: Dest::Main,
        rate: Rate::Normal(2),
        utxos: pool_coins(&[coin]),
        env: Env::Valid,
    }
}

fn owner_execute() -> Action {
    Action::Execute {
        who: Who::Owner,
        op: 0,
        env: Env::Valid,
    }
}

#[test]
fn property_seed_parsing_and_determinism() {
    assert_eq!(parse_seed(None), Ok(DEFAULT_SEED));
    assert_eq!(parse_seed(Some("")), Ok(DEFAULT_SEED));
    assert_eq!(parse_seed(Some("0x1f")), Ok(0x1f));
    assert_eq!(parse_seed(Some("DEADbeef")), Ok(0xdead_beef));
    assert_eq!(format!("0x{:x}", parse_seed(Some("0x2a")).unwrap()), "0x2a");
    for bad in ["0x", "xyz", "0x12345678901234567", "-1", "0x1g"] {
        let error = parse_seed(Some(bad)).unwrap_err();
        assert!(error.contains("MORROW_PROPTEST_SEED"), "{error}");
    }
    assert_eq!(parse_cases(None), Ok(DEFAULT_CASES));
    assert!(parse_cases(Some("0")).is_err());

    // The same seed generates the same cases; another seed does not.
    let first = |seed| {
        let mut runner = runner(seed, 1);
        let tree = case().new_tree(&mut runner).unwrap();
        format!("{:?}", tree.current())
    };
    assert_eq!(first(7), first(7));
    assert_ne!(first(7), first(8));
}

#[test]
fn property_bip143_matches_the_bitcoinjs_vectors() {
    // Pinned in core/tx.rs against bitcoinjs-lib 7.0.5 hashForWitnessV0.
    const UNSIGNED: &str = "020000000201ababababababababababababababababababababababababababababababab0100000000fdffffff02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000fdffffff02a086010000000000160014751e76e8199196d454941c45d1b3a323f1433bd60eab010000000000220020d7e67e333274724565dbc12c6780807c65311d7bcccef2117477faf51e4fb53a00000000";
    const SIGHASHES: [&str; 2] = [
        "bb8873f2f1a14d1b5809ee3b88e7f1f83711480e3ee790850226d67a75a54709",
        "719a66f5097c081884cc06f543e70a02adf494f143443e45f58a1afb12639998",
    ];
    let key = |prefix: u8, byte: u8| {
        let mut k = [byte; 33];
        k[0] = prefix;
        k
    };
    let script = crate::core::script::build_vault_script(
        &key(0x02, 0x11),
        &key(0x03, 0xaa),
        &[key(0x02, 0x22)],
        26_280,
    );
    let tx = parse_tx(UNSIGNED).unwrap();
    assert_eq!(
        display_txid(&tx.inputs[0]),
        format!("{}01", "ab".repeat(31))
    );
    for (i, value) in [150_000, 60_000].into_iter().enumerate() {
        assert_eq!(to_hex(&bip143(&tx, i, &script, value)), SIGHASHES[i]);
    }
    assert!(parse_tx(&UNSIGNED[..UNSIGNED.len() - 2]).is_none());
}

#[test]
fn property_destinations_are_what_the_suite_thinks() {
    for valid in [DESTINATION, TAPROOT_SIGNET, WSH_SIGNET, RECOVERY_SIGNET] {
        let ours = signet_script(valid);
        assert!(ours.is_some(), "{valid}");
        assert_eq!(
            crate::core::address::script_pubkey(valid, BtcNetwork::Signet).ok(),
            ours
        );
    }
    for invalid in [MAINNET, REGTEST, BAD_CHECKSUM, "not an address"] {
        assert_eq!(signet_script(invalid), None, "{invalid}");
    }
}

#[test]
fn property_a_planted_early_freeze_is_reported() {
    install_quiet_panic_hook();
    let early = [
        owner_request(0),
        Action::Advance(Time::ExecutableAt(0, -1)),
        Action::Plant(Plant::ExecutableAtOneNanoEarlier(0)),
        owner_execute(),
    ];
    let (step, violation) = Harness::new(&fixed_setup())
        .run(&early)
        .expect_err("a withdrawal frozen 1 ns early must be reported");
    assert_eq!(step, 4);
    assert_eq!(violation.family, 1, "{}", violation.message);
    assert!(
        violation.message.contains("1 ns before executable_at"),
        "{}",
        violation.message
    );

    // Control: without the plant the contract refuses at -1 ns and freezes at executable_at.
    let mut harness = Harness::new(&fixed_setup());
    harness
        .run(&[
            owner_request(0),
            Action::Advance(Time::ExecutableAt(0, -1)),
            owner_execute(),
            Action::Advance(Time::OneNano),
            owner_execute(),
        ])
        .unwrap_or_else(|(step, v)| panic!("step {step}: {}", v.message));
    assert_eq!(harness.stats.refusals, 1);
    assert_eq!(harness.stats.freezes[0], 1);
}

/// A hand-built frozen op of `kind` whose transaction pays `paid` to the place its kind may pay.
fn hand_built(
    harness: &Harness,
    kind: SpendOpKind,
    inputs: u64,
    paid: u64,
) -> (Tx, Vec<String>, ModelOp) {
    let v = &harness.vaults[&MAIN];
    let source = if kind == SpendOpKind::Allowance {
        SpendSource::Allowance
    } else {
        SpendSource::Vault
    };
    let coin = harness.coin(Coin {
        n: 0,
        value: CoinValue::Sats(inputs),
    });
    let mut m = ModelOp {
        utxos: vec![coin.clone()],
        ..ModelOp::new(MAIN, kind, source, NOW)
    };
    let outputs = match kind {
        SpendOpKind::Withdrawal | SpendOpKind::Allowance => {
            m.amount = 50_000;
            m.destination = DESTINATION.to_string();
            vec![
                (50_000, signet_script(DESTINATION).unwrap()),
                (paid - 50_000, p2wsh(v.witness_script(source))),
            ]
        }
        SpendOpKind::Refresh => vec![(paid, p2wsh(v.witness_script(source)))],
        SpendOpKind::Clawback => vec![(paid, signet_script(&v.policy.recovery_address).unwrap())],
    };
    let mut txid = decode_hex(&coin.txid).unwrap();
    txid.reverse();
    let tx = Tx {
        version: 2u32.to_le_bytes(),
        inputs: vec![TxInput {
            txid: txid.try_into().unwrap(),
            vout: coin.vout,
            sequence: 0xffff_fffd,
        }],
        outputs,
        lock_time: [0; 4],
    };
    let sighashes = vec![to_hex(&bip143(&tx, 0, v.witness_script(source), inputs))];
    (tx, sighashes, m)
}

#[test]
fn property_a_fee_over_the_cap_is_reported() {
    let harness = Harness::new(&fixed_setup());
    let v = &harness.vaults[&MAIN];
    let policy = &v.policy;
    // 100,000 sats in; Fee Cap 100,000. Caps: 5 % of the 50,000 paid out = 2,500;
    // 5 % of the inputs = 5,000; Clawback: 10 % of the inputs = 10,000.
    for (kind, cap) in [
        (SpendOpKind::Withdrawal, 2_500),
        (SpendOpKind::Allowance, 2_500),
        (SpendOpKind::Refresh, 5_000),
        (SpendOpKind::Clawback, 10_000),
    ] {
        let (tx, sighashes, m) = hand_built(&harness, kind, 100_000, 100_000 - cap);
        check_tx(&tx, &sighashes, &m, v, policy)
            .unwrap_or_else(|e| panic!("{kind:?} at the cap: {}", e.message));
        let (tx, sighashes, m) = hand_built(&harness, kind, 100_000, 100_000 - cap - 1);
        let violation = check_tx(&tx, &sighashes, &m, v, policy).unwrap_err();
        assert_eq!(violation.family, 2, "{kind:?}: {}", violation.message);
        assert!(violation.message.contains(&format!("over its cap {cap}")));
    }
    // The Fee Cap binds when it is below the percentage: 10,000 → Clawback cap 20,000 of 1 BTC.
    let low = Policy {
        fee_cap_sats: U64(10_000),
        ..policy.clone()
    };
    let (tx, sighashes, m) = hand_built(
        &harness,
        SpendOpKind::Clawback,
        100_000_000,
        100_000_000 - 20_001,
    );
    assert_eq!(
        check_tx(&tx, &sighashes, &m, v, &low).unwrap_err().family,
        2
    );
}

#[test]
fn property_a_transaction_outside_the_policy_is_reported() {
    let harness = Harness::new(&fixed_setup());
    let v = &harness.vaults[&MAIN];
    // A Refresh whose single output goes to the destination instead of its own address.
    let (mut tx, _, m) = hand_built(&harness, SpendOpKind::Refresh, 100_000, 99_000);
    tx.outputs[0].1 = signet_script(DESTINATION).unwrap();
    let sighashes = vec![to_hex(&bip143(&tx, 0, &v.vault_script, 100_000))];
    let violation = check_tx(&tx, &sighashes, &m, v, &v.policy).unwrap_err();
    assert_eq!(violation.family, 1, "{}", violation.message);
    // A withdrawal whose sighash was computed with the wrong script.
    let (tx, _, m) = hand_built(&harness, SpendOpKind::Withdrawal, 100_000, 99_000);
    let wrong = vec![to_hex(&bip143(&tx, 0, &v.allowance_script, 100_000))];
    let violation = check_tx(&tx, &wrong, &m, v, &v.policy).unwrap_err();
    assert!(
        violation.message.contains("stores sighash"),
        "{}",
        violation.message
    );
}

#[test]
fn property_a_forged_sign_request_is_reported() {
    install_quiet_panic_hook();
    let mut harness = Harness::new(&fixed_setup());
    harness
        .run(&[
            owner_request(0),
            Action::Advance(Time::Delay),
            owner_execute(),
        ])
        .unwrap_or_else(|(step, v)| panic!("step {step}: {}", v.message));
    let m = harness.ops[&1].clone();
    let honest = SignRequest {
        receiver: SIGNER.into(),
        payload: m.frozen.as_ref().unwrap().sighashes[0].clone(),
        path: format!("morrow/v1/{MAIN}/vault"),
    };
    harness
        .check_sign_request(1, 0, OWNER, &honest, Some(&m))
        .unwrap();
    let forged = [
        (STRANGER, honest.clone()),
        (EMMA, honest.clone()),
        (
            OWNER,
            SignRequest {
                payload: "00".repeat(32),
                ..honest.clone()
            },
        ),
        (
            OWNER,
            SignRequest {
                path: format!("morrow/v1/{MAIN}/allowance"),
                ..honest.clone()
            },
        ),
        (
            OWNER,
            SignRequest {
                receiver: STRANGER.into(),
                ..honest.clone()
            },
        ),
    ];
    for (caller, request) in forged {
        let violation = harness
            .check_sign_request(1, 0, caller, &request, Some(&m))
            .unwrap_err();
        assert_eq!(violation.family, 1);
    }
    // A Voided op never gets a sign request.
    let voided = ModelOp {
        state: SpendOpState::Voided,
        ..m.clone()
    };
    assert!(harness
        .check_sign_request(1, 0, OWNER, &honest, Some(&voided))
        .is_err());
}

#[test]
fn property_a_mutated_script_bound_field_is_reported() {
    type Mutation = fn(&mut Vault);
    let mutations: [(&str, Mutation); 9] = [
        ("guardians", |v| {
            v.policy.guardians[0].guardian_account = STRANGER.parse().unwrap()
        }),
        ("guardians", |v| {
            v.policy.guardians[1].guardian_key = format!("03{}", "77".repeat(32))
        }),
        ("guardians", |v| {
            v.policy.guardians.pop();
        }),
        ("owner_key", |v| {
            v.owner_key = format!("03{}", "88".repeat(32))
        }),
        ("cosigner_pubkeys", |v| {
            v.cosigner_pubkeys.as_mut().unwrap().vault = format!("02{}", "99".repeat(32))
        }),
        ("addresses", |v| {
            v.addresses.as_mut().unwrap().allowance = DESTINATION.to_string()
        }),
        ("escape_timelock_blocks", |v| {
            v.policy.escape_timelock_blocks = 6
        }),
        ("btc_network", |v| {
            v.policy.btc_network = BtcNetwork::Testnet4
        }),
        ("watcher_x25519_pk", |v| {
            v.policy.watcher_x25519_pk = "55".repeat(32)
        }),
    ];
    for (field, mutate) in mutations {
        let mut harness = Harness::new(&fixed_setup());
        harness.check_state().unwrap();
        mutate(harness.contract.vaults.get_mut(&MAIN).unwrap());
        let violation = harness.check_state().unwrap_err();
        assert_eq!(violation.family, 3, "{field}: {}", violation.message);
        assert!(
            violation.message.contains(field),
            "{field}: {}",
            violation.message
        );
    }

    // A Policy field changed without an applied Policy Change.
    let mut harness = Harness::new(&fixed_setup());
    harness
        .contract
        .vaults
        .get_mut(&MAIN)
        .unwrap()
        .policy
        .fee_cap_sats = U64(1_000_000);
    let violation = harness.check_state().unwrap_err();
    assert_eq!(violation.family, 3);
    assert!(
        violation.message.contains("fee_cap_sats"),
        "{}",
        violation.message
    );
}

#[test]
fn property_a_reactivated_vetoed_change_is_reported() {
    install_quiet_panic_hook();
    let mut harness = Harness::new(&fixed_setup());
    let propose = Action::Propose {
        who: Who::Owner,
        vault: VaultPick::Main,
        change: Change::Fields(vec![Field::Limit(1_000_000)]),
        env: Env::Valid,
    };
    let veto = Action::Veto {
        who: Who::Emma,
        change: 0,
        env: None,
    };
    harness
        .run(&[propose, veto])
        .unwrap_or_else(|(step, v)| panic!("step {step}: {}", v.message));
    assert!(harness.stopped.contains(&1));

    // Planted bug: the vetoed change comes back to life in the contract.
    let mut change = harness.contract.changes.get(&1).cloned().unwrap();
    change.state = crate::core::policy::PolicyChangeState::Pending;
    change.vetoed_by = None;
    harness.contract.changes.insert(1, change.clone());
    harness
        .contract
        .vaults
        .get_mut(&MAIN)
        .unwrap()
        .pending_change = Some(change);
    harness.now += 8 * DAY_NS;
    let violation = harness
        .step(&Action::Apply {
            who: Who::Stranger,
            change: 0,
        })
        .unwrap_err();
    assert_eq!(violation.family, 3);
    assert!(
        violation.message.contains("vetoed or withdrawn"),
        "{}",
        violation.message
    );
}

#[test]
fn property_an_honest_sequence_reaches_every_signing_path() {
    install_quiet_panic_hook();
    let mut harness = Harness::new(&fixed_setup());
    let sign = |op| Action::Sign {
        who: Who::Owner,
        op,
        input: 0,
    };
    harness
        .run(&[
            owner_request(0),
            Action::Allowance {
                who: Who::Owner,
                vault: VaultPick::Main,
                amount: Amount::Sats(60_000),
                dest: Dest::Main,
                rate: Rate::Normal(2),
                utxos: pool_coins(&[1]),
                env: Env::Valid,
            },
            Action::Refresh {
                who: Who::Owner,
                vault: VaultPick::Main,
                utxos: pool_coins(&[2, 3]),
                rate: Rate::Normal(2),
                env: Env::Valid,
                source: None,
            },
            Action::Advance(Time::Delay),
            owner_execute(),
            sign(0),
            Action::Clawback {
                who: Who::Backup,
                vault: VaultPick::Main,
                utxos: pool_coins(&[4]),
                rate: Rate::Normal(2),
                source: None,
            },
            Action::Sign {
                who: Who::Emma,
                op: 0,
                input: 0,
            },
        ])
        .unwrap_or_else(|(step, v)| panic!("step {step}: {}", v.message));
    assert_eq!(harness.stats.freezes, [1, 1, 1, 1]);
    assert_eq!(harness.stats.sign_requests.iter().sum::<u64>(), 2);
    assert_eq!(harness.stats.refusals, 0);
}
