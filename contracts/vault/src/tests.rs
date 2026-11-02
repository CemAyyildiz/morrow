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
