// What the stub NEAR RPC serves for the Proof Page (e2e only): Vault #7 with its full
// `get_vault` view, a contract-global `events_since` log, and the contract's `view_account`.
// Shared by stub-services.ts and proof.spec.ts so the spec can check the exact values. Times
// are fixed instants: the spec runs the page on a fake clock in UTC.
import { createHash } from "node:crypto";
import { WATCHER_X25519_PK, base58 } from "./challenge-fixture.ts";

/** The page's clock in proof.spec.ts. */
export const PROOF_NOW = new Date("2026-11-12T09:00:00Z");

const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const HOUR_NS = 3_600_000_000_000n;

export const PROOF_VAULT_ID = "7";
export const PROOF_RECOVERY = "tb1qproofrecoveryaddress00000000000000000000";
export const PROOF_NEW_RECOVERY = "tb1qproofnewrecoveryaddress000000000000000000";
export const PROOF_VAULT_ADDRESS = "tb1qproofvaultaddress000000000000000000000000000000000000";
export const PROOF_ALLOWANCE_ADDRESS = "tb1qproofallowanceaddress00000000000000000000000000000000";
/** The contract's deployed code hash (base58 of 32 bytes). */
export const CODE_HASH = base58(createHash("sha256").update("morrow-e2e-wasm").digest());

export const PROOF_CREATED_AT = ns("2026-11-10T08:00:00Z");
/** The pending request: op 3, 0.0006 sBTC, executable 13 Nov 08:02 UTC. */
export const PENDING_OP = {
  op_id: "3",
  amount_sats: "60000",
  executable_at: ns("2026-11-13T08:02:00Z"),
};
export const CHANGE = {
  change_id: "4",
  vault_id: PROOF_VAULT_ID,
  changes: { recovery_address: PROOF_NEW_RECOVERY },
  proposed_at: ns("2026-11-12T08:00:00Z"),
  effective_at: ns("2026-11-19T08:00:00Z"),
  state: "pending",
  vetoed_by: null,
};

/** `get_vault` of Vault #7: 24 h / 7 d / 26,280 blocks, a Trusted Contact and a watcher. */
export const PROOF_VAULT = {
  vault_id: PROOF_VAULT_ID,
  owner_account: "proof-owner.testnet",
  owner_key: `02${"7a".repeat(32)}`,
  policy: {
    delay_ns: (24n * HOUR_NS).toString(),
    policy_change_delay_ns: (7n * 24n * HOUR_NS).toString(),
    escape_timelock_blocks: 26_280,
    recovery_address: PROOF_RECOVERY,
    allowance_limit_sats: "100000",
    fee_cap_sats: "20000",
    fast_approval: false,
    fast_approval_floor_ns: HOUR_NS.toString(),
    guardians: [
      {
        guardian_key: `02${"a1".repeat(32)}`,
        guardian_account: "alice.testnet",
        kind: "trusted_contact",
      },
      {
        guardian_key: `03${"b2".repeat(32)}`,
        guardian_account: "watcher.morrow.testnet",
        kind: "auto_clawback",
      },
    ],
    btc_network: "signet",
    watcher_x25519_pk: WATCHER_X25519_PK,
  },
  state: "active",
  cosigner_pubkeys: { vault: `02${"c3".repeat(32)}`, allowance: `03${"d4".repeat(32)}` },
  addresses: { vault: PROOF_VAULT_ADDRESS, allowance: PROOF_ALLOWANCE_ADDRESS },
  storage_balance: "5000000000000000000000",
  created_at: PROOF_CREATED_AT,
  pending_change: CHANGE,
};

interface StubEvent {
  block_timestamp: string;
  vault_id: string;
  kind: string;
  data: Record<string, unknown>;
}

const filler = (iso: string, i: number): StubEvent => ({
  block_timestamp: (BigInt(ns(iso)) + BigInt(i)).toString(),
  vault_id: "42",
  kind: "storage_topped_up",
  data: { amount_yocto: "1" },
});

const request = (opId: string, amount: string, iso: string, executableAt: string): StubEvent => ({
  block_timestamp: ns(iso),
  vault_id: PROOF_VAULT_ID,
  kind: "withdrawal_requested",
  data: {
    op_id: opId,
    amount_sats: amount,
    destination: "tb1qprooftheif",
    executable_at: executableAt,
    utxos: [],
    envelope: "00".repeat(80),
  },
});

/**
 * The contract-global event log, `seq` from 1: another Vault's events before Vault #7 was
 * created (so the page must binary-search its start) and in between (more than one page of
 * 100). Vault #7 has op 2 requested then cancelled, and op 3 requested and still pending.
 */
export const PROOF_EVENTS = [
  ...Array.from({ length: 130 }, (_, i) => filler("2026-11-01T00:00:00Z", i)),
  {
    block_timestamp: PROOF_CREATED_AT,
    vault_id: PROOF_VAULT_ID,
    kind: "vault_created",
    data: { owner_account: PROOF_VAULT.owner_account },
  },
  {
    block_timestamp: ns("2026-11-10T08:05:00Z"),
    vault_id: PROOF_VAULT_ID,
    kind: "vault_activated",
    data: { vault_address: PROOF_VAULT_ADDRESS, allowance_address: PROOF_ALLOWANCE_ADDRESS },
  },
  request("2", "90000", "2026-11-11T10:00:00Z", ns("2026-11-12T10:00:00Z")),
  ...Array.from({ length: 120 }, (_, i) => filler("2026-11-11T11:00:00Z", i)),
  {
    block_timestamp: ns("2026-11-11T12:00:00Z"),
    vault_id: PROOF_VAULT_ID,
    kind: "withdrawal_cancelled",
    data: { op_id: "2", by: PROOF_VAULT.owner_account },
  },
  request(
    PENDING_OP.op_id,
    PENDING_OP.amount_sats,
    "2026-11-12T08:02:00Z",
    PENDING_OP.executable_at,
  ),
  {
    block_timestamp: CHANGE.proposed_at,
    vault_id: PROOF_VAULT_ID,
    kind: "policy_change_proposed",
    data: {
      change_id: CHANGE.change_id,
      changes: CHANGE.changes,
      effective_at: CHANGE.effective_at,
      envelope: "00".repeat(80),
    },
  },
].map((event, i) => ({ seq: String(i + 1), ...event }));
