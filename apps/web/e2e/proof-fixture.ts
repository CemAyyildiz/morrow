// What the stub NEAR RPC serves for the Proof Page (e2e only): Vault #7 with its full
// `get_vault` view and its `get_vault_kit` (real scripts and addresses), a contract-global
// `events_since` log, and the contract's `view_account`.
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

const OWNER_KEY = `02${"7a".repeat(32)}`;
const COSIGNERS = { vault: `02${"c3".repeat(32)}`, allowance: `03${"d4".repeat(32)}` };
const GUARDIAN_KEYS = [`02${"a1".repeat(32)}`, `03${"b2".repeat(32)}`];
export const PROOF_TIMELOCK = 26_280;

/** The contract's `push_number`: OP_0, OP_1..OP_16, else minimal little-endian CScriptNum. */
function pushNumber(value: number): string {
  if (value === 0) return "00";
  if (value <= 16) return (0x50 + value).toString(16);
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.push(rest % 256);
  if ((bytes.at(-1) as number) & 0x80) bytes.push(0);
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return hex(bytes.length) + bytes.map(hex).join("");
}

/**
 * The Vault Script for these keys, the contract's `build_vault_script` (core/script.rs):
 * OP_IF <owner> OP_CHECKSIGVERIFY <cosigner> OP_CHECKSIG OP_ELSE OP_IF <cosigner>
 * OP_CHECKSIGVERIFY OP_1 <guardians…> <n> OP_CHECKMULTISIG OP_ELSE <timelock>
 * OP_CHECKSEQUENCEVERIFY OP_DROP <owner> OP_CHECKSIG OP_ENDIF OP_ENDIF.
 */
export function vaultScriptHex(
  owner: string,
  cosigner: string,
  guardians = GUARDIAN_KEYS,
  timelock = PROOF_TIMELOCK,
) {
  const push = (key: string) => `21${key}`;
  return [
    "63",
    push(owner),
    "ad",
    push(cosigner),
    "ac",
    "67",
    "63",
    push(cosigner),
    "ad",
    "51",
    ...guardians.map(push),
    pushNumber(guardians.length),
    "ae",
    "67",
    pushNumber(timelock),
    "b2",
    "75",
    push(owner),
    "ac",
    "68",
    "68",
  ].join("");
}

export const PROOF_VAULT_SCRIPT = vaultScriptHex(OWNER_KEY, COSIGNERS.vault);
export const PROOF_ALLOWANCE_SCRIPT = vaultScriptHex(OWNER_KEY, COSIGNERS.allowance);
/**
 * The P2WSH addresses of those scripts on signet, computed with core-ts `p2wshAddress` and
 * bitcoinjs-lib `payments.p2wsh` (they agree): the page must recompute exactly these.
 */
export const PROOF_VAULT_ADDRESS = "tb1q586enhd0tphtzqk2gsvfk9t8d5zwc33h0d37zv5e03l4xcu5x2msqyf28s";
export const PROOF_ALLOWANCE_ADDRESS =
  "tb1qdm2jljxm64tlgdkrg7fcjwqwxvd6t059d7hc7khmq774kmhawknqsaqpcz";
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
  owner_key: OWNER_KEY,
  policy: {
    delay_ns: (24n * HOUR_NS).toString(),
    policy_change_delay_ns: (7n * 24n * HOUR_NS).toString(),
    escape_timelock_blocks: PROOF_TIMELOCK,
    recovery_address: PROOF_RECOVERY,
    allowance_limit_sats: "100000",
    fee_cap_sats: "20000",
    fast_approval: false,
    fast_approval_floor_ns: HOUR_NS.toString(),
    guardians: [
      {
        guardian_key: GUARDIAN_KEYS[0] as string,
        guardian_account: "alice.testnet",
        kind: "trusted_contact",
      },
      {
        guardian_key: GUARDIAN_KEYS[1] as string,
        guardian_account: "watcher.morrow.testnet",
        kind: "auto_clawback",
      },
    ],
    btc_network: "signet",
    watcher_x25519_pk: WATCHER_X25519_PK,
  },
  state: "active",
  cosigner_pubkeys: COSIGNERS,
  addresses: { vault: PROOF_VAULT_ADDRESS, allowance: PROOF_ALLOWANCE_ADDRESS },
  storage_balance: "5000000000000000000000",
  created_at: PROOF_CREATED_AT,
  pending_change: CHANGE,
};

/** `get_vault_kit` of Vault #7: its real scripts, so the recomputed addresses truly match. */
export const PROOF_KIT = {
  kit_version: 1,
  btc_network: "signet",
  vault_script_hex: PROOF_VAULT_SCRIPT,
  allowance_script_hex: PROOF_ALLOWANCE_SCRIPT,
  addresses: { vault: PROOF_VAULT_ADDRESS, allowance: PROOF_ALLOWANCE_ADDRESS },
  escape_timelock_blocks: PROOF_TIMELOCK,
  cosigner_pubkeys: COSIGNERS,
  witness_templates: [
    { path: "withdrawal", slots: [] },
    { path: "clawback", slots: [] },
    { path: "escape", slots: [] },
  ],
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
