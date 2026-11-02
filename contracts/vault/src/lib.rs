//! Morrow Vault Contract: co-signs Bitcoin spends through NEAR Chain Signatures, only within the
//! Vault's Policy. `core` holds the pure rules; this file is the imperative shell.

pub mod core;
pub mod events;

use crate::core::address::p2wsh_address;
use crate::core::address::script_pubkey;
use crate::core::errors::{ErrorCode, Rejection};
use crate::core::policy::{is_compressed_key, validate_policy, BtcNetwork, Policy};
use crate::core::script::{
    build_vault_script, compress_derived_key, hex, parse_key, witness_templates, WitnessTemplate,
};
use crate::core::spend::{
    check_amount, check_envelope, check_inputs, Outpoint, SpendOp, SpendOpKind, SpendOpState,
};
use crate::events::{record, EventView, StoredEvent, EVENTS_SINCE_MAX_LIMIT};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// Gas for one `derived_public_key` call to the MPC signer (measured: ~5 Tgas).
const DERIVE_GAS: Gas = Gas::from_tgas(10);
const ACTIVATE_GAS: Gas = Gas::from_tgas(20);

/// Minimum `create_vault` deposit: 0.5 NEAR.
pub const MIN_VAULT_STORAGE: NearToken = NearToken::from_millinear(500);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
    Events,
    Ops,
    Reservations,
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

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultKit {
    pub kit_version: u8,
    pub btc_network: BtcNetwork,
    pub vault_script_hex: String,
    pub allowance_script_hex: String,
    pub addresses: KeyPair,
    pub escape_timelock_blocks: u32,
    pub cosigner_pubkeys: KeyPair,
    pub witness_templates: Vec<WitnessTemplate>,
}

/// Both witness scripts of a Vault, rebuilt from its stored keys.
fn vault_scripts(vault: &Vault) -> Option<(Vec<u8>, Vec<u8>)> {
    let cosigners = vault.cosigner_pubkeys.as_ref()?;
    let owner = parse_key(&vault.owner_key).ok()?;
    let guardians: Vec<[u8; 33]> = vault
        .policy
        .guardians
        .iter()
        .map(|g| parse_key(&g.guardian_key).ok())
        .collect::<Option<_>>()?;
    let timelock = vault.policy.escape_timelock_blocks;
    let script = |cosigner: &str| -> Option<Vec<u8>> {
        Some(build_vault_script(
            &owner,
            &parse_key(cosigner).ok()?,
            &guardians,
            timelock,
        ))
    };
    Some((script(&cosigners.vault)?, script(&cosigners.allowance)?))
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
    ops: LookupMap<u64, SpendOp>,
    next_op_id: u64,
    /// Outpoint key ("txid:vout") → the non-terminal, non-clawback op holding it.
    reservations: LookupMap<String, u64>,
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
            ops: LookupMap::new(StorageKey::Ops),
            next_op_id: 1,
            reservations: LookupMap::new(StorageKey::Reservations),
        }
    }

    /// Creates a Vault for the caller. The attached deposit (≥ 0.5 NEAR) funds its storage.
    #[payable]
    pub fn create_vault(&mut self, owner_key: String, policy: Policy) -> Promise {
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

        self.derive_key(vault_id, "vault")
            .and(self.derive_key(vault_id, "allowance"))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ACTIVATE_GAS)
                    .on_keys_derived(U64(vault_id)),
            )
    }

    /// Stores both Co-signer keys, builds the scripts and addresses, and activates the Vault.
    /// If a derivation failed, the Vault stays `pending_keys`.
    #[private]
    pub fn on_keys_derived(
        &mut self,
        vault_id: U64,
        #[callback_result] vault_key: Result<String, PromiseError>,
        #[callback_result] allowance_key: Result<String, PromiseError>,
    ) -> U64 {
        let storage_before = env::storage_usage();
        let vault = self
            .vaults
            .get_mut(&vault_id.0)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        if vault.state != VaultState::PendingKeys {
            return vault_id;
        }
        let (Ok(vault_key), Ok(allowance_key)) = (vault_key, allowance_key) else {
            reject(&Rejection::with(
                ErrorCode::VaultNotActive,
                "co-signer key derivation failed",
            ))
        };
        let compress = |derived: &str| compress_derived_key(derived).unwrap_or_else(|r| reject(&r));
        vault.cosigner_pubkeys = Some(KeyPair {
            vault: hex(&compress(&vault_key)),
            allowance: hex(&compress(&allowance_key)),
        });
        let (vault_script, allowance_script) =
            vault_scripts(vault).unwrap_or_else(|| fail(ErrorCode::BadKey));
        let network = vault.policy.btc_network;
        let addresses = KeyPair {
            vault: p2wsh_address(&vault_script, network),
            allowance: p2wsh_address(&allowance_script, network),
        };
        vault.addresses = Some(addresses.clone());
        vault.state = VaultState::Active;
        self.emit(
            vault_id.0,
            "vault_activated",
            json!({ "vault_address": addresses.vault, "allowance_address": addresses.allowance }),
        );
        self.vaults.flush();
        self.events.flush();
        self.charge_storage(vault_id.0, storage_before);
        vault_id
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

    /// Starts a withdrawal. It stays Pending, in public, until `executable_at = now + Delay`.
    #[allow(clippy::too_many_arguments)]
    pub fn request_withdrawal(
        &mut self,
        vault_id: U64,
        amount_sats: U64,
        destination: String,
        fee_rate_sat_vb: u32,
        utxos: Vec<Outpoint>,
        envelope: String,
    ) -> U64 {
        let storage_before = env::storage_usage();
        let vault = self.owner_action(vault_id.0, Some(&envelope)).clone();
        if let Err(r) = script_pubkey(&destination, vault.policy.btc_network) {
            reject(&r);
        }
        let total = check_inputs(&utxos).unwrap_or_else(|r| reject(&r));
        check_amount(amount_sats.0, total).unwrap_or_else(|r| reject(&r));
        self.check_unreserved(&utxos);

        let op_id = self.next_op_id;
        self.next_op_id += 1;
        let now = env::block_timestamp();
        let executable_at = now.saturating_add(vault.policy.delay_ns.0);
        for utxo in &utxos {
            self.reservations.insert(utxo.key(), op_id);
        }
        self.emit(
            vault_id.0,
            "withdrawal_requested",
            json!({
                "op_id": U64(op_id),
                "amount_sats": amount_sats,
                "destination": destination,
                "executable_at": U64(executable_at),
                "utxos": utxos,
                "envelope": envelope,
            }),
        );
        self.ops.insert(
            op_id,
            SpendOp {
                op_id: U64(op_id),
                vault_id,
                kind: SpendOpKind::Withdrawal,
                state: SpendOpState::Pending,
                amount_sats,
                destination,
                fee_rate_sat_vb,
                utxos,
                created_at: U64(now),
                executable_at: Some(U64(executable_at)),
                unsigned_tx_hex: None,
                sighashes: vec![],
                signatures: vec![],
                witness_template: None,
            },
        );
        self.flush_and_charge(vault_id.0, storage_before);
        U64(op_id)
    }

    /// Cancels a pending withdrawal. The Owner needs an envelope; any Guardian may cancel.
    pub fn cancel(&mut self, op_id: U64, envelope: Option<String>) {
        let storage_before = env::storage_usage();
        let op = self
            .ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
        let vault = self.active_vault(op.vault_id.0).clone();
        let caller = env::predecessor_account_id();
        if caller == vault.owner_account {
            check_envelope(envelope.as_deref()).unwrap_or_else(|r| reject(&r));
        } else if !vault
            .policy
            .guardians
            .iter()
            .any(|g| g.guardian_account == caller)
        {
            fail(ErrorCode::Unauthorized);
        }
        if op.kind != SpendOpKind::Withdrawal || op.state != SpendOpState::Pending {
            fail(ErrorCode::BadOpState);
        }
        for utxo in &op.utxos {
            self.reservations.remove(&utxo.key());
        }
        if let Some(stored) = self.ops.get_mut(&op_id.0) {
            stored.state = SpendOpState::Cancelled;
        }
        self.emit(
            op.vault_id.0,
            "withdrawal_cancelled",
            json!({ "op_id": op_id, "by": caller }),
        );
        self.flush_and_charge(op.vault_id.0, storage_before);
    }

    // Views

    pub fn get_op(&self, op_id: U64) -> SpendOp {
        self.ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound))
    }

    pub fn get_vault(&self, vault_id: U64) -> Vault {
        self.vaults
            .get(&vault_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound))
    }

    /// Everything needed to spend through the Escape Path without NEAR: scripts, addresses,
    /// timelock, Co-signer keys and witness templates.
    pub fn get_vault_kit(&self, vault_id: U64) -> VaultKit {
        let vault = self
            .vaults
            .get(&vault_id.0)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        let (Some(addresses), Some(cosigner_pubkeys)) =
            (vault.addresses.clone(), vault.cosigner_pubkeys.clone())
        else {
            fail(ErrorCode::VaultNotActive)
        };
        let (vault_script, allowance_script) =
            vault_scripts(vault).unwrap_or_else(|| fail(ErrorCode::BadKey));
        VaultKit {
            kit_version: 1,
            btc_network: vault.policy.btc_network,
            vault_script_hex: hex(&vault_script),
            allowance_script_hex: hex(&allowance_script),
            addresses,
            escape_timelock_blocks: vault.policy.escape_timelock_blocks,
            cosigner_pubkeys,
            witness_templates: witness_templates(),
        }
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
    fn derive_key(&self, vault_id: u64, role: &str) -> Promise {
        let args = json!({
            "path": format!("morrow/v1/{vault_id}/{role}"),
            "predecessor": env::current_account_id(),
            "domain_id": 0,
        });
        Promise::new(self.signer_account.clone()).function_call(
            "derived_public_key",
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            DERIVE_GAS,
        )
    }

    /// Debits the storage added since `storage_before` from the Vault's storage balance.
    /// An active (not clawed back) Vault.
    fn active_vault(&self, vault_id: u64) -> &Vault {
        let vault = self
            .vaults
            .get(&vault_id)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        match vault.state {
            VaultState::Active => vault,
            VaultState::ClawedBack => fail(ErrorCode::ClawedBack),
            VaultState::PendingKeys => fail(ErrorCode::VaultNotActive),
        }
    }

    /// An Owner action: active Vault, Owner caller, valid envelope.
    fn owner_action(&self, vault_id: u64, envelope: Option<&str>) -> &Vault {
        let vault = self.active_vault(vault_id);
        if env::predecessor_account_id() != vault.owner_account {
            fail(ErrorCode::Unauthorized);
        }
        check_envelope(envelope).unwrap_or_else(|r| reject(&r));
        vault
    }

    fn check_unreserved(&self, utxos: &[Outpoint]) {
        for utxo in utxos {
            if let Some(holder) = self.reservations.get(&utxo.key()) {
                let live = self
                    .ops
                    .get(holder)
                    .is_some_and(|op| !op.state.is_terminal());
                if live {
                    fail(ErrorCode::OutpointReserved);
                }
            }
        }
    }

    /// Flushes collections and charges the added storage to the Vault, failing when it is short.
    fn flush_and_charge(&mut self, vault_id: u64, storage_before: u64) {
        self.vaults.flush();
        self.events.flush();
        self.ops.flush();
        self.reservations.flush();
        let used = u128::from(env::storage_usage().saturating_sub(storage_before));
        let cost = env::storage_byte_cost().as_yoctonear() * used;
        let vault = self
            .vaults
            .get_mut(&vault_id)
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        if cost > vault.storage_balance.0 {
            fail(ErrorCode::StorageBudget);
        }
        vault.storage_balance = U128(vault.storage_balance.0 - cost);
    }

    fn charge_storage(&mut self, vault_id: u64, storage_before: u64) {
        let used = u128::from(env::storage_usage().saturating_sub(storage_before));
        let cost = env::storage_byte_cost().as_yoctonear() * used;
        if let Some(vault) = self.vaults.get_mut(&vault_id) {
            vault.storage_balance = U128(vault.storage_balance.0.saturating_sub(cost));
        }
    }

    fn emit(&mut self, vault_id: u64, kind: &str, data: near_sdk::serde_json::Value) {
        self.events.push(record(vault_id, kind, data));
    }
}

#[cfg(test)]
mod tests;
