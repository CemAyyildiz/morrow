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
    let vault_id = contract.create_vault(OWNER_KEY.to_string(), standard_policy());
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
            contract.create_vault(OWNER_KEY.to_string(), policy);
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
    assert_eq!(contract.create_vault(OWNER_KEY.to_string(), policy), U64(1));
}

#[test]
fn enforces_creator_allowlist_and_minimum_deposit() {
    let message = panic_message(|| {
        let mut contract = testnet_contract(vec!["operator.testnet"]);
        context("stranger.testnet", MIN_VAULT_STORAGE);
        contract.create_vault(OWNER_KEY.to_string(), standard_policy());
    });
    assert!(message.contains("ERR_CREATOR_NOT_ALLOWED"), "{message}");

    let message = panic_message(|| {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", NearToken::from_millinear(490));
        contract.create_vault(OWNER_KEY.to_string(), standard_policy());
    });
    assert!(message.contains("ERR_DEPOSIT_TOO_LOW"), "{message}");

    let mut contract = testnet_contract(vec!["operator.testnet"]);
    context("operator.testnet", MIN_VAULT_STORAGE);
    assert_eq!(
        contract.create_vault(OWNER_KEY.to_string(), standard_policy()),
        U64(1)
    );
}

#[test]
fn rejects_a_malformed_owner_key() {
    let message = panic_message(|| {
        let mut contract = testnet_contract(vec![]);
        context("owner.testnet", MIN_VAULT_STORAGE);
        contract.create_vault("04".repeat(33), standard_policy());
    });
    assert!(message.contains("ERR_BAD_KEY"), "{message}");
}

#[test]
fn pages_events_and_tops_up_storage() {
    let mut contract = testnet_contract(vec![]);
    context("owner.testnet", MIN_VAULT_STORAGE);
    let first = contract.create_vault(OWNER_KEY.to_string(), standard_policy());
    context("owner.testnet", MIN_VAULT_STORAGE);
    let mut second = standard_policy();
    second.guardians[0].kind = GuardianKind::AutoClawback;
    contract.create_vault(OWNER_KEY.to_string(), second);
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
