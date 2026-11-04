import type { AccountId, Outpoint, PolicyChangeFields, SpendOpKind, U64 } from "./types.js";

/**
 * Append-only list of event kinds emitted by the Vault Contract (NEP-297 standard "morrow").
 * Never reorder or remove entries; add new kinds at the end.
 */
export const EVENT_KINDS = [
  "vault_created",
  "vault_activated",
  "storage_topped_up",
  "withdrawal_requested",
  "withdrawal_cancelled",
  "fast_approved",
  "op_frozen",
  "input_signed",
  "op_signed",
  "op_voided",
  "vault_clawed_back",
  "policy_change_proposed",
  "policy_change_vetoed",
  "policy_change_withdrawn",
  "policy_change_applied",
  "refresh_cancelled",
  "allowance_spent",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventData {
  vault_created: { owner_account: AccountId };
  vault_activated: { vault_address: string; allowance_address: string };
  storage_topped_up: { amount_yocto: string };
  withdrawal_requested: {
    op_id: U64;
    amount_sats: U64;
    destination: string;
    executable_at: U64;
    utxos: Outpoint[];
    /** 160-hex Watcher Envelope; only the watcher can read the flag inside. */
    envelope: string;
  };
  withdrawal_cancelled: { op_id: U64; by: AccountId };
  fast_approved: { op_id: U64; by: AccountId; executable_at: U64 };
  /** `fee_sats`: the fee the frozen transaction pays, as the contract built it. */
  op_frozen: { op_id: U64; kind: SpendOpKind; envelope: string | null; fee_sats: U64 };
  input_signed: { op_id: U64; input_index: number };
  op_signed: { op_id: U64 };
  op_voided: { op_id: U64; by_op_id: U64 };
  vault_clawed_back: { op_id: U64; by: AccountId; recovery_address: string };
  policy_change_proposed: {
    change_id: U64;
    changes: PolicyChangeFields;
    effective_at: U64;
    envelope: string;
  };
  policy_change_vetoed: { change_id: U64; by: AccountId };
  /** `envelope`: the Owner's 160-hex Watcher Envelope sent with the withdrawal. */
  policy_change_withdrawn: { change_id: U64; envelope: string };
  policy_change_applied: { change_id: U64 };
  /** The Owner cancelled a Frozen Refresh before every input was signed. */
  refresh_cancelled: { op_id: U64; by: AccountId };
  /**
   * An Allowance spend was accepted and frozen (it follows its `op_frozen`). `window_sats`: the
   * rolling 24-hour Allowance total including this spend, fees not counted.
   */
  allowance_spent: { op_id: U64; amount_sats: U64; destination: string; window_sats: U64 };
}

export type MorrowEvent = {
  [K in EventKind]: {
    seq: U64;
    block_timestamp: U64;
    vault_id: U64;
    kind: K;
    data: EventData[K];
  };
}[EventKind];
