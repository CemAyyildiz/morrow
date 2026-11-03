/** Decimal string encoding of a u64 (sats, nanoseconds, seq, ids). */
export type U64 = string;
/** Lowercase hex without a `0x` prefix. */
export type Hex = string;
/** NEAR account id. */
export type AccountId = string;

export type BtcNetwork = "regtest" | "signet" | "testnet4" | "bitcoin";

export type GuardianKind = "trusted_contact" | "backup_device" | "auto_clawback";

export interface Guardian {
  /** 33-byte compressed secp256k1 key used on the Clawback Path. */
  guardian_key: Hex;
  guardian_account: AccountId;
  kind: GuardianKind;
}

export interface Policy {
  delay_ns: U64;
  policy_change_delay_ns: U64;
  escape_timelock_blocks: number;
  recovery_address: string;
  allowance_limit_sats: U64;
  fee_cap_sats: U64;
  fast_approval: boolean;
  fast_approval_floor_ns: U64;
  guardians: Guardian[];
  btc_network: BtcNetwork;
  /** 32-byte X25519 key the Watcher Envelopes are sealed to. */
  watcher_x25519_pk: Hex;
}

/** Policy fields a Policy Change may touch. Everything else is Script-bound. */
export interface PolicyChangeFields {
  delay_ns?: U64;
  recovery_address?: string;
  allowance_limit_sats?: U64;
  fee_cap_sats?: U64;
  policy_change_delay_ns?: U64;
  fast_approval?: boolean;
  fast_approval_floor_ns?: U64;
}

export type VaultState = "pending_keys" | "active" | "clawed_back";

export interface Vault {
  vault_id: U64;
  owner_account: AccountId;
  /** 33-byte compressed Owner Key used on the Withdrawal and Escape Paths. */
  owner_key: Hex;
  policy: Policy;
  state: VaultState;
  /** Derived Co-signer keys; null until both derivations are stored. */
  cosigner_pubkeys: { vault: Hex; allowance: Hex } | null;
  /** P2WSH addresses; null until the Vault is active. */
  addresses: { vault: string; allowance: string } | null;
  storage_balance: U64;
  created_at: U64;
  /** The single pending Policy Change, if any. */
  pending_change: PolicyChange | null;
}

export interface Outpoint {
  /** Display (RPC) byte order. */
  txid: Hex;
  vout: number;
  value_sats: U64;
}

export type SpendOpKind = "withdrawal" | "allowance" | "refresh" | "clawback";

/** Which address a spend's coins come from; decides the witness script and the signing path. */
export type SpendSource = "vault" | "allowance";

/** Stored states. `executable` is derived at read time from `executable_at`. */
export type SpendOpState = "pending" | "frozen" | "signed" | "cancelled" | "voided";

export type ScriptPath = "withdrawal" | "clawback" | "escape";

export type WitnessSlot =
  | { kind: "signature"; signer: "owner" | "cosigner" | "guardian" }
  | { kind: "selector"; hex: Hex }
  | { kind: "empty" }
  | { kind: "script" };

/** Ordered witness slots, bottom of the stack first. Clients fill slots; they never reorder them. */
export interface WitnessTemplate {
  path: ScriptPath;
  slots: WitnessSlot[];
}

export interface SpendOp {
  op_id: U64;
  vault_id: U64;
  kind: SpendOpKind;
  source: SpendSource;
  state: SpendOpState;
  amount_sats: U64;
  destination: string;
  fee_rate_sat_vb: number;
  utxos: Outpoint[];
  created_at: U64;
  /** Set for withdrawals only. */
  executable_at: U64 | null;
  /** Set once the op is frozen. */
  unsigned_tx_hex: Hex | null;
  sighashes: Hex[];
  /** Co-signer signature per input, null until signed. */
  signatures: (Hex | null)[];
  witness_template: WitnessTemplate | null;
}

export type PolicyChangeState = "pending" | "applied" | "vetoed" | "withdrawn";

export interface PolicyChange {
  change_id: U64;
  vault_id: U64;
  changes: PolicyChangeFields;
  proposed_at: U64;
  effective_at: U64;
  state: PolicyChangeState;
  vetoed_by: AccountId | null;
}

export interface VaultKit {
  kit_version: 1;
  btc_network: BtcNetwork;
  vault_script_hex: Hex;
  allowance_script_hex: Hex;
  addresses: { vault: string; allowance: string };
  escape_timelock_blocks: number;
  cosigner_pubkeys: { vault: Hex; allowance: Hex };
  witness_templates: Record<ScriptPath, WitnessTemplate>;
}

// Method arguments

export interface CreateVaultArgs {
  owner_key: Hex;
  policy: Policy;
  /** Attached deposit in yoctoNEAR. */
  deposit_yocto: string;
}

export interface RequestWithdrawalArgs {
  vault_id: U64;
  amount_sats: U64;
  destination: string;
  fee_rate_sat_vb: number;
  utxos: Outpoint[];
  envelope: Hex;
}

export interface SpendAllowanceArgs {
  vault_id: U64;
  amount_sats: U64;
  destination: string;
  fee_rate_sat_vb: number;
  utxos: Outpoint[];
  envelope: Hex;
}

export interface RefreshArgs {
  vault_id: U64;
  fee_rate_sat_vb: number;
  utxos: Outpoint[];
  envelope: Hex;
  /** Which address the coins sit on and go back to. Defaults to "vault". */
  source?: SpendSource;
}

/** At most 5 coins per call; larger sweeps call again (a ClawedBack Vault still accepts begin_clawback). */
export interface BeginClawbackArgs {
  vault_id: U64;
  utxos: Outpoint[];
  fee_rate_sat_vb: number;
  /** Defaults to "vault". */
  source?: SpendSource;
}

export interface ProposePolicyChangeArgs {
  vault_id: U64;
  /** Unknown keys are allowed here so Script-bound attempts can be rejected by the contract. */
  changes: PolicyChangeFields & Record<string, unknown>;
  envelope: Hex;
}
