//! Morrow Vault Contract: co-signs Bitcoin spends through NEAR Chain Signatures, only within the
//! Vault's Policy. `core` holds the pure rules; this file is the imperative shell.

pub mod core;
pub mod events;

use crate::core::address::p2wsh_address;
use crate::core::address::{p2wsh_script_pubkey, script_pubkey};
use crate::core::errors::{ErrorCode, Rejection};
use crate::core::policy::{
    is_compressed_key, parse_change, validate_policy, BtcNetwork, Policy, PolicyChange,
    PolicyChangeState,
};
use crate::core::script::{
    build_vault_script, compress_derived_key, hex, parse_key, witness_templates, WitnessTemplate,
};
use crate::core::spend::{
    check_amount, check_envelope, check_inputs, Outpoint, SpendOp, SpendOpKind, SpendOpState,
    SpendSource,
};
use crate::core::tx::{
    build_payment, build_refresh, build_sweep, clawback_fee_cap, withdrawal_fee_cap, PaymentPlan,
};
use crate::events::{record, EventView, StoredEvent, EVENTS_SINCE_MAX_LIMIT};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// Gas for one `derived_public_key` call to the MPC signer (measured: ~5 Tgas).
const DERIVE_GAS: Gas = Gas::from_tgas(10);
const ACTIVATE_GAS: Gas = Gas::from_tgas(20);
/// Gas for one MPC `sign` call (measured: ~8 Tgas burnt) and for storing its result.
const SIGN_GAS: Gas = Gas::from_tgas(50);
const ON_SIGNED_GAS: Gas = Gas::from_tgas(10);

/// The MPC signer's secp256k1 response.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcSignature {
    pub big_r: MpcPoint,
    pub s: MpcScalar,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcPoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcScalar {
    pub scalar: String,
}

impl MpcSignature {
    /// Stored form: compressed big_r (33 bytes) followed by s (32 bytes), lowercase hex.
    fn stored(&self) -> Option<String> {
        let r = self.big_r.affine_point.to_ascii_lowercase();
        let s = self.s.scalar.to_ascii_lowercase();
        let hex_ok =
            |v: &str, len: usize| v.len() == len && v.bytes().all(|b| b.is_ascii_hexdigit());
        (hex_ok(&r, 66) && (r.starts_with("02") || r.starts_with("03")) && hex_ok(&s, 64))
            .then(|| format!("{r}{s}"))
    }
}

/// Minimum `create_vault` deposit: 0.5 NEAR.
pub const MIN_VAULT_STORAGE: NearToken = NearToken::from_millinear(500);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
    Events,
    Ops,
    Reservations,
    VaultOps,
    ClawbackOutpoints,
    Changes,
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
    /// The single pending Policy Change, if any. The Policy itself changes only on apply.
    pub pending_change: Option<PolicyChange>,
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
    /// Every op id per Vault, so a Clawback can void the live ones.
    vault_ops: LookupMap<u64, Vec<u64>>,
    /// Outpoint key → the clawback op sweeping it.
    clawback_outpoints: LookupMap<String, u64>,
    /// Every Policy Change ever proposed, so a settled id is found but never reactivated.
    changes: LookupMap<u64, PolicyChange>,
    next_change_id: u64,
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
            vault_ops: LookupMap::new(StorageKey::VaultOps),
            clawback_outpoints: LookupMap::new(StorageKey::ClawbackOutpoints),
            changes: LookupMap::new(StorageKey::Changes),
            next_change_id: 1,
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
            pending_change: None,
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
                source: SpendSource::Vault,
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
        self.index_op(vault_id.0, op_id);
        self.flush_and_charge(vault_id.0, storage_before);
        U64(op_id)
    }

    /// Builds the withdrawal transaction once the Delay has passed and freezes it with its
    /// sighashes. The contract builds every byte; callers only choose the fee rate up front.
    /// Calling it again returns the same frozen transaction.
    pub fn begin_execute(&mut self, op_id: U64, envelope: String) -> SpendOp {
        let storage_before = env::storage_usage();
        let op = self
            .ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
        let vault = self.owner_action(op.vault_id.0, Some(&envelope)).clone();
        if op.kind != SpendOpKind::Withdrawal {
            fail(ErrorCode::BadOpState);
        }
        match op.state {
            SpendOpState::Frozen | SpendOpState::Signed => return op,
            SpendOpState::Pending => {}
            _ => fail(ErrorCode::BadOpState),
        }
        let executable_at = op.executable_at.map_or(u64::MAX, |t| t.0);
        if env::block_timestamp() < executable_at {
            fail(ErrorCode::NotExecutable);
        }

        let (vault_script, _) = vault_scripts(&vault).unwrap_or_else(|| fail(ErrorCode::BadKey));
        let destination =
            script_pubkey(&op.destination, vault.policy.btc_network).unwrap_or_else(|r| reject(&r));
        let change_to = p2wsh_script_pubkey(&vault_script);
        let built = build_payment(&PaymentPlan {
            inputs: &op.utxos,
            amount_sats: op.amount_sats.0,
            destination: &destination,
            change_to: &change_to,
            fee_rate_sat_vb: op.fee_rate_sat_vb,
            fee_cap_sats: withdrawal_fee_cap(vault.policy.fee_cap_sats.0, op.amount_sats.0),
            witness_script: &vault_script,
        })
        .unwrap_or_else(|r| reject(&r));

        let frozen = {
            let stored = self
                .ops
                .get_mut(&op_id.0)
                .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
            stored.unsigned_tx_hex = Some(hex(&built.unsigned));
            stored.sighashes = built.sighashes.iter().map(|s| hex(s)).collect();
            stored.signatures = vec![None; built.sighashes.len()];
            stored.witness_template = witness_templates()
                .into_iter()
                .find(|t| t.path == "withdrawal");
            stored.state = SpendOpState::Frozen;
            stored.clone()
        };
        self.emit(
            op.vault_id.0,
            "op_frozen",
            json!({ "op_id": op_id, "kind": "withdrawal", "envelope": envelope, "fee_sats": U64(built.fee_sats) }),
        );
        self.flush_and_charge(op.vault_id.0, storage_before);
        frozen
    }

    /// Re-locks up to 5 coins of one source (the Vault Address by default, or the Allowance
    /// Address): sweeps them back to that same address, the only output, so their Escape
    /// Timelock starts again. No Delay: the op is frozen at once and the Owner signs it through
    /// `sign_input`. Fee ≤ min(Fee Cap, 5% of the input total).
    pub fn refresh(
        &mut self,
        vault_id: U64,
        utxos: Vec<Outpoint>,
        fee_rate_sat_vb: u32,
        envelope: String,
        source: Option<SpendSource>,
    ) -> SpendOp {
        let storage_before = env::storage_usage();
        let source = source.unwrap_or_default();
        let vault = self.owner_action(vault_id.0, Some(&envelope)).clone();
        let total = check_inputs(&utxos).unwrap_or_else(|r| reject(&r));
        self.check_unreserved(&utxos);
        self.check_refresh_rate(&vault, source);

        let (vault_script, allowance_script) =
            vault_scripts(&vault).unwrap_or_else(|| fail(ErrorCode::BadKey));
        let addresses = vault
            .addresses
            .clone()
            .unwrap_or_else(|| fail(ErrorCode::VaultNotActive));
        let (script, address) = match source {
            SpendSource::Vault => (vault_script, addresses.vault),
            SpendSource::Allowance => (allowance_script, addresses.allowance),
        };
        // The stored address must be the very output the builder pays.
        let stored = script_pubkey(&address, vault.policy.btc_network).ok();
        if stored != Some(p2wsh_script_pubkey(&script)) {
            fail(ErrorCode::BadKey);
        }
        let built = build_refresh(
            &utxos,
            fee_rate_sat_vb,
            vault.policy.fee_cap_sats.0,
            &script,
        )
        .unwrap_or_else(|r| reject(&r));

        let op_id = self.next_op_id;
        self.next_op_id += 1;
        for utxo in &utxos {
            self.reservations.insert(utxo.key(), op_id);
        }
        let op = SpendOp {
            op_id: U64(op_id),
            vault_id,
            kind: SpendOpKind::Refresh,
            source,
            state: SpendOpState::Frozen,
            amount_sats: U64(total - built.fee_sats),
            destination: address,
            fee_rate_sat_vb,
            utxos,
            created_at: U64(env::block_timestamp()),
            executable_at: None,
            unsigned_tx_hex: Some(hex(&built.unsigned)),
            sighashes: built.sighashes.iter().map(|s| hex(s)).collect(),
            signatures: vec![None; built.sighashes.len()],
            witness_template: witness_templates()
                .into_iter()
                .find(|t| t.path == "withdrawal"),
        };
        self.ops.insert(op_id, op.clone());
        self.emit(
            vault_id.0,
            "op_frozen",
            json!({ "op_id": U64(op_id), "kind": "refresh", "envelope": envelope, "fee_sats": U64(built.fee_sats) }),
        );
        self.index_op(vault_id.0, op_id);
        self.flush_and_charge(vault_id.0, storage_before);
        op
    }

    /// Asks the NEAR MPC network to co-sign one input of a frozen op. Only the sighash the
    /// contract stored is ever sent. A signature already stored is returned without a new call.
    pub fn sign_input(&mut self, op_id: U64, input_index: u32) -> PromiseOrValue<String> {
        let op = self
            .ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
        let vault = self
            .vaults
            .get(&op.vault_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        let caller = env::predecessor_account_id();
        if op.kind == SpendOpKind::Clawback {
            if !vault
                .policy
                .guardians
                .iter()
                .any(|g| g.guardian_account == caller)
            {
                fail(ErrorCode::Unauthorized);
            }
        } else {
            match vault.state {
                VaultState::ClawedBack => fail(ErrorCode::ClawedBack),
                VaultState::PendingKeys => fail(ErrorCode::VaultNotActive),
                VaultState::Active => {}
            }
            if caller != vault.owner_account {
                fail(ErrorCode::Unauthorized);
            }
        }
        if !matches!(op.state, SpendOpState::Frozen | SpendOpState::Signed) {
            fail(ErrorCode::BadOpState);
        }
        let index = input_index as usize;
        let Some(sighash) = op.sighashes.get(index) else {
            fail(ErrorCode::InputIndex)
        };
        if let Some(Some(signature)) = op.signatures.get(index) {
            return PromiseOrValue::Value(signature.clone());
        }
        let role = op.source.role();
        let args = json!({
            "request": {
                "payload_v2": { "Ecdsa": sighash },
                "path": format!("morrow/v1/{}/{role}", op.vault_id.0),
                "domain_id": 0,
            }
        });
        Promise::new(self.signer_account.clone())
            .function_call(
                "sign",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                SIGN_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SIGNED_GAS)
                    .on_signed(op_id, input_index),
            )
            .into()
    }

    /// Stores one MPC signature; the op becomes Signed when every input has one.
    #[private]
    pub fn on_signed(
        &mut self,
        op_id: U64,
        input_index: u32,
        #[callback_result] result: Result<MpcSignature, PromiseError>,
    ) -> String {
        let storage_before = env::storage_usage();
        let signature = result
            .ok()
            .and_then(|s| s.stored())
            .unwrap_or_else(|| fail(ErrorCode::SignerFailed));
        let index = input_index as usize;
        let (vault_id, complete, stored) = {
            let op = self
                .ops
                .get_mut(&op_id.0)
                .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
            if let Some(Some(existing)) = op.signatures.get(index) {
                return existing.clone();
            }
            if op.state != SpendOpState::Frozen || index >= op.signatures.len() {
                fail(ErrorCode::BadOpState);
            }
            op.signatures[index] = Some(signature.clone());
            let complete = op.signatures.iter().all(Option::is_some);
            if complete {
                op.state = SpendOpState::Signed;
            }
            (op.vault_id.0, complete, signature)
        };
        self.emit(
            vault_id,
            "input_signed",
            json!({ "op_id": op_id, "input_index": input_index }),
        );
        if complete {
            self.emit(vault_id, "op_signed", json!({ "op_id": op_id }));
        }
        self.flush_and_charge(vault_id, storage_before);
        stored
    }

    /// Any Guardian sends up to 5 coins from one source (the Vault Address by default, or the
    /// Allowance Address) to the Recovery Address in effect. The first Clawback voids every live
    /// op, vetoes a pending Policy Change, and closes the Vault for good; later calls sweep late
    /// deposits.
    pub fn begin_clawback(
        &mut self,
        vault_id: U64,
        utxos: Vec<Outpoint>,
        fee_rate_sat_vb: u32,
        source: Option<SpendSource>,
    ) -> U64 {
        let storage_before = env::storage_usage();
        let source = source.unwrap_or_default();
        let vault = self
            .vaults
            .get(&vault_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::VaultNotFound));
        if vault.state == VaultState::PendingKeys {
            fail(ErrorCode::VaultNotActive);
        }
        let caller = env::predecessor_account_id();
        if !vault
            .policy
            .guardians
            .iter()
            .any(|g| g.guardian_account == caller)
        {
            fail(ErrorCode::Unauthorized);
        }
        let total = check_inputs(&utxos).unwrap_or_else(|r| reject(&r));
        if utxos
            .iter()
            .any(|u| self.clawback_outpoints.contains_key(&u.key()))
        {
            fail(ErrorCode::OutpointReserved);
        }

        let (vault_script, allowance_script) =
            vault_scripts(&vault).unwrap_or_else(|| fail(ErrorCode::BadKey));
        let witness_script = match source {
            SpendSource::Vault => vault_script,
            SpendSource::Allowance => allowance_script,
        };
        let recovery = script_pubkey(&vault.policy.recovery_address, vault.policy.btc_network)
            .unwrap_or_else(|r| reject(&r));
        let built = build_sweep(
            &utxos,
            &recovery,
            fee_rate_sat_vb,
            clawback_fee_cap(vault.policy.fee_cap_sats.0, total),
            &witness_script,
        )
        .unwrap_or_else(|r| reject(&r));

        let op_id = self.next_op_id;
        self.next_op_id += 1;
        for op_id_to_void in self.vault_ops.get(&vault_id.0).cloned().unwrap_or_default() {
            let voided = match self.ops.get_mut(&op_id_to_void) {
                Some(op) if op.kind != SpendOpKind::Clawback && !op.state.is_terminal() => {
                    op.state = SpendOpState::Voided;
                    true
                }
                _ => false,
            };
            if voided {
                self.emit(
                    vault_id.0,
                    "op_voided",
                    json!({ "op_id": U64(op_id_to_void), "by_op_id": U64(op_id) }),
                );
            }
        }
        // A change pending when the Vault closes can never apply: the clawing Guardian vetoes it.
        if let Some(change) = vault.pending_change.clone() {
            self.veto_change(change, caller.clone());
        }
        if vault.state != VaultState::ClawedBack {
            if let Some(stored) = self.vaults.get_mut(&vault_id.0) {
                stored.state = VaultState::ClawedBack;
            }
            self.emit(
                vault_id.0,
                "vault_clawed_back",
                json!({ "op_id": U64(op_id), "by": caller, "recovery_address": vault.policy.recovery_address }),
            );
        }
        for utxo in &utxos {
            self.clawback_outpoints.insert(utxo.key(), op_id);
        }
        let now = U64(env::block_timestamp());
        self.ops.insert(
            op_id,
            SpendOp {
                op_id: U64(op_id),
                vault_id,
                kind: SpendOpKind::Clawback,
                source,
                state: SpendOpState::Frozen,
                amount_sats: U64(total - built.fee_sats),
                destination: vault.policy.recovery_address.clone(),
                fee_rate_sat_vb,
                utxos,
                created_at: now,
                executable_at: None,
                unsigned_tx_hex: Some(hex(&built.unsigned)),
                sighashes: built.sighashes.iter().map(|s| hex(s)).collect(),
                signatures: vec![None; built.sighashes.len()],
                witness_template: witness_templates()
                    .into_iter()
                    .find(|t| t.path == "clawback"),
            },
        );
        self.emit(
            vault_id.0,
            "op_frozen",
            json!({ "op_id": U64(op_id), "kind": "clawback", "envelope": null, "fee_sats": U64(built.fee_sats) }),
        );
        self.index_op(vault_id.0, op_id);
        self.flush_all();
        self.charge_storage(vault_id.0, storage_before);
        U64(op_id)
    }

    /// Cancels a pending withdrawal (the Owner with an envelope, or any Guardian), or a Frozen
    /// Refresh that still has an unsigned input (the Owner only, with an envelope). Cancelling a
    /// Refresh does not reset the Refresh rate limit.
    pub fn cancel(&mut self, op_id: U64, envelope: Option<String>) {
        let storage_before = env::storage_usage();
        let op = self
            .ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound));
        let vault = self.active_vault(op.vault_id.0).clone();
        let caller = env::predecessor_account_id();
        let is_refresh = op.kind == SpendOpKind::Refresh;
        if caller == vault.owner_account {
            check_envelope(envelope.as_deref()).unwrap_or_else(|r| reject(&r));
        } else if is_refresh
            || !vault
                .policy
                .guardians
                .iter()
                .any(|g| g.guardian_account == caller)
        {
            fail(ErrorCode::Unauthorized);
        }
        let cancellable = match op.kind {
            SpendOpKind::Withdrawal => op.state == SpendOpState::Pending,
            SpendOpKind::Refresh => {
                op.state == SpendOpState::Frozen && op.signatures.iter().any(Option::is_none)
            }
            _ => false,
        };
        if !cancellable {
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
            if is_refresh {
                "refresh_cancelled"
            } else {
                "withdrawal_cancelled"
            },
            json!({ "op_id": op_id, "by": caller }),
        );
        self.flush_and_charge(op.vault_id.0, storage_before);
    }

    /// Proposes a Policy Change. It waits in public for the current Policy Change Delay: any
    /// Guardian can veto it, the Owner can withdraw it, and anyone can apply it after
    /// `effective_at`. Only whitelisted fields can change; the rest are Script-bound.
    pub fn propose_policy_change(
        &mut self,
        vault_id: U64,
        changes: Value,
        envelope: String,
    ) -> U64 {
        let storage_before = env::storage_usage();
        let vault = self.owner_action(vault_id.0, Some(&envelope)).clone();
        if vault.pending_change.is_some() {
            fail(ErrorCode::ChangePending);
        }
        let fields = parse_change(&changes).unwrap_or_else(|r| reject(&r));
        fields
            .apply_to(&vault.policy)
            .unwrap_or_else(|r| reject(&r));

        let change_id = self.next_change_id;
        self.next_change_id += 1;
        let now = env::block_timestamp();
        let effective_at = U64(now.saturating_add(vault.policy.policy_change_delay_ns.0));
        let change = PolicyChange {
            change_id: U64(change_id),
            vault_id,
            changes: fields,
            proposed_at: U64(now),
            effective_at,
            state: PolicyChangeState::Pending,
            vetoed_by: None,
        };
        self.changes.insert(change_id, change.clone());
        if let Some(stored) = self.vaults.get_mut(&vault_id.0) {
            stored.pending_change = Some(change);
        }
        self.emit(
            vault_id.0,
            "policy_change_proposed",
            json!({
                "change_id": U64(change_id),
                "changes": changes,
                "effective_at": effective_at,
                "envelope": envelope,
            }),
        );
        self.flush_and_charge(vault_id.0, storage_before);
        U64(change_id)
    }

    /// Stops a pending Policy Change: any Guardian vetoes it, or the Owner withdraws it with an
    /// envelope. A settled change can never be reactivated. Charged like a Clawback, so a
    /// Guardian's veto never fails on storage.
    pub fn veto_policy_change(&mut self, change_id: U64, envelope: Option<String>) {
        let storage_before = env::storage_usage();
        let change = self.pending_change(change_id);
        let vault = self.active_vault(change.vault_id.0).clone();
        let caller = env::predecessor_account_id();
        // The Owner first: an Owner who is also a Guardian withdraws, with an envelope.
        if caller == vault.owner_account {
            check_envelope(envelope.as_deref()).unwrap_or_else(|r| reject(&r));
            self.settle_change(change, PolicyChangeState::Withdrawn, None);
            self.emit(
                vault.vault_id.0,
                "policy_change_withdrawn",
                json!({ "change_id": change_id, "envelope": envelope }),
            );
        } else if vault
            .policy
            .guardians
            .iter()
            .any(|g| g.guardian_account == caller)
        {
            self.veto_change(change, caller);
        } else {
            fail(ErrorCode::Unauthorized);
        }
        self.flush_all();
        self.charge_storage(vault.vault_id.0, storage_before);
    }

    /// Applies a pending Policy Change once `effective_at` has passed. Anyone may call it.
    pub fn apply_policy_change(&mut self, change_id: U64) {
        let storage_before = env::storage_usage();
        let change = self.pending_change(change_id);
        let vault_id = change.vault_id.0;
        if env::block_timestamp() < change.effective_at.0 {
            fail(ErrorCode::ChangeNotEffective);
        }
        let policy = change
            .changes
            .apply_to(&self.active_vault(vault_id).policy)
            .unwrap_or_else(|r| reject(&r));
        self.settle_change(change, PolicyChangeState::Applied, None);
        if let Some(stored) = self.vaults.get_mut(&vault_id) {
            stored.policy = policy;
        }
        self.emit(
            vault_id,
            "policy_change_applied",
            json!({ "change_id": change_id }),
        );
        self.flush_all();
        self.charge_storage(vault_id, storage_before);
    }

    // Views

    pub fn get_op(&self, op_id: U64) -> SpendOp {
        self.ops
            .get(&op_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::OpNotFound))
    }

    pub fn get_policy_change(&self, change_id: U64) -> PolicyChange {
        self.changes
            .get(&change_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::ChangeNotFound))
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

    /// A known Policy Change, on an active Vault, still pending.
    fn pending_change(&self, change_id: U64) -> PolicyChange {
        let change = self
            .changes
            .get(&change_id.0)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::ChangeNotFound));
        self.active_vault(change.vault_id.0);
        if change.state != PolicyChangeState::Pending {
            fail(ErrorCode::BadOpState);
        }
        change
    }

    /// A Guardian's veto: settles the change and emits `policy_change_vetoed`.
    fn veto_change(&mut self, change: PolicyChange, by: AccountId) {
        let (vault_id, change_id) = (change.vault_id.0, change.change_id);
        self.settle_change(change, PolicyChangeState::Vetoed, Some(by.clone()));
        self.emit(
            vault_id,
            "policy_change_vetoed",
            json!({ "change_id": change_id, "by": by }),
        );
    }

    /// Moves a pending change to its final state and clears it from its Vault.
    fn settle_change(
        &mut self,
        mut change: PolicyChange,
        state: PolicyChangeState,
        vetoed_by: Option<AccountId>,
    ) {
        change.state = state;
        change.vetoed_by = vetoed_by;
        if let Some(vault) = self.vaults.get_mut(&change.vault_id.0) {
            vault.pending_change = None;
        }
        self.changes.insert(change.change_id.0, change);
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

    /// At most one Refresh per Delay and source, counted from the `created_at` of the newest
    /// Refresh of that source, whatever became of it.
    fn check_refresh_rate(&self, vault: &Vault, source: SpendSource) {
        let last = self.vault_ops.get(&vault.vault_id.0).and_then(|ids| {
            ids.iter().rev().find_map(|id| {
                self.ops
                    .get(id)
                    .filter(|op| op.kind == SpendOpKind::Refresh && op.source == source)
                    .map(|op| op.created_at.0)
            })
        });
        if let Some(created_at) = last {
            if env::block_timestamp() < created_at.saturating_add(vault.policy.delay_ns.0) {
                fail(ErrorCode::RefreshTooSoon);
            }
        }
    }

    fn index_op(&mut self, vault_id: u64, op_id: u64) {
        let mut ids = self.vault_ops.get(&vault_id).cloned().unwrap_or_default();
        ids.push(op_id);
        self.vault_ops.insert(vault_id, ids);
    }

    fn flush_all(&mut self) {
        self.vaults.flush();
        self.events.flush();
        self.ops.flush();
        self.reservations.flush();
        self.vault_ops.flush();
        self.clawback_outpoints.flush();
        self.changes.flush();
    }

    /// Flushes collections and charges the added storage to the Vault, failing when it is short.
    fn flush_and_charge(&mut self, vault_id: u64, storage_before: u64) {
        self.flush_all();
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
