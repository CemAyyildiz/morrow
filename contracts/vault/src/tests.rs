use super::*;
use crate::core::policy::tests::standard_policy;
use crate::core::policy::{GuardianKind, DAY_NS, MINUTE_NS};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const OWNER_KEY: &str = "021111111111111111111111111111111111111111111111111111111111111111";

fn context(caller: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(caller.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(1_762_070_400_000_000_000)
        .build());
}

fn testnet_contract(allowlist: Vec<&str>) -> VaultContract {
    context("deployer.testnet", NearToken::from_yoctonear(0));
    // testing_env! keeps storage between contexts; every test contract starts empty.
    near_sdk::mock::with_mocked_blockchain(|chain| {
        chain.take_storage();
    });
    VaultContract::new(
        "v1.signer-prod.testnet".parse().unwrap(),
        vec![
            BtcNetwork::Regtest,
            BtcNetwork::Signet,
            BtcNetwork::Testnet4,
        ],
        allowlist.into_iter().map(|a| a.parse().unwrap()).collect(),
    )
}

/// Calls `create_vault` and returns the new vault id (the Promise itself is not resolved in unit tests).
fn create(contract: &mut VaultContract, policy: Policy) -> U64 {
    let _ = contract.create_vault(OWNER_KEY.to_string(), policy);
    U64(contract.next_vault_id - 1)
}

fn panic_message(f: impl FnOnce() + std::panic::UnwindSafe) -> String {
    let error = std::panic::catch_unwind(f).expect_err("expected a panic");
    error
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| error.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[test]
fn creates_a_pending_vault_and_emits_vault_created() {
    let mut contract = testnet_contract(vec![]);
    context("owner.testnet", MIN_VAULT_STORAGE);
    let vault_id = create(&mut contract, standard_policy());
    assert_eq!(vault_id, U64(1));

    let vault = contract.get_vault(vault_id);
    assert_eq!(vault.state, VaultState::PendingKeys);
    assert_eq!(vault.owner_account.as_str(), "owner.testnet");
    assert!(vault.storage_balance.0 < MIN_VAULT_STORAGE.as_yoctonear());
    assert!(vault.storage_balance.0 > 0);

    let events = contract.events_since(U64(0), 100);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].seq, U64(1));
    assert_eq!(events[0].kind, "vault_created");
    assert_eq!(events[0].data["owner_account"], "owner.testnet");
    assert!(get_logs()
        .iter()
        .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"morrow\"")));
}

#[test]
fn rejects_out_of_bounds_policies_with_their_codes() {
    let cases = vec![
        (
            Policy {
                delay_ns: U64(30 * MINUTE_NS),
                ..standard_policy()
            },
            "ERR_POLICY_BOUNDS",
        ),
        (
            Policy {
                delay_ns: U64(10 * DAY_NS),
                policy_change_delay_ns: U64(8 * DAY_NS),
                ..standard_policy()
            },
            "ERR_POLICY_CHANGE_DELAY",
        ),
        (
            Policy {
                guardians: vec![],
                ..standard_policy()
            },
            "ERR_GUARDIAN_COUNT",
        ),
        (
            Policy {
                btc_network: BtcNetwork::Bitcoin,
                recovery_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".into(),
                ..standard_policy()
            },
            "ERR_NETWORK_NOT_ALLOWED",
        ),
        (
            Policy {
                recovery_address: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8"
                    .into(),
                ..standard_policy()
            },
            "ERR_BAD_ADDRESS",
        ),
    ];
    for (policy, expected) in cases {
        let message = panic_message(move || {
            let mut contract = testnet_contract(vec![]);
            context("owner.testnet", MIN_VAULT_STORAGE);
            let _ = contract.create_vault(OWNER_KEY.to_string(), policy);
        });
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }
}

#[test]
fn accepts_judge_mode_bounds_on_regtest() {
    let mut contract = testnet_contract(vec![]);
    context("owner.testnet", MIN_VAULT_STORAGE);
    let policy = Policy {
        btc_network: BtcNetwork::Regtest,
        recovery_address: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080".into(),
        delay_ns: U64(MINUTE_NS),
        policy_change_delay_ns: U64(MINUTE_NS),
        fast_approval_floor_ns: U64(MINUTE_NS),
        escape_timelock_blocks: 6,
        ..standard_policy()
    };
    assert_eq!(create(&mut contract, policy), U64(1));
}

#[test]
fn enforces_creator_allowlist_and_minimum_deposit() {
    let message = panic_message(|| {
        let mut contract = testnet_contract(vec!["operator.testnet"]);
        context("stranger.testnet", MIN_VAULT_STORAGE);
        let _ = contract.create_vault(OWNER_KEY.to_string(), standard_policy());
    });
    assert!(message.contains("ERR_CREATOR_NOT_ALLOWED"), "{message}");

    let message = panic_message(|| {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", NearToken::from_millinear(490));
        let _ = contract.create_vault(OWNER_KEY.to_string(), standard_policy());
    });
    assert!(message.contains("ERR_DEPOSIT_TOO_LOW"), "{message}");

    let mut contract = testnet_contract(vec!["operator.testnet"]);
    context("operator.testnet", MIN_VAULT_STORAGE);
    assert_eq!(create(&mut contract, standard_policy()), U64(1));
}

#[test]
fn rejects_a_malformed_owner_key() {
    let message = panic_message(|| {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        let _ = contract.create_vault("04".repeat(33), standard_policy());
    });
    assert!(message.contains("ERR_BAD_KEY"), "{message}");
}

#[test]
fn pages_events_and_tops_up_storage() {
    let mut contract = testnet_contract(vec![]);
    context("owner.testnet", MIN_VAULT_STORAGE);
    let first = create(&mut contract, standard_policy());
    context("owner.testnet", MIN_VAULT_STORAGE);
    let mut second = standard_policy();
    second.guardians[0].kind = GuardianKind::AutoClawback;
    create(&mut contract, second);
    let before = contract.get_vault(first).storage_balance.0;
    context("anyone.testnet", NearToken::from_millinear(100));
    contract.top_up_storage(first);
    assert_eq!(
        contract.get_vault(first).storage_balance.0,
        before + NearToken::from_millinear(100).as_yoctonear()
    );

    let page = contract.events_since(U64(0), 2);
    assert_eq!(page.iter().map(|e| e.seq.0).collect::<Vec<_>>(), vec![1, 2]);
    let rest = contract.events_since(U64(2), 100);
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].kind, "storage_topped_up");
    assert!(contract.events_since(U64(3), 0).is_empty());
}

mod activation {
    use super::*;
    use crate::core::address::p2wsh_address;
    use crate::core::script::{build_vault_script, compress_derived_key, parse_key};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PromiseResult, RuntimeFeesConfig};

    // Real keys returned by v1.signer-prod.testnet (day-1 spike) and a second valid point.
    const VAULT_KEY: &str = "secp256k1:5Rn31MPPHMbMb2etDnih1mQ6qFdCdYwZ5ybC2SLex5hr1xkmBYnGdojGZXTbVjuYTXqXj3dTW2xdca1pNeNcRmqY";

    fn derived(byte: u8) -> String {
        let mut point = [byte; 64];
        point[63] = 0x01;
        format!("secp256k1:{}", bs58::encode(point).into_string())
    }

    fn callback_context(results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id("vault.testnet".parse().unwrap())
            .block_timestamp(1_762_070_500_000_000_000)
            .build();
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    fn json_result(value: &str) -> PromiseResult {
        PromiseResult::Successful(near_sdk::serde_json::to_vec(value).unwrap())
    }

    fn pending_vault() -> (VaultContract, U64) {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        let id = create(&mut contract, standard_policy());
        (contract, id)
    }

    #[test]
    fn activates_with_compressed_keys_scripts_and_addresses() {
        let (mut contract, id) = pending_vault();
        let allowance_key = derived(0x55);
        callback_context(vec![json_result(VAULT_KEY), json_result(&allowance_key)]);
        assert_eq!(
            contract.on_keys_derived(id, Ok(VAULT_KEY.into()), Ok(allowance_key.clone())),
            id
        );

        let vault = contract.get_vault(id);
        assert_eq!(vault.state, VaultState::Active);
        let keys = vault.cosigner_pubkeys.clone().unwrap();
        assert_eq!(
            parse_key(&keys.vault).unwrap(),
            compress_derived_key(VAULT_KEY).unwrap()
        );

        let kit = contract.get_vault_kit(id);
        let guardians: Vec<[u8; 33]> = vault
            .policy
            .guardians
            .iter()
            .map(|g| parse_key(&g.guardian_key).unwrap())
            .collect();
        let expected = build_vault_script(
            &parse_key(&vault.owner_key).unwrap(),
            &parse_key(&keys.vault).unwrap(),
            &guardians,
            vault.policy.escape_timelock_blocks,
        );
        assert_eq!(kit.vault_script_hex, crate::core::script::hex(&expected));
        assert_eq!(
            kit.addresses.vault,
            p2wsh_address(&expected, BtcNetwork::Signet)
        );
        assert_ne!(kit.addresses.vault, kit.addresses.allowance);
        assert_eq!(kit.kit_version, 1);
        assert_eq!(kit.witness_templates.len(), 3);

        let kinds: Vec<String> = contract
            .events_since(U64(0), 100)
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds, vec!["vault_created", "vault_activated"]);
    }

    #[test]
    fn stays_pending_when_a_derivation_fails() {
        let message = panic_message(|| {
            let (mut contract, id) = pending_vault();
            callback_context(vec![json_result(VAULT_KEY), PromiseResult::Failed]);
            contract.on_keys_derived(
                id,
                Ok(VAULT_KEY.into()),
                Err(near_sdk::PromiseError::Failed),
            );
        });
        assert!(message.contains("ERR_VAULT_NOT_ACTIVE"), "{message}");

        let (contract, id) = pending_vault();
        assert_eq!(contract.get_vault(id).state, VaultState::PendingKeys);
        let message = panic_message(move || {
            contract.get_vault_kit(id);
        });
        assert!(message.contains("ERR_VAULT_NOT_ACTIVE"), "{message}");
    }

    #[test]
    fn a_repeated_callback_never_changes_the_keys() {
        let (mut contract, id) = pending_vault();
        callback_context(vec![]);
        contract.on_keys_derived(id, Ok(VAULT_KEY.into()), Ok(derived(0x55)));
        let first = contract.get_vault(id).cosigner_pubkeys;
        contract.on_keys_derived(id, Ok(derived(0x66)), Ok(derived(0x77)));
        assert_eq!(contract.get_vault(id).cosigner_pubkeys, first);
    }
}

mod withdrawals_support {
    use super::*;
    use crate::core::script::from_hex;
    use crate::core::spend::Outpoint;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;

    pub fn envelope() -> String {
        "ab".repeat(80)
    }
    pub const DESTINATION: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    pub const NOW: u64 = 1_762_070_400_000_000_000;

    pub fn utxo(n: u8, value: u64) -> Outpoint {
        Outpoint {
            txid: format!("{n:02x}").repeat(32),
            vout: 0,
            value_sats: U64(value),
        }
    }

    pub fn as_caller(caller: &str) {
        context(caller, NearToken::from_yoctonear(0));
    }

    /// An active signet Vault owned by owner.testnet with Guardians emma.testnet and backup.testnet.
    pub fn active_vault() -> (VaultContract, U64) {
        active_vault_with(standard_policy())
    }

    /// `active_vault` with another Policy.
    pub fn active_vault_with(policy: Policy) -> (VaultContract, U64) {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        let id = create(&mut contract, policy);
        let mut point = [0x11u8; 64];
        point[63] = 1;
        let key = format!("secp256k1:{}", bs58::encode(point).into_string());
        contract.on_keys_derived(id, Ok(key.clone()), Ok(key));
        (contract, id)
    }

    pub fn request(
        contract: &mut VaultContract,
        id: U64,
        utxos: Vec<Outpoint>,
        amount: u64,
    ) -> U64 {
        as_caller("owner.testnet");
        contract.request_withdrawal(id, U64(amount), DESTINATION.into(), 2, utxos, envelope())
    }

    pub fn at_time(caller: &str, timestamp: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(timestamp)
            .build());
    }

    pub fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    /// The outputs of an unsigned transaction in hex: (value, scriptPubKey).
    pub fn outputs(unsigned_hex: &str) -> Vec<(u64, Vec<u8>)> {
        crate::core::tx::test_support::outputs(&from_hex(unsigned_hex).unwrap())
    }

    pub fn signing_mpc(byte: u8) -> MpcSignature {
        MpcSignature {
            big_r: MpcPoint {
                affine_point: format!("02{}", format!("{byte:02x}").repeat(32)),
            },
            s: MpcScalar {
                scalar: format!("{byte:02x}").repeat(32),
            },
        }
    }

    /// An active Vault whose Vault and Allowance Co-signer keys differ, so the two addresses do.
    pub fn two_address_vault() -> (VaultContract, U64) {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        let id = create(&mut contract, standard_policy());
        let key = |byte: u8| {
            let mut point = [byte; 64];
            point[63] = 1;
            format!("secp256k1:{}", bs58::encode(point).into_string())
        };
        contract.on_keys_derived(id, Ok(key(0x11)), Ok(key(0x55)));
        let addresses = contract.get_vault(id).addresses.unwrap();
        assert_ne!(addresses.vault, addresses.allowance);
        (contract, id)
    }

    pub fn sign_paths() -> Vec<String> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|action| match action {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"sign" => {
                    let args: near_sdk::serde_json::Value =
                        near_sdk::serde_json::from_slice(&args).unwrap();
                    Some(args["request"]["path"].as_str().unwrap().to_string())
                }
                _ => None,
            })
            .collect()
    }
}

mod withdrawals {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::HOUR_NS;
    use crate::core::spend::SpendOpState;

    fn rejects(expected: &str, f: impl FnOnce(&mut VaultContract, U64) + std::panic::UnwindSafe) {
        let message = panic_message(move || {
            let (mut contract, id) = active_vault();
            f(&mut contract, id);
        });
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    #[test]
    fn requests_a_pending_withdrawal_that_waits_the_delay() {
        let (mut contract, id) = active_vault();
        let op_id = request(&mut contract, id, vec![utxo(1, 100_000)], 50_000);
        let op = contract.get_op(op_id);
        assert_eq!(op.state, SpendOpState::Pending);
        assert_eq!(op.executable_at, Some(U64(NOW + 24 * HOUR_NS)));
        let event = contract.events_since(U64(2), 100).pop().unwrap();
        assert_eq!(event.kind, "withdrawal_requested");
        assert_eq!(event.data["op_id"], "1");
        assert_eq!(event.data["envelope"], envelope());
    }

    #[test]
    fn only_the_owner_can_request() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            rejects("ERR_UNAUTHORIZED", move |c, id| {
                as_caller(caller);
                c.request_withdrawal(
                    id,
                    U64(1),
                    DESTINATION.into(),
                    2,
                    vec![utxo(1, 10)],
                    envelope(),
                );
            });
        }
    }

    #[test]
    fn rejects_bad_envelopes_inputs_funds_and_destinations() {
        rejects("ERR_BAD_ENVELOPE", |c, id| {
            as_caller("owner.testnet");
            c.request_withdrawal(
                id,
                U64(1),
                DESTINATION.into(),
                2,
                vec![utxo(1, 10)],
                "ab".repeat(79),
            );
        });
        rejects("ERR_NO_INPUTS", |c, id| {
            request(c, id, vec![], 1);
        });
        rejects("ERR_TOO_MANY_INPUTS", |c, id| {
            request(c, id, (1..=6).map(|n| utxo(n, 10)).collect(), 1);
        });
        rejects("ERR_OUTPOINT_RESERVED", |c, id| {
            request(c, id, vec![utxo(1, 10), utxo(1, 10)], 1);
        });
        rejects("ERR_INSUFFICIENT_FUNDS", |c, id| {
            request(c, id, vec![utxo(1, 10)], 11);
        });
        rejects("ERR_BAD_ADDRESS", |c, id| {
            as_caller("owner.testnet");
            c.request_withdrawal(
                id,
                U64(1),
                "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".into(),
                2,
                vec![utxo(1, 10)],
                envelope(),
            );
        });
    }

    #[test]
    fn reserves_outpoints_until_cancelled() {
        rejects("ERR_OUTPOINT_RESERVED", |c, id| {
            request(c, id, vec![utxo(1, 10_000)], 5_000);
            request(c, id, vec![utxo(1, 10_000)], 5_000);
        });
        let (mut contract, id) = active_vault();
        let op_id = request(&mut contract, id, vec![utxo(1, 10_000)], 5_000);
        as_caller("emma.testnet");
        contract.cancel(op_id, None);
        assert_eq!(contract.get_op(op_id).state, SpendOpState::Cancelled);
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "withdrawal_cancelled"
        );
        request(&mut contract, id, vec![utxo(1, 10_000)], 5_000);
    }

    #[test]
    fn owner_cancels_with_an_envelope_and_strangers_cannot() {
        let (mut contract, id) = active_vault();
        let op_id = request(&mut contract, id, vec![utxo(1, 10_000)], 5_000);
        contract.cancel(op_id, Some(envelope()));
        assert_eq!(contract.get_op(op_id).state, SpendOpState::Cancelled);

        rejects("ERR_BAD_ENVELOPE", |c, id| {
            let op = request(c, id, vec![utxo(1, 10_000)], 5_000);
            c.cancel(op, None);
        });
        rejects("ERR_UNAUTHORIZED", |c, id| {
            let op = request(c, id, vec![utxo(1, 10_000)], 5_000);
            as_caller("stranger.testnet");
            c.cancel(op, None);
        });
        rejects("ERR_BAD_OP_STATE", |c, id| {
            let op = request(c, id, vec![utxo(1, 10_000)], 5_000);
            as_caller("emma.testnet");
            c.cancel(op, None);
            c.cancel(op, None);
        });
    }

    #[test]
    fn a_pending_keys_vault_rejects_requests() {
        let message = panic_message(|| {
            let mut contract = testnet_contract(vec![]);
            context("owner.testnet", MIN_VAULT_STORAGE);
            let id = create(&mut contract, standard_policy());
            request(&mut contract, id, vec![utxo(1, 10_000)], 5_000);
        });
        assert!(message.contains("ERR_VAULT_NOT_ACTIVE"), "{message}");
    }

    #[test]
    fn charges_storage_to_the_vault() {
        let (mut contract, id) = active_vault();
        let before = contract.get_vault(id).storage_balance.0;
        request(&mut contract, id, vec![utxo(1, 10_000)], 5_000);
        assert!(contract.get_vault(id).storage_balance.0 < before);
    }
}

mod execution {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::HOUR_NS;
    use crate::core::spend::SpendOpState;

    #[test]
    fn rejects_execute_before_the_delay() {
        let message = panic_message(|| {
            let (mut contract, id) = active_vault();
            let op = request(&mut contract, id, vec![utxo(1, 200_000)], 100_000);
            contract.begin_execute(op, envelope());
        });
        assert!(message.contains("ERR_NOT_EXECUTABLE"), "{message}");
    }

    #[test]
    fn freezes_a_contract_built_transaction_after_the_delay() {
        let (mut contract, id) = active_vault();
        let op_id = request(
            &mut contract,
            id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            100_000,
        );
        at_time("owner.testnet", NOW + 24 * HOUR_NS);
        let op = contract.begin_execute(op_id, envelope());
        assert_eq!(op.state, SpendOpState::Frozen);
        assert_eq!(op.sighashes.len(), 2);
        assert_eq!(op.signatures, vec![None, None]);
        assert_eq!(
            op.witness_template.as_ref().map(|t| t.path.as_str()),
            Some("withdrawal")
        );
        let tx = op.unsigned_tx_hex.clone().unwrap();
        assert!(tx.starts_with("02000000"), "version 2");
        assert_eq!(tx.matches("fdffffff").count(), 2, "RBF on every input");
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "op_frozen");

        // A second call returns the same frozen transaction.
        let again = contract.begin_execute(op_id, envelope());
        assert_eq!(again.unsigned_tx_hex, op.unsigned_tx_hex);
    }

    #[test]
    fn rejects_fees_above_the_cap() {
        let message = panic_message(|| {
            let (mut contract, id) = active_vault();
            as_caller("owner.testnet");
            let op = contract.request_withdrawal(
                id,
                U64(100_000),
                DESTINATION.into(),
                200,
                vec![utxo(1, 300_000)],
                envelope(),
            );
            at_time("owner.testnet", NOW + 24 * HOUR_NS);
            contract.begin_execute(op, envelope());
        });
        assert!(message.contains("ERR_FEE_TOO_HIGH"), "{message}");
    }

    /// Regression (Story 7.4 property suite, seed 0x3, case 502): a 6-sat withdrawal from a
    /// 600-sat coin at 0 sat/vB used to freeze with a 6-sat payment output, below dust.
    #[test]
    fn a_withdrawal_below_dust_is_refused() {
        let policy = Policy {
            allowance_limit_sats: U64(0),
            fee_cap_sats: U64(10_000),
            ..standard_policy()
        };
        let withdraw = |contract: &mut VaultContract, id: U64, coin: u64, amount: u64| {
            as_caller("owner.testnet");
            contract.request_withdrawal(
                id,
                U64(amount),
                DESTINATION.into(),
                0,
                vec![utxo(1, coin)],
                envelope(),
            )
        };
        for amount in [6, 545] {
            let (mut contract, id) = active_vault_with(policy.clone());
            let message = panic_message(std::panic::AssertUnwindSafe(|| {
                withdraw(&mut contract, id, 600, amount);
            }));
            assert!(
                message.contains("ERR_INSUFFICIENT_FUNDS") && message.contains("below dust"),
                "{amount}: {message}"
            );
            assert_eq!(contract.next_op_id, 1, "a refused request stores no op");
        }

        // 546 is accepted and pays exactly 546.
        let (mut contract, id) = active_vault_with(policy);
        let op = withdraw(&mut contract, id, 10_000, 546);
        at_time("owner.testnet", NOW + 24 * HOUR_NS);
        let frozen = contract.begin_execute(op, envelope());
        assert_eq!(frozen.state, SpendOpState::Frozen);
        let paid = outputs(frozen.unsigned_tx_hex.as_deref().unwrap());
        assert_eq!(paid[0].0, 546);
        assert!(paid.iter().all(|(value, _)| *value >= 546));
    }

    #[test]
    fn only_the_owner_executes() {
        let message = panic_message(|| {
            let (mut contract, id) = active_vault();
            let op = request(&mut contract, id, vec![utxo(1, 200_000)], 100_000);
            at_time("emma.testnet", NOW + 24 * HOUR_NS);
            contract.begin_execute(op, envelope());
        });
        assert!(message.contains("ERR_UNAUTHORIZED"), "{message}");
    }
}

mod signing {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::HOUR_NS;
    use crate::core::spend::SpendOpState;
    use near_sdk::PromiseOrValue;

    fn mpc(byte: u8) -> MpcSignature {
        MpcSignature {
            big_r: MpcPoint {
                affine_point: format!("02{}", format!("{byte:02x}").repeat(32)),
            },
            s: MpcScalar {
                scalar: format!("{byte:02x}").repeat(32),
            },
        }
    }

    /// An active Vault with a frozen 2-input withdrawal, caller = owner.
    fn frozen_op() -> (VaultContract, U64) {
        let (mut contract, id) = active_vault();
        let op = request(
            &mut contract,
            id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            100_000,
        );
        at_time("owner.testnet", NOW + 24 * HOUR_NS);
        contract.begin_execute(op, envelope());
        (contract, op)
    }

    fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    #[test]
    fn requests_an_mpc_signature_then_stores_it() {
        let (mut contract, op) = frozen_op();
        assert!(matches!(
            contract.sign_input(op, 0),
            PromiseOrValue::Promise(_)
        ));
        let stored = contract.on_signed(op, 0, Ok(mpc(0x11)));
        assert_eq!(stored.len(), 130);
        assert!(stored.starts_with("02"));
        // A stored signature comes back without a new MPC call.
        match contract.sign_input(op, 0) {
            PromiseOrValue::Value(value) => assert_eq!(value, stored),
            PromiseOrValue::Promise(_) => panic!("expected the stored signature"),
        }
        assert_eq!(contract.get_op(op).state, SpendOpState::Frozen);
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "input_signed"
        );
    }

    #[test]
    fn becomes_signed_when_every_input_is_signed() {
        let (mut contract, op) = frozen_op();
        contract.on_signed(op, 0, Ok(mpc(0x11)));
        contract.on_signed(op, 1, Ok(mpc(0x22)));
        let signed = contract.get_op(op);
        assert_eq!(signed.state, SpendOpState::Signed);
        assert!(signed.signatures.iter().all(Option::is_some));
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "op_signed"
        );
        // A late duplicate callback never replaces a stored signature.
        assert_eq!(
            contract.on_signed(op, 0, Ok(mpc(0x33))),
            signed.signatures[0].clone().unwrap()
        );
    }

    #[test]
    fn rejects_bad_indexes_states_and_callers() {
        expect_panic("ERR_INPUT_INDEX", || {
            let (mut contract, op) = frozen_op();
            let _ = contract.sign_input(op, 2);
        });
        expect_panic("ERR_BAD_OP_STATE", || {
            let (mut contract, id) = active_vault();
            let op = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
            let _ = contract.sign_input(op, 0);
        });
        expect_panic("ERR_UNAUTHORIZED", || {
            let (mut contract, op) = frozen_op();
            as_caller("emma.testnet");
            let _ = contract.sign_input(op, 0);
        });
    }

    #[test]
    fn stores_nothing_when_the_signer_fails() {
        expect_panic("ERR_SIGNER_FAILED", || {
            let (mut contract, op) = frozen_op();
            contract.on_signed(op, 0, Err(near_sdk::PromiseError::Failed));
        });
        expect_panic("ERR_SIGNER_FAILED", || {
            let (mut contract, op) = frozen_op();
            let mut bad = mpc(0x11);
            bad.s.scalar = "zz".into();
            contract.on_signed(op, 0, Ok(bad));
        });
        let (contract, op) = frozen_op();
        assert_eq!(contract.get_op(op).signatures, vec![None, None]);
    }
}

mod clawback {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::HOUR_NS;
    use crate::core::spend::{SpendOpKind, SpendOpState, SpendSource};

    fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    fn claw(
        contract: &mut VaultContract,
        id: U64,
        utxos: Vec<crate::core::spend::Outpoint>,
    ) -> U64 {
        as_caller("backup.testnet");
        contract.begin_clawback(id, utxos, 2, None)
    }

    #[test]
    fn sweeps_to_the_recovery_address_voids_live_ops_and_closes_the_vault() {
        let (mut contract, id) = active_vault();
        let withdrawal = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        let clawback = claw(&mut contract, id, vec![utxo(1, 150_000), utxo(2, 60_000)]);

        let op = contract.get_op(clawback);
        assert_eq!(op.kind, SpendOpKind::Clawback);
        assert_eq!(op.state, SpendOpState::Frozen);
        assert_eq!(
            op.destination,
            contract.get_vault(id).policy.recovery_address
        );
        assert_eq!(op.sighashes.len(), 2);
        assert_eq!(
            op.witness_template.as_ref().map(|t| t.path.as_str()),
            Some("clawback")
        );
        assert!(op.unsigned_tx_hex.as_ref().unwrap().contains("fdffffff"));
        assert_eq!(contract.get_op(withdrawal).state, SpendOpState::Voided);
        assert_eq!(contract.get_vault(id).state, VaultState::ClawedBack);

        let kinds: Vec<String> = contract
            .events_since(U64(3), 100)
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds, vec!["op_voided", "vault_clawed_back", "op_frozen"]);
    }

    #[test]
    fn only_guardians_can_claw_back() {
        for caller in ["owner.testnet", "stranger.testnet"] {
            expect_panic("ERR_UNAUTHORIZED", move || {
                let (mut contract, id) = active_vault();
                as_caller(caller);
                contract.begin_clawback(id, vec![utxo(1, 150_000)], 2, None);
            });
        }
    }

    #[test]
    fn a_clawed_back_vault_rejects_everything_else() {
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            claw(&mut contract, id, vec![utxo(1, 150_000)]);
            request(&mut contract, id, vec![utxo(2, 150_000)], 100_000);
        });
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            let op = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
            claw(&mut contract, id, vec![utxo(2, 150_000)]);
            at_time("owner.testnet", NOW + 24 * HOUR_NS);
            contract.begin_execute(op, envelope());
        });
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            let op = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
            claw(&mut contract, id, vec![utxo(2, 150_000)]);
            as_caller("owner.testnet");
            contract.cancel(op, Some(envelope()));
        });
    }

    #[test]
    fn sweeps_late_deposits_but_never_the_same_outpoint_twice() {
        let (mut contract, id) = active_vault();
        claw(&mut contract, id, vec![utxo(1, 150_000)]);
        let late = claw(&mut contract, id, vec![utxo(2, 60_000)]);
        assert_eq!(contract.get_op(late).state, SpendOpState::Frozen);
        expect_panic("ERR_OUTPOINT_RESERVED", || {
            let (mut contract, id) = active_vault();
            claw(&mut contract, id, vec![utxo(1, 150_000)]);
            claw(&mut contract, id, vec![utxo(1, 150_000)]);
        });
    }

    #[test]
    fn enforces_the_clawback_fee_cap() {
        expect_panic("ERR_FEE_TOO_HIGH", || {
            let (mut contract, id) = active_vault();
            as_caller("emma.testnet");
            contract.begin_clawback(id, vec![utxo(1, 150_000)], 1_000, None);
        });
    }

    #[test]
    fn sweeps_the_allowance_address_with_its_own_script() {
        let (mut contract, id) = active_vault();
        as_caller("emma.testnet");
        let from_vault = contract.begin_clawback(id, vec![utxo(1, 150_000)], 2, None);
        let from_allowance =
            contract.begin_clawback(id, vec![utxo(2, 150_000)], 2, Some(SpendSource::Allowance));
        assert_eq!(
            contract.get_op(from_allowance).source,
            SpendSource::Allowance
        );
        assert_ne!(
            contract.get_op(from_vault).sighashes,
            contract.get_op(from_allowance).sighashes
        );
    }

    #[test]
    fn guardians_sign_clawback_inputs_even_after_the_vault_is_closed() {
        let (mut contract, id) = active_vault();
        let op = claw(&mut contract, id, vec![utxo(1, 150_000)]);
        assert!(matches!(
            contract.sign_input(op, 0),
            near_sdk::PromiseOrValue::Promise(_)
        ));
        expect_panic("ERR_UNAUTHORIZED", || {
            let (mut contract, id) = active_vault();
            let op = claw(&mut contract, id, vec![utxo(1, 150_000)]);
            as_caller("owner.testnet");
            let _ = contract.sign_input(op, 0);
        });
    }
}

mod refresh {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::address::p2wsh_script_pubkey;
    use crate::core::script::from_hex;
    use crate::core::spend::{Outpoint, SpendOpKind, SpendOpState, SpendSource};

    fn refresh(contract: &mut VaultContract, id: U64, utxos: Vec<Outpoint>, rate: u32) -> SpendOp {
        as_caller("owner.testnet");
        contract.refresh(id, utxos, rate, envelope(), None)
    }

    fn vault_script_pubkey(contract: &VaultContract, id: U64) -> Vec<u8> {
        let kit = contract.get_vault_kit(id);
        p2wsh_script_pubkey(&from_hex(&kit.vault_script_hex).unwrap())
    }

    #[test]
    fn freezes_a_sweep_back_to_the_vault_address_at_once() {
        let (mut contract, id) = active_vault();
        let storage_before = contract.get_vault(id).storage_balance.0;
        let op = refresh(
            &mut contract,
            id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            2,
        );

        assert_eq!(op, contract.get_op(op.op_id));
        assert_eq!(op.kind, SpendOpKind::Refresh);
        assert_eq!(op.source, SpendSource::Vault);
        assert_eq!(op.state, SpendOpState::Frozen);
        assert_eq!(op.executable_at, None);
        assert_eq!(op.created_at, U64(NOW));
        assert_eq!(op.fee_rate_sat_vb, 2);
        let vault = contract.get_vault(id);
        assert_eq!(op.destination, vault.addresses.unwrap().vault);
        assert_eq!(op.sighashes.len(), 2);
        assert_eq!(op.signatures, vec![None, None]);
        assert_eq!(
            op.witness_template.as_ref().map(|t| t.path.as_str()),
            Some("withdrawal")
        );
        assert!(vault.storage_balance.0 < storage_before);

        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "op_frozen");
        assert_eq!(event.data["op_id"], op.op_id.0.to_string());
        assert_eq!(event.data["kind"], "refresh");
        assert_eq!(event.data["envelope"], envelope());
        let fee: u64 = event.data["fee_sats"].as_str().unwrap().parse().unwrap();
        assert!(fee > 0);
        assert!(fee <= crate::core::tx::withdrawal_fee_cap(vault.policy.fee_cap_sats.0, 210_000));
        assert_eq!(op.amount_sats, U64(210_000 - fee));

        let tx = op.unsigned_tx_hex.as_deref().unwrap();
        assert!(tx.starts_with("02000000"), "version 2");
        assert_eq!(
            outputs(tx),
            vec![(210_000 - fee, vault_script_pubkey(&contract, id))]
        );
    }

    #[test]
    fn the_only_output_is_the_vault_address_for_any_inputs() {
        for count in 1..=5u8 {
            let (mut contract, id) = active_vault();
            let coins: Vec<Outpoint> = (1..=count)
                .map(|n| utxo(n, 40_000 * u64::from(n)))
                .collect();
            let op = refresh(&mut contract, id, coins, u32::from(count));
            let found = outputs(op.unsigned_tx_hex.as_deref().unwrap());
            assert_eq!(found.len(), 1, "{count} inputs");
            assert_eq!(found[0].1, vault_script_pubkey(&contract, id));
            assert_eq!(found[0].0, op.amount_sats.0);
        }
    }

    #[test]
    fn the_owner_signs_it_without_a_delay_then_its_coins_are_free() {
        let (mut contract, id) = active_vault();
        let op = refresh(
            &mut contract,
            id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            2,
        );

        // Still at NOW: no Delay before signing.
        for index in 0..2 {
            assert!(matches!(
                contract.sign_input(op.op_id, index),
                near_sdk::PromiseOrValue::Promise(_)
            ));
        }
        assert_eq!(sign_paths(), vec![format!("morrow/v1/{}/vault", id.0); 2]);

        // While frozen, its own coins are reserved against another refresh or a withdrawal.
        for coins in [
            vec![utxo(1, 150_000)],
            vec![utxo(3, 90_000), utxo(2, 60_000)],
        ] {
            let again = coins.clone();
            let message = panic_message(std::panic::AssertUnwindSafe(|| {
                refresh(&mut contract, id, again, 2);
            }));
            assert!(message.contains("ERR_OUTPOINT_RESERVED"), "{message}");
            let message = panic_message(std::panic::AssertUnwindSafe(|| {
                request(&mut contract, id, coins, 50_000);
            }));
            assert!(message.contains("ERR_OUTPOINT_RESERVED"), "{message}");
        }

        contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
        contract.on_signed(op.op_id, 1, Ok(signing_mpc(0x22)));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Signed);
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "op_signed"
        );
        // Signed is terminal: the reservation is released.
        let next = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        assert_eq!(contract.get_op(next).state, SpendOpState::Pending);
    }

    #[test]
    fn a_refused_refresh_stores_no_op_and_reserves_nothing() {
        let (mut contract, id) = active_vault();
        let next_op_id = contract.next_op_id;
        let message = panic_message(std::panic::AssertUnwindSafe(|| {
            refresh(
                &mut contract,
                id,
                vec![utxo(1, 150_000), utxo(2, 60_000)],
                100,
            );
        }));
        assert!(message.contains("ERR_FEE_TOO_HIGH"), "{message}");
        assert_eq!(contract.next_op_id, next_op_id);
        let op = request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        assert_eq!(op, U64(next_op_id));
    }

    #[test]
    fn rejects_fees_over_the_cap_and_dust_outputs() {
        expect_panic("ERR_FEE_TOO_HIGH", || {
            let (mut contract, id) = active_vault();
            refresh(
                &mut contract,
                id,
                vec![utxo(1, 150_000), utxo(2, 60_000)],
                100,
            );
        });
        // A coin this small trips the 5% cap at any positive rate; at 0 sat/vB the output is dust.
        expect_panic("ERR_INSUFFICIENT_FUNDS", || {
            let (mut contract, id) = active_vault();
            refresh(&mut contract, id, vec![utxo(1, 500)], 0);
        });
    }

    #[test]
    fn rejects_coins_held_by_a_pending_withdrawal() {
        expect_panic("ERR_OUTPOINT_RESERVED", || {
            let (mut contract, id) = active_vault();
            request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
            refresh(
                &mut contract,
                id,
                vec![utxo(2, 60_000), utxo(1, 150_000)],
                2,
            );
        });
    }

    #[test]
    fn only_the_owner_refreshes() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            expect_panic("ERR_UNAUTHORIZED", move || {
                let (mut contract, id) = active_vault();
                as_caller(caller);
                contract.refresh(id, vec![utxo(1, 150_000)], 2, envelope(), None);
            });
        }
    }

    #[test]
    fn needs_an_active_vault() {
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            as_caller("emma.testnet");
            contract.begin_clawback(id, vec![utxo(1, 150_000)], 2, None);
            refresh(&mut contract, id, vec![utxo(2, 150_000)], 2);
        });
        expect_panic("ERR_VAULT_NOT_ACTIVE", || {
            let mut contract = testnet_contract(vec![]);
            context("owner.testnet", MIN_VAULT_STORAGE);
            let id = create(&mut contract, standard_policy());
            refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
        });
    }

    #[test]
    fn a_clawback_voids_a_frozen_refresh() {
        let (mut contract, id) = active_vault();
        let op = refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
        as_caller("emma.testnet");
        contract.begin_clawback(id, vec![utxo(1, 150_000)], 2, None);
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Voided);
    }

    #[test]
    fn rejects_bad_envelopes_and_inputs() {
        expect_panic("ERR_BAD_ENVELOPE", || {
            let (mut contract, id) = active_vault();
            as_caller("owner.testnet");
            contract.refresh(id, vec![utxo(1, 150_000)], 2, "a".repeat(159), None);
        });
        expect_panic("ERR_NO_INPUTS", || {
            let (mut contract, id) = active_vault();
            refresh(&mut contract, id, vec![], 2);
        });
        expect_panic("ERR_TOO_MANY_INPUTS", || {
            let (mut contract, id) = active_vault();
            refresh(
                &mut contract,
                id,
                (1..=6).map(|n| utxo(n, 50_000)).collect(),
                2,
            );
        });
        expect_panic("ERR_OUTPOINT_RESERVED", || {
            let (mut contract, id) = active_vault();
            refresh(&mut contract, id, vec![utxo(1, 50_000), utxo(1, 50_000)], 2);
        });
    }

    #[test]
    fn only_the_owner_signs_a_refresh() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            expect_panic("ERR_UNAUTHORIZED", move || {
                let (mut contract, id) = active_vault();
                let op = refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
                as_caller(caller);
                let _ = contract.sign_input(op.op_id, 0);
            });
        }
    }

    fn delay(contract: &VaultContract, id: U64) -> u64 {
        contract.get_vault(id).policy.delay_ns.0
    }

    fn refresh_at(contract: &mut VaultContract, id: U64, utxos: Vec<Outpoint>, at: u64) -> SpendOp {
        at_time("owner.testnet", at);
        contract.refresh(id, utxos, 2, envelope(), None)
    }

    /// The newest refresh's fate does not matter: the next one waits one Delay from its creation.
    fn waits_one_delay_after(settle: impl Fn(&mut VaultContract, &SpendOp)) {
        let (mut contract, id) = active_vault();
        let first = refresh(
            &mut contract,
            id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            2,
        );
        settle(&mut contract, &first);
        let delay = delay(&contract, id);
        for at in [NOW, NOW + delay - 1] {
            let message = panic_message(std::panic::AssertUnwindSafe(|| {
                refresh_at(&mut contract, id, vec![utxo(3, 150_000)], at);
            }));
            assert!(message.contains("ERR_REFRESH_TOO_SOON"), "{message}");
        }
        let next = refresh_at(&mut contract, id, vec![utxo(3, 150_000)], NOW + delay);
        assert_eq!(next.state, SpendOpState::Frozen);
        assert_eq!(next.created_at, U64(NOW + delay));
        // The clock now runs from the newest refresh.
        let message = panic_message(std::panic::AssertUnwindSafe(|| {
            refresh_at(
                &mut contract,
                id,
                vec![utxo(4, 150_000)],
                NOW + 2 * delay - 1,
            );
        }));
        assert!(message.contains("ERR_REFRESH_TOO_SOON"), "{message}");
    }

    #[test]
    fn one_refresh_per_delay_after_a_frozen_one() {
        waits_one_delay_after(|_, _| {});
    }

    #[test]
    fn one_refresh_per_delay_after_a_signed_one() {
        waits_one_delay_after(|contract, op| {
            contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
            contract.on_signed(op.op_id, 1, Ok(signing_mpc(0x22)));
            assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Signed);
        });
    }

    #[test]
    fn one_refresh_per_delay_after_a_cancelled_one() {
        waits_one_delay_after(|contract, op| {
            as_caller("owner.testnet");
            contract.cancel(op.op_id, Some(envelope()));
            assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Cancelled);
        });
    }

    #[test]
    fn one_refresh_per_delay_after_a_voided_one() {
        // Only a Clawback voids an op, and it closes the Vault; set the state directly to show
        // the rate limit ignores what became of the newest refresh.
        waits_one_delay_after(|contract, op| {
            contract.ops.get_mut(&op.op_id.0).unwrap().state = SpendOpState::Voided;
        });
    }

    #[test]
    fn other_ops_do_not_hide_the_newest_refresh() {
        let (mut contract, id) = active_vault();
        refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
        request(&mut contract, id, vec![utxo(2, 150_000)], 100_000);
        expect_panic("ERR_REFRESH_TOO_SOON", move || {
            refresh(&mut contract, id, vec![utxo(3, 150_000)], 2);
        });
    }

    #[test]
    fn the_owner_cancels_a_refresh_that_is_not_fully_signed() {
        for signed in [0, 1] {
            let (mut contract, id) = active_vault();
            let coins = vec![utxo(1, 150_000), utxo(2, 60_000)];
            let op = refresh(&mut contract, id, coins.clone(), 2);
            for index in 0..signed {
                contract.on_signed(op.op_id, index, Ok(signing_mpc(0x11)));
            }
            as_caller("owner.testnet");
            contract.cancel(op.op_id, Some(envelope()));
            assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Cancelled);
            let event = contract.events_since(U64(0), 100).pop().unwrap();
            assert_eq!(event.kind, "refresh_cancelled");
            assert_eq!(event.data["op_id"], op.op_id.0.to_string());
            assert_eq!(event.data["by"], "owner.testnet");
            // Its coins are free again.
            let next = request(&mut contract, id, coins, 100_000);
            assert_eq!(contract.get_op(next).state, SpendOpState::Pending);
        }
    }

    #[test]
    fn a_fully_signed_refresh_cannot_be_cancelled() {
        expect_panic("ERR_BAD_OP_STATE", || {
            let (mut contract, id) = active_vault();
            let op = refresh(
                &mut contract,
                id,
                vec![utxo(1, 150_000), utxo(2, 60_000)],
                2,
            );
            contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
            contract.on_signed(op.op_id, 1, Ok(signing_mpc(0x22)));
            contract.cancel(op.op_id, Some(envelope()));
        });
    }

    #[test]
    fn only_the_owner_with_an_envelope_cancels_a_refresh() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            expect_panic("ERR_UNAUTHORIZED", move || {
                let (mut contract, id) = active_vault();
                let op = refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
                as_caller(caller);
                contract.cancel(op.op_id, None);
            });
        }
        expect_panic("ERR_BAD_ENVELOPE", || {
            let (mut contract, id) = active_vault();
            let op = refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
            contract.cancel(op.op_id, None);
        });
    }

    #[test]
    fn refuses_a_vault_address_that_is_not_its_script() {
        expect_panic("ERR_BAD_KEY", || {
            let (mut contract, id) = active_vault();
            let other = contract.get_vault(id).policy.recovery_address;
            contract
                .vaults
                .get_mut(&id.0)
                .unwrap()
                .addresses
                .as_mut()
                .unwrap()
                .vault = other;
            refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
        });
    }

    fn refresh_from(
        contract: &mut VaultContract,
        id: U64,
        utxos: Vec<Outpoint>,
        source: SpendSource,
    ) -> SpendOp {
        as_caller("owner.testnet");
        contract.refresh(id, utxos, 2, envelope(), Some(source))
    }

    #[test]
    fn an_allowance_refresh_pays_only_the_allowance_address() {
        let (mut contract, id) = two_address_vault();
        let coins = vec![utxo(1, 150_000), utxo(2, 60_000)];
        let op = refresh_from(&mut contract, id, coins, SpendSource::Allowance);
        assert_eq!(op.kind, SpendOpKind::Refresh);
        assert_eq!(op.source, SpendSource::Allowance);
        assert_eq!(op.state, SpendOpState::Frozen);
        let addresses = contract.get_vault(id).addresses.unwrap();
        assert_eq!(op.destination, addresses.allowance);
        assert_eq!(
            op.witness_template.as_ref().map(|t| t.path.as_str()),
            Some("withdrawal")
        );
        let kit = contract.get_vault_kit(id);
        let allowance = p2wsh_script_pubkey(&from_hex(&kit.allowance_script_hex).unwrap());
        assert_ne!(allowance, vault_script_pubkey(&contract, id));
        assert_eq!(
            outputs(op.unsigned_tx_hex.as_deref().unwrap()),
            vec![(op.amount_sats.0, allowance)]
        );
        // The same coins and rate from the Vault Address sign with the other script.
        let (mut other, other_id) = two_address_vault();
        let from_vault = refresh_from(
            &mut other,
            other_id,
            vec![utxo(1, 150_000), utxo(2, 60_000)],
            SpendSource::Vault,
        );
        assert_ne!(from_vault.sighashes, op.sighashes);

        as_caller("owner.testnet");
        for index in 0..2 {
            let _ = contract.sign_input(op.op_id, index);
        }
        assert_eq!(
            sign_paths(),
            vec![format!("morrow/v1/{}/allowance", id.0); 2]
        );
    }

    #[test]
    fn the_rate_limit_counts_per_source() {
        let (mut contract, id) = two_address_vault();
        refresh_from(
            &mut contract,
            id,
            vec![utxo(1, 150_000)],
            SpendSource::Vault,
        );
        let allowance = refresh_from(
            &mut contract,
            id,
            vec![utxo(2, 150_000)],
            SpendSource::Allowance,
        );
        assert_eq!(allowance.state, SpendOpState::Frozen);
        for source in [SpendSource::Allowance, SpendSource::Vault] {
            let message = panic_message(std::panic::AssertUnwindSafe(|| {
                refresh_from(&mut contract, id, vec![utxo(3, 150_000)], source);
            }));
            assert!(message.contains("ERR_REFRESH_TOO_SOON"), "{message}");
        }
        // An allowance refresh first does not block the Vault's either.
        let (mut contract, id) = two_address_vault();
        refresh_from(
            &mut contract,
            id,
            vec![utxo(1, 150_000)],
            SpendSource::Allowance,
        );
        refresh_from(
            &mut contract,
            id,
            vec![utxo(2, 150_000)],
            SpendSource::Vault,
        );
    }

    #[test]
    fn the_owner_cancels_an_allowance_refresh() {
        let (mut contract, id) = two_address_vault();
        let coins = vec![utxo(1, 150_000), utxo(2, 60_000)];
        let op = refresh_from(&mut contract, id, coins.clone(), SpendSource::Allowance);
        contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
        as_caller("owner.testnet");
        contract.cancel(op.op_id, Some(envelope()));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Cancelled);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "refresh_cancelled");
        // Its coins are free again; the allowance clock still runs.
        let next = request(&mut contract, id, coins, 100_000);
        assert_eq!(contract.get_op(next).state, SpendOpState::Pending);
        expect_panic("ERR_REFRESH_TOO_SOON", move || {
            refresh_from(
                &mut contract,
                id,
                vec![utxo(3, 150_000)],
                SpendSource::Allowance,
            );
        });
    }

    #[test]
    fn refuses_an_allowance_address_that_is_not_its_script() {
        expect_panic("ERR_BAD_KEY", || {
            let (mut contract, id) = two_address_vault();
            let vault = contract.get_vault(id).addresses.unwrap().vault;
            contract
                .vaults
                .get_mut(&id.0)
                .unwrap()
                .addresses
                .as_mut()
                .unwrap()
                .allowance = vault;
            refresh_from(
                &mut contract,
                id,
                vec![utxo(1, 150_000)],
                SpendSource::Allowance,
            );
        });
    }
}

mod allowance {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::address::p2wsh_script_pubkey;
    use crate::core::script::from_hex;
    use crate::core::spend::{Outpoint, SpendOpKind, SpendOpState, SpendSource};

    fn spend(contract: &mut VaultContract, id: U64, utxos: Vec<Outpoint>, amount: u64) -> SpendOp {
        as_caller("owner.testnet");
        contract.spend_allowance(id, U64(amount), DESTINATION.into(), 2, utxos, envelope())
    }

    fn spend_at(
        contract: &mut VaultContract,
        id: U64,
        utxos: Vec<Outpoint>,
        amount: u64,
        at: u64,
    ) -> SpendOp {
        at_time("owner.testnet", at);
        contract.spend_allowance(id, U64(amount), DESTINATION.into(), 2, utxos, envelope())
    }

    fn allowance_script_pubkey(contract: &VaultContract, id: U64) -> Vec<u8> {
        let kit = contract.get_vault_kit(id);
        p2wsh_script_pubkey(&from_hex(&kit.allowance_script_hex).unwrap())
    }

    fn destination_script_pubkey() -> Vec<u8> {
        crate::core::address::script_pubkey(DESTINATION, BtcNetwork::Signet).unwrap()
    }

    fn with_limit(limit: u64) -> Policy {
        Policy {
            allowance_limit_sats: U64(limit),
            ..standard_policy()
        }
    }

    /// Runs `f` on a fresh two-address Vault and asserts it panics with `expected`.
    fn rejects(expected: &str, f: impl FnOnce(&mut VaultContract, U64) + std::panic::UnwindSafe) {
        expect_panic(expected, move || {
            let (mut contract, id) = two_address_vault();
            f(&mut contract, id);
        });
    }

    /// Asserts a refused call left no op, no op id, no event and no reservation behind.
    fn refused_and_stored_nothing(
        contract: &mut VaultContract,
        id: U64,
        expected: &str,
        coins: Vec<Outpoint>,
        f: impl FnOnce(&mut VaultContract),
    ) {
        let next_op_id = contract.next_op_id;
        let events = contract.events_since(U64(0), 100).len();
        let message = panic_message(std::panic::AssertUnwindSafe(|| f(contract)));
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
        assert_eq!(contract.next_op_id, next_op_id);
        assert!(contract.ops.get(&next_op_id).is_none());
        assert_eq!(contract.events_since(U64(0), 100).len(), events);
        // The refused call's coins are free: a withdrawal takes them, with the next op id.
        let total: u64 = coins.iter().map(|c| c.value_sats.0).sum();
        let op = request(contract, id, coins, total);
        assert_eq!(op, U64(next_op_id));
    }

    #[test]
    fn freezes_a_payment_with_change_back_to_the_allowance_address() {
        let (mut contract, id) = two_address_vault();
        let storage_before = contract.get_vault(id).storage_balance.0;
        let op = spend(
            &mut contract,
            id,
            vec![utxo(1, 50_000), utxo(2, 30_000)],
            60_000,
        );

        assert_eq!(op, contract.get_op(op.op_id));
        assert_eq!(op.kind, SpendOpKind::Allowance);
        assert_eq!(op.source, SpendSource::Allowance);
        assert_eq!(op.state, SpendOpState::Frozen);
        assert_eq!(op.amount_sats, U64(60_000));
        assert_eq!(op.destination, DESTINATION);
        assert_eq!(op.executable_at, None);
        assert_eq!(op.created_at, U64(NOW));
        assert_eq!(op.fee_rate_sat_vb, 2);
        assert_eq!(op.sighashes.len(), 2);
        assert_eq!(op.signatures, vec![None, None]);
        assert_eq!(
            op.witness_template.as_ref().map(|t| t.path.as_str()),
            Some("withdrawal")
        );
        assert!(contract.get_vault(id).storage_balance.0 < storage_before);

        let events = contract.events_since(U64(0), 100);
        let frozen = &events[events.len() - 2];
        assert_eq!(frozen.kind, "op_frozen");
        assert_eq!(frozen.data["op_id"], op.op_id.0.to_string());
        assert_eq!(frozen.data["kind"], "allowance");
        assert_eq!(frozen.data["envelope"], envelope());
        let fee: u64 = frozen.data["fee_sats"].as_str().unwrap().parse().unwrap();
        assert!(fee > 0 && fee <= crate::core::tx::withdrawal_fee_cap(100_000, 60_000));
        let spent = events.last().unwrap();
        assert_eq!(spent.kind, "allowance_spent");
        assert_eq!(spent.data["op_id"], op.op_id.0.to_string());
        assert_eq!(spent.data["amount_sats"], "60000");
        assert_eq!(spent.data["destination"], DESTINATION);
        assert_eq!(spent.data["window_sats"], "60000");

        let tx = op.unsigned_tx_hex.as_deref().unwrap();
        assert!(tx.starts_with("02000000"), "version 2");
        assert_eq!(
            crate::core::tx::test_support::sequences(&from_hex(tx).unwrap()),
            vec![crate::core::tx::RBF_SEQUENCE; 2],
            "RBF on every input"
        );
        let change = allowance_script_pubkey(&contract, id);
        let kit = contract.get_vault_kit(id);
        assert_ne!(
            change,
            p2wsh_script_pubkey(&from_hex(&kit.vault_script_hex).unwrap())
        );
        assert_eq!(
            outputs(tx),
            vec![
                (60_000, destination_script_pubkey()),
                (80_000 - 60_000 - fee, change),
            ]
        );
    }

    #[test]
    fn signs_with_the_allowance_script_not_the_vault_one() {
        use crate::core::script::hex;
        use crate::core::tx::{build_payment, withdrawal_fee_cap, PaymentPlan};
        let (mut contract, id) = two_address_vault();
        let coins = vec![utxo(1, 50_000), utxo(2, 30_000)];
        let op = spend(&mut contract, id, coins.clone(), 60_000);
        let kit = contract.get_vault_kit(id);
        let allowance_script = from_hex(&kit.allowance_script_hex).unwrap();
        let vault_script = from_hex(&kit.vault_script_hex).unwrap();
        let change_to = p2wsh_script_pubkey(&allowance_script);
        let destination = destination_script_pubkey();
        // Two builds that differ only in the witness script.
        let build = |witness_script: &[u8]| {
            build_payment(&PaymentPlan {
                inputs: &coins,
                amount_sats: 60_000,
                destination: &destination,
                change_to: &change_to,
                fee_rate_sat_vb: 2,
                fee_cap_sats: withdrawal_fee_cap(100_000, 60_000),
                witness_script,
            })
            .unwrap()
        };
        let (with_allowance, with_vault) = (build(&allowance_script), build(&vault_script));
        assert_eq!(with_allowance.unsigned, with_vault.unsigned);
        let hexes = |s: &[[u8; 32]]| s.iter().map(|h| hex(h)).collect::<Vec<_>>();
        assert_eq!(op.unsigned_tx_hex, Some(hex(&with_allowance.unsigned)));
        assert_eq!(op.sighashes, hexes(&with_allowance.sighashes));
        assert_ne!(op.sighashes, hexes(&with_vault.sighashes));
    }

    #[test]
    fn folds_dust_change_into_the_fee() {
        let (mut contract, id) = two_address_vault();
        let op = spend(&mut contract, id, vec![utxo(1, 60_500)], 60_000);
        let tx = op.unsigned_tx_hex.as_deref().unwrap();
        assert_eq!(outputs(tx), vec![(60_000, destination_script_pubkey())]);
        let events = contract.events_since(U64(0), 100);
        assert_eq!(events[events.len() - 2].data["fee_sats"], "500");
    }

    #[test]
    fn the_rolling_window_refuses_a_spend_over_the_limit_and_stores_nothing() {
        let (mut contract, id) = two_address_vault();
        let first = spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        let day = 24 * crate::core::policy::HOUR_NS;
        for (n, at) in [(2, NOW), (3, NOW + day - 1)] {
            refused_and_stored_nothing(
                &mut contract,
                id,
                "ERR_ALLOWANCE_LIMIT",
                vec![utxo(n, 70_000)],
                |c| {
                    spend_at(c, id, vec![utxo(n, 70_000)], 50_000, at);
                },
            );
        }
        // The first spend leaves the window at created_at + 24 h.
        assert_eq!(first.created_at, U64(NOW));
        let next = spend_at(&mut contract, id, vec![utxo(4, 70_000)], 50_000, NOW + day);
        assert_eq!(next.state, SpendOpState::Frozen);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.data["window_sats"], "50000");
    }

    #[test]
    fn the_window_may_reach_the_limit_exactly() {
        let (mut contract, id) = two_address_vault();
        spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        spend(&mut contract, id, vec![utxo(2, 50_000)], 40_000);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.data["window_sats"], "100000");
        expect_panic("ERR_ALLOWANCE_LIMIT", move || {
            spend(&mut contract, id, vec![utxo(3, 50_000)], 546);
        });
    }

    #[test]
    fn a_signed_spend_still_counts() {
        let (mut contract, id) = two_address_vault();
        let op = spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Signed);
        expect_panic("ERR_ALLOWANCE_LIMIT", move || {
            spend(&mut contract, id, vec![utxo(2, 70_000)], 50_000);
        });
    }

    #[test]
    fn cancelled_and_voided_spends_do_not_count() {
        // A Clawback voids a Frozen spend but also closes the Vault: set the state directly to
        // show the window skips both (the Owner's cancel is tested below).
        for state in [SpendOpState::Cancelled, SpendOpState::Voided] {
            let (mut contract, id) = two_address_vault();
            let op = spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
            contract.ops.get_mut(&op.op_id.0).unwrap().state = state;
            let next = spend(&mut contract, id, vec![utxo(2, 70_000)], 60_000);
            assert_eq!(next.state, SpendOpState::Frozen);
            let event = contract.events_since(U64(0), 100).pop().unwrap();
            assert_eq!(event.data["window_sats"], "60000", "{state:?}");
        }
    }

    #[test]
    fn other_ops_do_not_count_toward_the_window() {
        let (mut contract, id) = two_address_vault();
        request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        as_caller("owner.testnet");
        contract.refresh(
            id,
            vec![utxo(2, 150_000)],
            2,
            envelope(),
            Some(SpendSource::Allowance),
        );
        let op = spend(&mut contract, id, vec![utxo(3, 120_000)], 100_000);
        assert_eq!(op.state, SpendOpState::Frozen);
    }

    #[test]
    fn a_limit_of_zero_refuses_every_spend_before_looking_at_the_coins() {
        let bad_txid = Outpoint {
            txid: "not-a-txid".into(),
            ..utxo(1, 1)
        };
        for coins in [
            vec![utxo(1, 150_000)],
            vec![],
            (1..=6).map(|n| utxo(n, 1)).collect(),
            vec![utxo(1, 1), utxo(1, 1)],
            vec![bad_txid],
        ] {
            for amount in [546, 60_000, u64::MAX] {
                let coins = coins.clone();
                expect_panic("ERR_ALLOWANCE_LIMIT", move || {
                    let (mut contract, id) = active_vault_with(with_limit(0));
                    spend(&mut contract, id, coins, amount);
                });
            }
        }
        // Coins a live withdrawal holds are not even checked.
        expect_panic("ERR_ALLOWANCE_LIMIT", || {
            let (mut contract, id) = active_vault_with(with_limit(0));
            request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
            spend(&mut contract, id, vec![utxo(1, 150_000)], 546);
        });
    }

    #[test]
    fn the_owner_signs_every_input_on_the_allowance_path() {
        let (mut contract, id) = two_address_vault();
        let op = spend(
            &mut contract,
            id,
            vec![utxo(1, 50_000), utxo(2, 30_000)],
            60_000,
        );
        // No Delay before signing.
        for index in 0..2 {
            assert!(matches!(
                contract.sign_input(op.op_id, index),
                near_sdk::PromiseOrValue::Promise(_)
            ));
        }
        assert_eq!(
            sign_paths(),
            vec![format!("morrow/v1/{}/allowance", id.0); 2]
        );
        contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
        contract.on_signed(op.op_id, 1, Ok(signing_mpc(0x22)));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Signed);
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "op_signed"
        );
        // Signed is terminal: its coins are free again.
        let next = request(&mut contract, id, vec![utxo(1, 50_000)], 40_000);
        assert_eq!(contract.get_op(next).state, SpendOpState::Pending);
    }

    #[test]
    fn only_the_owner_signs_an_allowance_spend() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            rejects("ERR_UNAUTHORIZED", move |contract, id| {
                let op = spend(contract, id, vec![utxo(1, 70_000)], 60_000);
                as_caller(caller);
                let _ = contract.sign_input(op.op_id, 0);
            });
        }
    }

    #[test]
    fn rejects_short_funds_zero_amounts_and_high_fees() {
        rejects("ERR_INSUFFICIENT_FUNDS", |contract, id| {
            spend(contract, id, vec![utxo(1, 60_000)], 60_000);
        });
        rejects("ERR_INSUFFICIENT_FUNDS", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000)], 60_000);
        });
        rejects("ERR_INSUFFICIENT_FUNDS", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000)], 0);
        });
        // 5% of the amount binds: 3,000 sats on 60,000.
        rejects("ERR_FEE_TOO_HIGH", |contract, id| {
            as_caller("owner.testnet");
            contract.spend_allowance(
                id,
                U64(60_000),
                DESTINATION.into(),
                100,
                vec![utxo(1, 150_000)],
                envelope(),
            );
        });
        // The Fee Cap binds: 10,000 sats on 900,000 (5% would be 45,000).
        expect_panic("ERR_FEE_TOO_HIGH", || {
            let (mut contract, id) = active_vault_with(Policy {
                allowance_limit_sats: U64(1_000_000),
                fee_cap_sats: U64(10_000),
                ..standard_policy()
            });
            as_caller("owner.testnet");
            contract.spend_allowance(
                id,
                U64(900_000),
                DESTINATION.into(),
                100,
                vec![utxo(1, 1_000_000)],
                envelope(),
            );
        });
    }

    #[test]
    fn a_refused_spend_stores_no_op_and_reserves_nothing() {
        let (mut contract, id) = two_address_vault();
        let coins = vec![utxo(1, 150_000), utxo(2, 60_000)];
        let again = coins.clone();
        refused_and_stored_nothing(&mut contract, id, "ERR_FEE_TOO_HIGH", coins, move |c| {
            as_caller("owner.testnet");
            c.spend_allowance(id, U64(60_000), DESTINATION.into(), 100, again, envelope());
        });
        // Nothing counts toward the window either.
        let op = spend(&mut contract, id, vec![utxo(3, 120_000)], 100_000);
        assert_eq!(op.state, SpendOpState::Frozen);
    }

    #[test]
    fn rejects_bad_inputs_and_reserved_coins() {
        rejects("ERR_NO_INPUTS", |contract, id| {
            spend(contract, id, vec![], 60_000);
        });
        rejects("ERR_TOO_MANY_INPUTS", |contract, id| {
            spend(
                contract,
                id,
                (1..=6).map(|n| utxo(n, 20_000)).collect(),
                60_000,
            );
        });
        rejects("ERR_OUTPOINT_RESERVED", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000), utxo(1, 50_000)], 60_000);
        });
        rejects("ERR_OUTPOINT_RESERVED", |contract, id| {
            request(contract, id, vec![utxo(1, 150_000)], 100_000);
            spend(
                contract,
                id,
                vec![utxo(2, 50_000), utxo(1, 150_000)],
                60_000,
            );
        });
        // A Frozen allowance spend holds its coins against a withdrawal and another spend.
        rejects("ERR_OUTPOINT_RESERVED", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000)], 20_000);
            request(contract, id, vec![utxo(1, 50_000)], 20_000);
        });
        rejects("ERR_OUTPOINT_RESERVED", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000)], 20_000);
            spend(contract, id, vec![utxo(1, 50_000)], 20_000);
        });
    }

    #[test]
    fn only_the_owner_with_an_envelope_spends_on_an_active_vault() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            rejects("ERR_UNAUTHORIZED", move |contract, id| {
                as_caller(caller);
                contract.spend_allowance(
                    id,
                    U64(60_000),
                    DESTINATION.into(),
                    2,
                    vec![utxo(1, 70_000)],
                    envelope(),
                );
            });
        }
        rejects("ERR_BAD_ENVELOPE", |contract, id| {
            as_caller("owner.testnet");
            contract.spend_allowance(
                id,
                U64(60_000),
                DESTINATION.into(),
                2,
                vec![utxo(1, 70_000)],
                "a".repeat(159),
            );
        });
        rejects("ERR_CLAWED_BACK", |contract, id| {
            as_caller("emma.testnet");
            contract.begin_clawback(id, vec![utxo(1, 150_000)], 2, None);
            spend(contract, id, vec![utxo(2, 70_000)], 60_000);
        });
        expect_panic("ERR_VAULT_NOT_ACTIVE", || {
            let mut contract = testnet_contract(vec![]);
            context("owner.testnet", MIN_VAULT_STORAGE);
            let id = create(&mut contract, standard_policy());
            spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        });
    }

    #[test]
    fn rejects_bad_destinations_and_a_wrong_allowance_address() {
        rejects("ERR_BAD_ADDRESS", |contract, id| {
            as_caller("owner.testnet");
            contract.spend_allowance(
                id,
                U64(60_000),
                "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".into(),
                2,
                vec![utxo(1, 70_000)],
                envelope(),
            );
        });
        rejects("ERR_BAD_KEY", |contract, id| {
            let vault = contract.get_vault(id).addresses.unwrap().vault;
            contract
                .vaults
                .get_mut(&id.0)
                .unwrap()
                .addresses
                .as_mut()
                .unwrap()
                .allowance = vault;
            spend(contract, id, vec![utxo(1, 70_000)], 60_000);
        });
    }

    #[test]
    fn an_applied_limit_of_zero_refuses_later_spends() {
        let (mut contract, id) = two_address_vault();
        spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        as_caller("owner.testnet");
        let change_id = contract.propose_policy_change(
            id,
            near_sdk::serde_json::json!({ "allowance_limit_sats": "0" }),
            envelope(),
        );
        // Still the old limit while the change waits.
        spend(&mut contract, id, vec![utxo(2, 70_000)], 40_000);
        let effective_at = contract.get_policy_change(change_id).effective_at.0;
        at_time("anyone.testnet", effective_at);
        contract.apply_policy_change(change_id);
        expect_panic("ERR_ALLOWANCE_LIMIT", move || {
            spend_at(&mut contract, id, vec![utxo(3, 70_000)], 546, effective_at);
        });
    }

    #[test]
    fn a_clawback_voids_a_frozen_spend_and_sweeps_the_allowance_address() {
        let (mut contract, id) = two_address_vault();
        let op = spend(&mut contract, id, vec![utxo(1, 70_000)], 60_000);
        as_caller("emma.testnet");
        let clawback =
            contract.begin_clawback(id, vec![utxo(1, 70_000)], 2, Some(SpendSource::Allowance));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Voided);
        let sweep = contract.get_op(clawback);
        assert_eq!(sweep.source, SpendSource::Allowance);
        assert_eq!(sweep.state, SpendOpState::Frozen);
        assert_eq!(
            sweep.destination,
            contract.get_vault(id).policy.recovery_address
        );
        let voided = contract
            .events_since(U64(0), 100)
            .into_iter()
            .find(|e| e.kind == "op_voided")
            .unwrap();
        assert_eq!(voided.data["op_id"], op.op_id.0.to_string());
        // A voided spend can no longer be signed.
        expect_panic("ERR_CLAWED_BACK", move || {
            as_caller("owner.testnet");
            let _ = contract.sign_input(op.op_id, 0);
        });
    }

    #[test]
    fn the_window_scans_newest_first_across_its_edge() {
        let day = 24 * crate::core::policy::HOUR_NS;
        let (mut contract, id) = two_address_vault();
        spend_at(&mut contract, id, vec![utxo(1, 70_000)], 60_000, NOW);
        spend_at(
            &mut contract,
            id,
            vec![utxo(2, 50_000)],
            40_000,
            NOW + day - 1,
        );
        // The 60,000 spend has left the window; the 40,000 one has not.
        let message = panic_message(std::panic::AssertUnwindSafe(|| {
            spend_at(&mut contract, id, vec![utxo(3, 70_000)], 60_001, NOW + day);
        }));
        assert!(message.contains("ERR_ALLOWANCE_LIMIT"), "{message}");
        spend_at(&mut contract, id, vec![utxo(3, 70_000)], 60_000, NOW + day);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.data["window_sats"], "100000");
    }

    #[test]
    fn an_old_first_op_does_not_end_the_scan_early() {
        let day = 24 * crate::core::policy::HOUR_NS;
        let (mut contract, id) = two_address_vault();
        // The Vault's first indexed op is a withdrawal older than 24 h.
        request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        spend_at(
            &mut contract,
            id,
            vec![utxo(2, 70_000)],
            60_000,
            NOW + 2 * day,
        );
        let message = panic_message(std::panic::AssertUnwindSafe(|| {
            spend_at(
                &mut contract,
                id,
                vec![utxo(3, 70_000)],
                50_000,
                NOW + 2 * day,
            );
        }));
        assert!(message.contains("ERR_ALLOWANCE_LIMIT"), "{message}");
        spend_at(
            &mut contract,
            id,
            vec![utxo(3, 70_000)],
            40_000,
            NOW + 2 * day,
        );
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.data["window_sats"], "100000");
    }

    #[test]
    fn a_window_that_would_overflow_is_over_the_limit() {
        // No Policy bound caps the limit, so the window's sum must not wrap.
        let (mut contract, id) = active_vault_with(with_limit(u64::MAX));
        spend(
            &mut contract,
            id,
            vec![utxo(1, u64::MAX)],
            u64::MAX - 20_000,
        );
        spend(&mut contract, id, vec![utxo(2, 40_000)], 20_000);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.data["window_sats"], u64::MAX.to_string());
        expect_panic("ERR_ALLOWANCE_LIMIT", move || {
            spend(&mut contract, id, vec![utxo(3, 40_000)], 20_000);
        });
    }

    #[test]
    fn refuses_an_amount_below_dust() {
        rejects("ERR_INSUFFICIENT_FUNDS", |contract, id| {
            spend(contract, id, vec![utxo(1, 50_000)], 545);
        });
        // 546 is accepted (at 0 sat/vB, so the 5% fee cap of 27 sats holds).
        let (mut contract, id) = two_address_vault();
        as_caller("owner.testnet");
        let op = contract.spend_allowance(
            id,
            U64(546),
            DESTINATION.into(),
            0,
            vec![utxo(1, 50_000)],
            envelope(),
        );
        assert_eq!(op.state, SpendOpState::Frozen);
    }

    #[test]
    fn on_a_limit_of_zero_the_earlier_checks_still_come_first() {
        let zero = || active_vault_with(with_limit(0));
        let call = |contract: &mut VaultContract, id, destination: &str, amount, env: String| {
            contract.spend_allowance(
                id,
                U64(amount),
                destination.into(),
                2,
                vec![utxo(1, 70_000)],
                env,
            );
        };
        expect_panic("ERR_BAD_ADDRESS", move || {
            let (mut contract, id) = zero();
            as_caller("owner.testnet");
            call(
                &mut contract,
                id,
                "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
                0,
                envelope(),
            );
        });
        expect_panic("ERR_INSUFFICIENT_FUNDS", move || {
            let (mut contract, id) = zero();
            as_caller("owner.testnet");
            call(&mut contract, id, DESTINATION, 0, envelope());
        });
        expect_panic("ERR_UNAUTHORIZED", move || {
            let (mut contract, id) = zero();
            as_caller("stranger.testnet");
            call(&mut contract, id, "not-an-address", 0, envelope());
        });
        expect_panic("ERR_BAD_ENVELOPE", move || {
            let (mut contract, id) = zero();
            as_caller("owner.testnet");
            call(&mut contract, id, "not-an-address", 0, "a".repeat(159));
        });
        expect_panic("ERR_CLAWED_BACK", move || {
            let (mut contract, id) = zero();
            as_caller("emma.testnet");
            contract.begin_clawback(id, vec![utxo(9, 150_000)], 2, None);
            as_caller("owner.testnet");
            call(&mut contract, id, "not-an-address", 0, "a".repeat(159));
        });
    }

    /// Cancels a Frozen spend with `signed` of its 2 inputs signed, as the Owner.
    fn cancel_after_signing(signed: u32) {
        let (mut contract, id) = two_address_vault();
        let coins = vec![utxo(1, 50_000), utxo(2, 30_000)];
        let op = spend(&mut contract, id, coins.clone(), 60_000);
        for index in 0..signed {
            contract.on_signed(op.op_id, index, Ok(signing_mpc(0x11)));
        }
        as_caller("owner.testnet");
        contract.cancel(op.op_id, Some(envelope()));
        assert_eq!(contract.get_op(op.op_id).state, SpendOpState::Cancelled);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "allowance_cancelled");
        assert_eq!(event.data["op_id"], op.op_id.0.to_string());
        assert_eq!(event.data["by"], "owner.testnet");
        // The window is free again, and so are the coins.
        let next = spend(&mut contract, id, vec![utxo(3, 120_000)], 100_000);
        assert_eq!(next.state, SpendOpState::Frozen);
        let withdrawal = request(&mut contract, id, coins, 70_000);
        assert_eq!(contract.get_op(withdrawal).state, SpendOpState::Pending);
    }

    #[test]
    fn the_owner_cancels_a_spend_with_no_input_signed() {
        cancel_after_signing(0);
    }

    #[test]
    fn the_owner_cancels_a_spend_with_all_but_one_input_signed() {
        cancel_after_signing(1);
    }

    #[test]
    fn only_the_owner_with_an_envelope_cancels_a_spend_and_never_a_signed_one() {
        for caller in ["emma.testnet", "stranger.testnet"] {
            rejects("ERR_UNAUTHORIZED", move |contract, id| {
                let op = spend(contract, id, vec![utxo(1, 70_000)], 60_000);
                as_caller(caller);
                contract.cancel(op.op_id, None);
            });
        }
        rejects("ERR_BAD_ENVELOPE", |contract, id| {
            let op = spend(contract, id, vec![utxo(1, 70_000)], 60_000);
            contract.cancel(op.op_id, None);
        });
        rejects("ERR_BAD_OP_STATE", |contract, id| {
            let op = spend(contract, id, vec![utxo(1, 70_000)], 60_000);
            contract.on_signed(op.op_id, 0, Ok(signing_mpc(0x11)));
            as_caller("owner.testnet");
            contract.cancel(op.op_id, Some(envelope()));
        });
    }
}

mod policy_change {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::tests::RECOVERY_SIGNET;
    use crate::core::policy::HOUR_NS;
    use near_sdk::serde_json::json;

    const NEW_RECOVERY: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const WEEK: u64 = 7 * DAY_NS;

    fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    fn propose(contract: &mut VaultContract, id: U64, changes: Value) -> U64 {
        as_caller("owner.testnet");
        contract.propose_policy_change(id, changes, envelope())
    }

    fn redirect(contract: &mut VaultContract, id: U64) -> U64 {
        propose(contract, id, json!({ "recovery_address": NEW_RECOVERY }))
    }

    fn rejects_proposal(expected: &str, changes: Value) {
        expect_panic(expected, move || {
            let (mut contract, id) = active_vault();
            propose(&mut contract, id, changes);
        });
    }

    fn claw_destination(contract: &mut VaultContract, id: U64, at: u64) -> String {
        at_time("emma.testnet", at);
        let op_id = contract.begin_clawback(id, vec![utxo(9, 100_000)], 2, None);
        contract.get_op(op_id).destination
    }

    #[test]
    fn a_proposal_waits_in_public_and_reads_return_the_old_policy() {
        let (mut contract, id) = active_vault();
        let change_id = redirect(&mut contract, id);
        assert_eq!(change_id, U64(1));

        let vault = contract.get_vault(id);
        assert_eq!(vault.policy, standard_policy());
        let pending = vault.pending_change.expect("a pending change");
        assert_eq!(pending.change_id, change_id);
        assert_eq!(pending.state, PolicyChangeState::Pending);
        assert_eq!(pending.proposed_at, U64(NOW));
        assert_eq!(pending.effective_at, U64(NOW + WEEK));
        assert_eq!(pending.vetoed_by, None);

        let view = near_sdk::serde_json::to_value(contract.get_vault(id)).unwrap();
        assert_eq!(
            view["pending_change"],
            json!({
                "change_id": "1",
                "vault_id": id.0.to_string(),
                "changes": { "recovery_address": NEW_RECOVERY },
                "proposed_at": NOW.to_string(),
                "effective_at": (NOW + WEEK).to_string(),
                "state": "pending",
                "vetoed_by": null,
            })
        );
        assert_eq!(contract.get_policy_change(change_id), pending);

        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "policy_change_proposed");
        assert_eq!(
            event.data,
            json!({
                "change_id": "1",
                "changes": { "recovery_address": NEW_RECOVERY },
                "effective_at": (NOW + WEEK).to_string(),
                "envelope": envelope(),
            })
        );
    }

    #[test]
    fn a_new_vault_has_no_pending_change() {
        let (contract, id) = active_vault();
        let view = near_sdk::serde_json::to_value(contract.get_vault(id)).unwrap();
        assert_eq!(view["pending_change"], Value::Null);
    }

    #[test]
    fn script_bound_fields_are_rejected() {
        rejects_proposal("ERR_SCRIPT_BOUND", json!({ "escape_timelock_blocks": 1 }));
        rejects_proposal(
            "ERR_SCRIPT_BOUND",
            json!({ "guardians": [], "delay_ns": "3600000000000" }),
        );
        rejects_proposal("ERR_SCRIPT_BOUND", json!({ "btc_network": "regtest" }));
    }

    #[test]
    fn the_resulting_policy_must_pass_creation_bounds() {
        rejects_proposal("ERR_POLICY_BOUNDS", json!({}));
        rejects_proposal("ERR_POLICY_BOUNDS", json!({ "delay_ns": "1" }));
        rejects_proposal(
            "ERR_POLICY_BOUNDS",
            json!({ "delay_ns": 3_600_000_000_000u64 }),
        );
        rejects_proposal(
            "ERR_POLICY_BOUNDS",
            json!({ "policy_change_delay_ns": (6 * DAY_NS).to_string() }),
        );
        rejects_proposal(
            "ERR_POLICY_CHANGE_DELAY",
            json!({ "delay_ns": (8 * DAY_NS).to_string() }),
        );
        rejects_proposal(
            "ERR_BAD_ADDRESS",
            json!({ "recovery_address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }),
        );
    }

    #[test]
    fn only_one_change_is_pending_at_a_time() {
        expect_panic("ERR_CHANGE_PENDING", || {
            let (mut contract, id) = active_vault();
            redirect(&mut contract, id);
            propose(&mut contract, id, json!({ "fee_cap_sats": "20000" }));
        });
    }

    #[test]
    fn only_the_owner_with_an_envelope_proposes() {
        expect_panic("ERR_UNAUTHORIZED", || {
            let (mut contract, id) = active_vault();
            as_caller("emma.testnet");
            contract.propose_policy_change(id, json!({ "fee_cap_sats": "20000" }), envelope());
        });
        expect_panic("ERR_BAD_ENVELOPE", || {
            let (mut contract, id) = active_vault();
            as_caller("owner.testnet");
            contract.propose_policy_change(id, json!({ "fee_cap_sats": "20000" }), "ab".into());
        });
    }

    #[test]
    fn a_proposal_is_charged_to_the_vault_and_fails_when_it_is_short() {
        let (mut contract, id) = active_vault();
        let before = contract.get_vault(id).storage_balance.0;
        redirect(&mut contract, id);
        assert!(contract.get_vault(id).storage_balance.0 < before);

        expect_panic("ERR_STORAGE_BUDGET", || {
            let (mut contract, id) = active_vault();
            contract.vaults.get_mut(&id.0).unwrap().storage_balance = U128(0);
            redirect(&mut contract, id);
        });
    }

    #[test]
    fn a_guardian_vetoes_and_a_clawback_still_pays_the_original_address() {
        let (mut contract, id) = active_vault();
        let change_id = redirect(&mut contract, id);
        // A Guardian's veto never fails on storage.
        contract.vaults.get_mut(&id.0).unwrap().storage_balance = U128(0);
        as_caller("emma.testnet");
        contract.veto_policy_change(change_id, None);

        let vault = contract.get_vault(id);
        assert_eq!(vault.pending_change, None);
        assert_eq!(vault.policy, standard_policy());
        let stored = contract.changes.get(&change_id.0).unwrap();
        assert_eq!(stored.state, PolicyChangeState::Vetoed);
        assert_eq!(
            stored.vetoed_by.as_ref().map(|a| a.as_str()),
            Some("emma.testnet")
        );
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "policy_change_vetoed");
        assert_eq!(
            event.data,
            json!({ "change_id": "1", "by": "emma.testnet" })
        );

        assert_eq!(
            claw_destination(&mut contract, id, NOW + WEEK),
            RECOVERY_SIGNET
        );
    }

    #[test]
    fn a_settled_change_is_found_but_never_reactivated() {
        expect_panic("ERR_CHANGE_NOT_FOUND", || {
            let (mut contract, _) = active_vault();
            as_caller("emma.testnet");
            contract.veto_policy_change(U64(7), None);
        });
        expect_panic("ERR_CHANGE_NOT_FOUND", || {
            let (mut contract, _) = active_vault();
            contract.apply_policy_change(U64(7));
        });
        expect_panic("ERR_BAD_OP_STATE", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            as_caller("emma.testnet");
            contract.veto_policy_change(change_id, None);
            as_caller("backup.testnet");
            contract.veto_policy_change(change_id, None);
        });
        expect_panic("ERR_BAD_OP_STATE", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            as_caller("emma.testnet");
            contract.veto_policy_change(change_id, None);
            at_time("anyone.testnet", NOW + WEEK);
            contract.apply_policy_change(change_id);
        });
    }

    #[test]
    fn the_owner_withdraws_with_an_envelope() {
        let (mut contract, id) = active_vault();
        let change_id = redirect(&mut contract, id);
        as_caller("owner.testnet");
        contract.veto_policy_change(change_id, Some(envelope()));
        assert_eq!(contract.get_vault(id).pending_change, None);
        let stored = contract.changes.get(&change_id.0).unwrap();
        assert_eq!(stored.state, PolicyChangeState::Withdrawn);
        assert_eq!(stored.vetoed_by, None);
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "policy_change_withdrawn");
        assert_eq!(
            event.data,
            json!({ "change_id": "1", "envelope": envelope() })
        );

        expect_panic("ERR_BAD_ENVELOPE", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            contract.veto_policy_change(change_id, None);
        });
        expect_panic("ERR_UNAUTHORIZED", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            as_caller("stranger.testnet");
            contract.veto_policy_change(change_id, Some(envelope()));
        });
    }

    #[test]
    fn nobody_applies_before_effective_at() {
        expect_panic("ERR_CHANGE_NOT_EFFECTIVE", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            at_time("anyone.testnet", NOW + WEEK - 1);
            contract.apply_policy_change(change_id);
        });
    }

    #[test]
    fn a_clawback_during_a_pending_change_pays_the_address_in_effect_and_vetoes_it() {
        let (mut contract, id) = active_vault();
        let change_id = redirect(&mut contract, id);
        assert_eq!(
            claw_destination(&mut contract, id, NOW + WEEK - 1),
            RECOVERY_SIGNET
        );
        assert_eq!(contract.get_vault(id).pending_change, None);
        let settled = contract.get_policy_change(change_id);
        assert_eq!(settled.state, PolicyChangeState::Vetoed);
        assert_eq!(
            settled.vetoed_by.as_ref().map(|a| a.as_str()),
            Some("emma.testnet")
        );
        let vetoed: Vec<_> = contract
            .events_since(U64(0), 100)
            .into_iter()
            .filter(|e| e.kind == "policy_change_vetoed")
            .map(|e| e.data)
            .collect();
        assert_eq!(
            vetoed,
            vec![json!({ "change_id": "1", "by": "emma.testnet" })]
        );
        // A later Clawback finds nothing left to veto.
        at_time("emma.testnet", NOW + WEEK);
        contract.begin_clawback(id, vec![utxo(8, 100_000)], 2, None);
        let count = contract
            .events_since(U64(0), 100)
            .iter()
            .filter(|e| e.kind == "policy_change_vetoed")
            .count();
        assert_eq!(count, 1);
        expect_panic("ERR_CLAWED_BACK", move || {
            at_time("anyone.testnet", NOW + WEEK);
            contract.apply_policy_change(change_id);
        });
    }

    #[test]
    fn anyone_applies_after_effective_at_and_a_clawback_pays_the_new_address() {
        let (mut contract, id) = active_vault();
        let change_id = redirect(&mut contract, id);
        at_time("anyone.testnet", NOW + WEEK);
        contract.apply_policy_change(change_id);
        let vault = contract.get_vault(id);
        assert_eq!(vault.pending_change, None);
        assert_eq!(
            vault.policy,
            Policy {
                recovery_address: NEW_RECOVERY.into(),
                ..standard_policy()
            }
        );
        assert_eq!(
            contract.changes.get(&change_id.0).unwrap().state,
            PolicyChangeState::Applied
        );
        let event = contract.events_since(U64(0), 100).pop().unwrap();
        assert_eq!(event.kind, "policy_change_applied");
        assert_eq!(event.data, json!({ "change_id": "1" }));

        assert_eq!(
            claw_destination(&mut contract, id, NOW + WEEK),
            NEW_RECOVERY
        );
    }

    #[test]
    fn a_shorter_change_delay_still_waits_the_current_one() {
        let (mut contract, id) = active_vault();
        contract
            .vaults
            .get_mut(&id.0)
            .unwrap()
            .policy
            .policy_change_delay_ns = U64(14 * DAY_NS);
        let change_id = propose(
            &mut contract,
            id,
            json!({ "policy_change_delay_ns": WEEK.to_string() }),
        );
        let pending = contract.get_vault(id).pending_change.unwrap();
        assert_eq!(pending.effective_at, U64(NOW + 14 * DAY_NS));
        at_time("anyone.testnet", NOW + 14 * DAY_NS);
        contract.apply_policy_change(change_id);
        assert_eq!(
            contract.get_vault(id).policy.policy_change_delay_ns,
            U64(WEEK)
        );
    }

    #[test]
    fn re_proposing_after_a_veto_gets_a_new_id_and_restarts_the_delay() {
        let (mut contract, id) = active_vault();
        let first = redirect(&mut contract, id);
        at_time("backup.testnet", NOW + HOUR_NS);
        contract.veto_policy_change(first, None);
        at_time("owner.testnet", NOW + 2 * HOUR_NS);
        let second = contract.propose_policy_change(
            id,
            json!({ "recovery_address": NEW_RECOVERY }),
            envelope(),
        );
        assert_eq!(second, U64(2));
        let pending = contract.get_vault(id).pending_change.unwrap();
        assert_eq!(pending.effective_at, U64(NOW + 2 * HOUR_NS + WEEK));
    }

    #[test]
    fn a_clawed_back_vault_takes_no_policy_changes() {
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            let change_id = redirect(&mut contract, id);
            claw_destination(&mut contract, id, NOW);
            contract.veto_policy_change(change_id, None);
        });
        expect_panic("ERR_CLAWED_BACK", || {
            let (mut contract, id) = active_vault();
            claw_destination(&mut contract, id, NOW);
            redirect(&mut contract, id);
        });
    }
}

mod policy_change_more {
    use super::withdrawals_support::*;
    use super::*;
    use crate::core::policy::tests::guardian;
    use crate::core::policy::GuardianKind;
    use near_sdk::serde_json::json;

    const WEEK: u64 = 7 * DAY_NS;

    fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    fn propose(contract: &mut VaultContract, id: U64, changes: Value) -> U64 {
        as_caller("owner.testnet");
        contract.propose_policy_change(id, changes, envelope())
    }

    #[test]
    fn get_policy_change_needs_a_known_id() {
        expect_panic("ERR_CHANGE_NOT_FOUND", || {
            let (contract, _) = active_vault();
            contract.get_policy_change(U64(1));
        });
    }

    #[test]
    fn an_owner_who_is_also_a_guardian_withdraws_with_an_envelope() {
        let owner_guardian = || Policy {
            guardians: vec![
                guardian("22", "owner.testnet", GuardianKind::BackupDevice),
                guardian("33", "emma.testnet", GuardianKind::TrustedContact),
            ],
            ..standard_policy()
        };
        expect_panic("ERR_BAD_ENVELOPE", move || {
            let (mut contract, id) = active_vault_with(owner_guardian());
            let change_id = propose(&mut contract, id, json!({ "fee_cap_sats": "20000" }));
            contract.veto_policy_change(change_id, None);
        });
        let (mut contract, id) = active_vault_with(owner_guardian());
        let change_id = propose(&mut contract, id, json!({ "fee_cap_sats": "20000" }));
        contract.veto_policy_change(change_id, Some(envelope()));
        let settled = contract.get_policy_change(change_id);
        assert_eq!(settled.state, PolicyChangeState::Withdrawn);
        assert_eq!(settled.vetoed_by, None);
    }

    #[test]
    fn a_guardian_of_another_vault_cannot_veto() {
        expect_panic("ERR_UNAUTHORIZED", || {
            let (mut contract, id) = active_vault();
            context("carol.testnet", MIN_VAULT_STORAGE);
            create(
                &mut contract,
                Policy {
                    guardians: vec![guardian("55", "carol.testnet", GuardianKind::BackupDevice)],
                    ..standard_policy()
                },
            );
            let change_id = propose(&mut contract, id, json!({ "fee_cap_sats": "20000" }));
            as_caller("carol.testnet");
            contract.veto_policy_change(change_id, None);
        });
    }

    #[test]
    fn a_multi_field_change_applies_every_field() {
        let (mut contract, id) = active_vault();
        let change_id = propose(
            &mut contract,
            id,
            json!({
                "delay_ns": (10 * DAY_NS).to_string(),
                "policy_change_delay_ns": (14 * DAY_NS).to_string(),
            }),
        );
        at_time("anyone.testnet", NOW + WEEK);
        contract.apply_policy_change(change_id);
        let policy = contract.get_vault(id).policy;
        assert_eq!(policy.delay_ns, U64(10 * DAY_NS));
        assert_eq!(policy.policy_change_delay_ns, U64(14 * DAY_NS));
        // The next change waits the new, longer Policy Change Delay.
        at_time("owner.testnet", NOW + WEEK);
        let next =
            contract.propose_policy_change(id, json!({ "fee_cap_sats": "20000" }), envelope());
        assert_eq!(
            contract.get_policy_change(next).effective_at,
            U64(NOW + WEEK + 14 * DAY_NS)
        );
    }

    #[test]
    fn an_applied_fee_cap_and_allowance_take_effect_in_later_calls() {
        let coin = || vec![utxo(1, 1_000_000)];
        // Control: the Standard Fee Cap lets a 100 sat/vB Refresh through.
        let (mut control, control_id) = active_vault();
        as_caller("owner.testnet");
        control.refresh(control_id, coin(), 100, envelope(), None);

        let (mut contract, id) = active_vault();
        let change_id = propose(
            &mut contract,
            id,
            json!({ "fee_cap_sats": "10000", "allowance_limit_sats": "0" }),
        );
        at_time("anyone.testnet", NOW + WEEK);
        contract.apply_policy_change(change_id);
        let policy = contract.get_vault(id).policy;
        assert_eq!(policy.fee_cap_sats, U64(10_000));
        assert_eq!(policy.allowance_limit_sats, U64(0));
        expect_panic("ERR_FEE_TOO_HIGH", move || {
            at_time("owner.testnet", NOW + WEEK);
            contract.refresh(id, coin(), 100, envelope(), None);
        });
    }
}

mod property;
