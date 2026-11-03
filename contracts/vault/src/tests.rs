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
    use crate::core::spend::Outpoint;

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
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        let id = create(&mut contract, standard_policy());
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
            request(c, id, vec![utxo(1, 10)], 5);
            request(c, id, vec![utxo(1, 10)], 5);
        });
        let (mut contract, id) = active_vault();
        let op_id = request(&mut contract, id, vec![utxo(1, 10)], 5);
        as_caller("emma.testnet");
        contract.cancel(op_id, None);
        assert_eq!(contract.get_op(op_id).state, SpendOpState::Cancelled);
        assert_eq!(
            contract.events_since(U64(0), 100).pop().unwrap().kind,
            "withdrawal_cancelled"
        );
        request(&mut contract, id, vec![utxo(1, 10)], 5);
    }

    #[test]
    fn owner_cancels_with_an_envelope_and_strangers_cannot() {
        let (mut contract, id) = active_vault();
        let op_id = request(&mut contract, id, vec![utxo(1, 10)], 5);
        contract.cancel(op_id, Some(envelope()));
        assert_eq!(contract.get_op(op_id).state, SpendOpState::Cancelled);

        rejects("ERR_BAD_ENVELOPE", |c, id| {
            let op = request(c, id, vec![utxo(1, 10)], 5);
            c.cancel(op, None);
        });
        rejects("ERR_UNAUTHORIZED", |c, id| {
            let op = request(c, id, vec![utxo(1, 10)], 5);
            as_caller("stranger.testnet");
            c.cancel(op, None);
        });
        rejects("ERR_BAD_OP_STATE", |c, id| {
            let op = request(c, id, vec![utxo(1, 10)], 5);
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
            request(&mut contract, id, vec![utxo(1, 10)], 5);
        });
        assert!(message.contains("ERR_VAULT_NOT_ACTIVE"), "{message}");
    }

    #[test]
    fn charges_storage_to_the_vault() {
        let (mut contract, id) = active_vault();
        let before = contract.get_vault(id).storage_balance.0;
        request(&mut contract, id, vec![utxo(1, 10)], 5);
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
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;

    fn expect_panic(expected: &str, f: impl FnOnce() + std::panic::UnwindSafe) {
        let message = panic_message(f);
        assert!(
            message.contains(expected),
            "expected {expected}, got {message}"
        );
    }

    fn refresh(contract: &mut VaultContract, id: U64, utxos: Vec<Outpoint>, rate: u32) -> SpendOp {
        as_caller("owner.testnet");
        contract.refresh(id, utxos, rate, envelope())
    }

    /// The outputs of an unsigned (non-witness) transaction: (value, scriptPubKey).
    fn outputs(unsigned_hex: &str) -> Vec<(u64, Vec<u8>)> {
        let tx = from_hex(unsigned_hex).unwrap();
        // Counts and script lengths stay below 0xfd here: every varint is one byte.
        let mut at = 4;
        let inputs = tx[at] as usize;
        at += 1;
        for _ in 0..inputs {
            at += 36;
            at += 1 + tx[at] as usize + 4;
        }
        let count = tx[at] as usize;
        at += 1;
        let mut found = Vec::new();
        for _ in 0..count {
            let value = u64::from_le_bytes(tx[at..at + 8].try_into().unwrap());
            let len = tx[at + 8] as usize;
            found.push((value, tx[at + 9..at + 9 + len].to_vec()));
            at += 9 + len;
        }
        assert_eq!(at + 4, tx.len(), "only the lock time is left");
        found
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
        let paths: Vec<String> = get_created_receipts()
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
            .collect();
        assert_eq!(paths, vec![format!("morrow/v1/{}/vault", id.0); 2]);

        // While frozen, its coins are reserved.
        expect_panic("ERR_OUTPOINT_RESERVED", || {
            let (mut contract, id) = active_vault();
            refresh(&mut contract, id, vec![utxo(1, 150_000)], 2);
            request(&mut contract, id, vec![utxo(1, 150_000)], 100_000);
        });

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

    fn signing_mpc(byte: u8) -> MpcSignature {
        MpcSignature {
            big_r: MpcPoint {
                affine_point: format!("02{}", format!("{byte:02x}").repeat(32)),
            },
            s: MpcScalar {
                scalar: format!("{byte:02x}").repeat(32),
            },
        }
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
                contract.refresh(id, vec![utxo(1, 150_000)], 2, envelope());
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
            contract.refresh(id, vec![utxo(1, 150_000)], 2, "a".repeat(159));
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
}
