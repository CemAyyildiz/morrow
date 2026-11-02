//! Morrow Vault Contract: co-signs Bitcoin spends through NEAR Chain Signatures, only within the
//! Vault's Policy. `core` holds the pure rules; this file is the imperative shell.

pub mod core;
pub mod events;

use crate::core::errors::{ErrorCode, Rejection};
use crate::core::policy::{is_compressed_key, validate_policy, BtcNetwork, Policy};
use crate::events::{record, EventView, StoredEvent, EVENTS_SINCE_MAX_LIMIT};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

/// Minimum `create_vault` deposit: 0.5 NEAR.
pub const MIN_VAULT_STORAGE: NearToken = NearToken::from_millinear(500);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
    Events,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultState {
    PendingKeys,
    Active,
    ClawedBack,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyPair {
    pub vault: String,
    pub allowance: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vault {
    pub vault_id: U64,
    pub owner_account: AccountId,
    pub owner_key: String,
    pub policy: Policy,
    pub state: VaultState,
    pub cosigner_pubkeys: Option<KeyPair>,
    pub addresses: Option<KeyPair>,
    /// Remaining storage deposit in yoctoNEAR.
    pub storage_balance: U128,
    pub created_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct VaultContract {
    signer_account: AccountId,
    allowed_networks: Vec<BtcNetwork>,
    creator_allowlist: Vec<AccountId>,
    vaults: LookupMap<u64, Vault>,
    next_vault_id: u64,
    events: Vector<StoredEvent>,
}

fn reject(rejection: &Rejection) -> ! {
    env::panic_str(&rejection.message())
}

fn fail(code: ErrorCode) -> ! {
    reject(&Rejection::new(code))
}

#[near]
impl VaultContract {
    /// Deployment-level rules. They are fixed forever: no method changes them.
    #[init]
    pub fn new(
        signer_account: AccountId,
        allowed_networks: Vec<BtcNetwork>,
        creator_allowlist: Vec<AccountId>,
    ) -> Self {
        if allowed_networks.is_empty() {
            fail(ErrorCode::NetworkNotAllowed);
        }
        Self {
            signer_account,
            allowed_networks,
            creator_allowlist,
            vaults: LookupMap::new(StorageKey::Vaults),
            next_vault_id: 1,
            events: Vector::new(StorageKey::Events),
        }
    }

    /// Creates a Vault for the caller. The attached deposit (≥ 0.5 NEAR) funds its storage.
    #[payable]
    pub fn create_vault(&mut self, owner_key: String, policy: Policy) -> U64 {
        let caller = env::predecessor_account_id();
        if !self.creator_allowlist.is_empty() && !self.creator_allowlist.contains(&caller) {
            fail(ErrorCode::CreatorNotAllowed);
        }
        let deposit = env::attached_deposit();
        if deposit < MIN_VAULT_STORAGE {
            fail(ErrorCode::DepositTooLow);
        }
        if !is_compressed_key(&owner_key) {
            reject(&Rejection::with(ErrorCode::BadKey, "owner_key"));
        }
        if let Err(rejection) = validate_policy(&policy, &self.allowed_networks) {
            reject(&rejection);
        }

        let storage_before = env::storage_usage();
        let vault_id = self.next_vault_id;
        self.next_vault_id += 1;
        let vault = Vault {
            vault_id: U64(vault_id),
            owner_account: caller.clone(),
            owner_key,
            policy,
            state: VaultState::PendingKeys,
            cosigner_pubkeys: None,
            addresses: None,
            storage_balance: U128(deposit.as_yoctonear()),
            created_at: U64(env::block_timestamp()),
        };
        self.vaults.insert(vault_id, vault);
        self.emit(
            vault_id,
            "vault_created",
            json!({ "owner_account": caller }),
        );
        self.vaults.flush();
        self.events.flush();

        let used = u128::from(env::storage_usage().saturating_sub(storage_before));
        let cost = env::storage_byte_cost().as_yoctonear() * used;
        let vault = self
            .vaults
            .get_mut(&vault_id)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        vault.storage_balance = U128(deposit.as_yoctonear().saturating_sub(cost));
        U64(vault_id)
    }

    /// Adds storage deposit to a Vault. Anyone may pay.
    #[payable]
    pub fn top_up_storage(&mut self, vault_id: U64) {
        let deposit = env::attached_deposit().as_yoctonear();
        let vault = self
            .vaults
            .get_mut(&vault_id.0)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        vault.storage_balance = U128(vault.storage_balance.0 + deposit);
        self.emit(
            vault_id.0,
            "storage_topped_up",
            json!({ "amount_yocto": U128(deposit) }),
        );
    }

    // Views

    pub fn get_vault(&self, vault_id: U64) -> Vault {
        self.vaults
            .get(&vault_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound))
    }

    /// Events with `seq > cursor`, ascending, at most `limit` (≤ 100).
    pub fn events_since(&self, cursor: U64, limit: u32) -> Vec<EventView> {
        let limit = limit.clamp(1, EVENTS_SINCE_MAX_LIMIT);
        let start = cursor.0.min(u64::from(self.events.len()));
        (start..u64::from(self.events.len()))
            .take(limit as usize)
            .filter_map(|index| {
                let index = u32::try_from(index).ok()?;
                self.events
                    .get(index)
                    .map(|event| event.view(u64::from(index) + 1))
            })
            .collect()
    }

    /// Deployment-level rules, shown on the Proof Page.
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "signer_account": self.signer_account,
            "allowed_networks": self.allowed_networks,
            "creator_allowlist": self.creator_allowlist,
            "version": env!("CARGO_PKG_VERSION"),
        })
    }

    /// Contract code version, shown on the Proof Page.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

impl VaultContract {
    fn emit(&mut self, vault_id: u64, kind: &str, data: near_sdk::serde_json::Value) {
        self.events.push(record(vault_id, kind, data));
    }
}

#[cfg(test)]
mod tests;
