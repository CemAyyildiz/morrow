// The Proof Page's chain reads (story 6.1): `get_vault`, `events_since` (paged from the Vault's
// `created_at`), RPC `view_account` (the contract's `code_hash`) and `view_access_key_list`
// (its full-access keys), all over the configured NEAR RPC, plus the pure mapping and the
// generated guarantee and trust statements. Story 6.2 adds `get_vault_kit`, read once per Vault
// on Recompute, and the in-browser address recompute and tamper check of its scripts. Nothing is cached anywhere but in this page's
// memory, and nothing here invents a value: what cannot be read is said to be unreadable.
import {
  compareScripts,
  decodeScript,
  p2wshAddress,
  sameOp,
  scriptNumber,
  scriptPaths,
  vaultScriptTemplate,
  type BtcNetwork as CoreBtcNetwork,
  type Guardian,
  type GuardianKind,
  type Policy,
  type PolicyChange,
  type PolicyChangeFields,
  type ScriptOp,
  type ScriptPath,
  type Vault,
  type VaultKit,
  type VaultScriptElement,
  type VaultScriptRole,
  type VaultState,
} from "@morrow/core-ts/browser";
import { copy } from "@/copy";
import { absoluteTime, formatDuration, nsToMs, viewResult } from "./challenge";
import type { HeartbeatState } from "./data";
import { withTimeout } from "./live";

/** How often the page reads the chain again. */
export const PROOF_POLL_MS = 30_000;
/** `events_since` answers at most this many events per call. */
export const EVENTS_PAGE = 100;
/** Pages read per refresh at most; a longer history is read on across refreshes. */
export const MAX_EVENT_PAGES = 50;
/** The approximate Bitcoin block interval the Escape Timelock is put in days with. */
const BLOCK_MS = 10 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isU64 = (value: unknown): value is string => isString(value) && /^\d{1,20}$/.test(value);
const isHex = (value: unknown): value is string => isString(value) && /^[0-9a-f]*$/.test(value);
const isAccount = (value: unknown): value is string => isString(value) && value !== "";

// RPC

/**
 * One JSON-RPC answer: `ok`; `error` when the node answered but the call failed in the
 * contract or on the account (a missing Vault); `unreachable` when the node did not answer or
 * answered something else.
 */
export type RpcAnswer<T> =
  { kind: "ok"; value: T } | { kind: "error"; text: string } | { kind: "unreachable" };

/** Error causes that are the contract's or the account's answer, not the node's failure. */
const CONTRACT_CAUSES = new Set([
  "CONTRACT_EXECUTION_ERROR",
  "UNKNOWN_ACCOUNT",
  "NO_CONTRACT_CODE",
]);

/** Reads a JSON-RPC response body as an answer. */
export function rpcAnswer(body: unknown): RpcAnswer<Record<string, unknown>> {
  if (!isRecord(body)) return { kind: "unreachable" };
  if (body.error !== undefined) {
    const error = body.error;
    const text = JSON.stringify(error) ?? "";
    const cause = isRecord(error) && isRecord(error.cause) ? error.cause.name : undefined;
    if ((isString(cause) && CONTRACT_CAUSES.has(cause)) || /ERR_[A-Z_]+/.test(text)) {
      return { kind: "error", text };
    }
    return { kind: "unreachable" };
  }
  if (!isRecord(body.result)) return { kind: "unreachable" };
  // Older nodes answer a failed view call with a result that carries the error text.
  if (isString(body.result.error)) return { kind: "error", text: body.result.error };
  return { kind: "ok", value: body.result };
}

/** The reads the Proof Page makes, bound to one RPC and contract. */
export interface ProofRpc {
  /** A `query` with `finality: final`. */
  query(params: Record<string, unknown>): Promise<RpcAnswer<Record<string, unknown>>>;
  /** A `call_function` view on the contract, its JSON value decoded. */
  view(method: string, args: Record<string, unknown>): Promise<RpcAnswer<unknown>>;
}

export function proofRpc(rpcUrl: string, contractId: string, signal: AbortSignal): ProofRpc {
  const query: ProofRpc["query"] = async (params) => {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "morrow-web",
          method: "query",
          params: { finality: "final", ...params },
        }),
        cache: "no-store",
        signal: withTimeout(signal),
      });
      if (!response.ok) return { kind: "unreachable" };
      return rpcAnswer(await response.json());
    } catch {
      return { kind: "unreachable" };
    }
  };
  return {
    query,
    async view(method, args) {
      const answer = await query({
        request_type: "call_function",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      });
      if (answer.kind !== "ok") return answer;
      const value = viewResult({ result: answer.value });
      return value === null ? { kind: "unreachable" } : { kind: "ok", value };
    },
  };
}

// get_vault

const VAULT_STATES: readonly VaultState[] = ["pending_keys", "active", "clawed_back"];
const GUARDIAN_KINDS: readonly GuardianKind[] = [
  "trusted_contact",
  "backup_device",
  "auto_clawback",
];
const BTC_NETWORKS: readonly CoreBtcNetwork[] = ["regtest", "signet", "testnet4", "bitcoin"];
const CHANGE_STATES: readonly PolicyChange["state"][] = [
  "pending",
  "applied",
  "vetoed",
  "withdrawn",
];

function parseGuardian(value: unknown): Guardian | null {
  if (!isRecord(value) || !isHex(value.guardian_key) || !isAccount(value.guardian_account)) {
    return null;
  }
  if (!GUARDIAN_KINDS.includes(value.kind as GuardianKind)) return null;
  return {
    guardian_key: value.guardian_key,
    guardian_account: value.guardian_account,
    kind: value.kind as GuardianKind,
  };
}

function parsePolicy(value: unknown): Policy | null {
  if (!isRecord(value)) return null;
  const p = value;
  for (const field of [
    "delay_ns",
    "policy_change_delay_ns",
    "allowance_limit_sats",
    "fee_cap_sats",
    "fast_approval_floor_ns",
  ]) {
    if (!isU64(p[field])) return null;
  }
  const blocks = p.escape_timelock_blocks;
  if (typeof blocks !== "number" || !Number.isSafeInteger(blocks) || blocks < 0) return null;
  if (!isAccount(p.recovery_address) || typeof p.fast_approval !== "boolean") return null;
  if (!BTC_NETWORKS.includes(p.btc_network as CoreBtcNetwork) || !isHex(p.watcher_x25519_pk)) {
    return null;
  }
  if (!Array.isArray(p.guardians)) return null;
  const guardians = (p.guardians as unknown[]).map(parseGuardian);
  if (guardians.some((guardian) => guardian === null)) return null;
  return {
    delay_ns: p.delay_ns as string,
    policy_change_delay_ns: p.policy_change_delay_ns as string,
    escape_timelock_blocks: blocks,
    recovery_address: p.recovery_address,
    allowance_limit_sats: p.allowance_limit_sats as string,
    fee_cap_sats: p.fee_cap_sats as string,
    fast_approval: p.fast_approval,
    fast_approval_floor_ns: p.fast_approval_floor_ns as string,
    guardians: guardians as Guardian[],
    btc_network: p.btc_network as CoreBtcNetwork,
    watcher_x25519_pk: p.watcher_x25519_pk,
  };
}

/** The Policy Change fields, each checked; unknown keys are dropped. */
function parseChanges(value: unknown): PolicyChangeFields | null {
  if (!isRecord(value)) return null;
  const out: PolicyChangeFields = {};
  for (const field of [
    "delay_ns",
    "allowance_limit_sats",
    "fee_cap_sats",
    "policy_change_delay_ns",
    "fast_approval_floor_ns",
  ] as const) {
    const v = value[field];
    if (v === undefined) continue;
    if (!isU64(v)) return null;
    out[field] = v;
  }
  if (value.recovery_address !== undefined) {
    if (!isAccount(value.recovery_address)) return null;
    out.recovery_address = value.recovery_address;
  }
  if (value.fast_approval !== undefined) {
    if (typeof value.fast_approval !== "boolean") return null;
    out.fast_approval = value.fast_approval;
  }
  return out;
}

function parseChange(value: unknown): PolicyChange | null {
  if (!isRecord(value) || !isU64(value.change_id) || !isU64(value.vault_id)) return null;
  if (!isU64(value.proposed_at) || !isU64(value.effective_at)) return null;
  if (!CHANGE_STATES.includes(value.state as PolicyChange["state"])) return null;
  if (value.vetoed_by !== null && !isAccount(value.vetoed_by)) return null;
  const changes = parseChanges(value.changes);
  if (changes === null) return null;
  return {
    change_id: value.change_id,
    vault_id: value.vault_id,
    changes,
    proposed_at: value.proposed_at,
    effective_at: value.effective_at,
    state: value.state as PolicyChange["state"],
    vetoed_by: value.vetoed_by,
  };
}

function parsePair(value: unknown): { vault: string; allowance: string } | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isAccount(value.vault) || !isAccount(value.allowance)) return undefined;
  return { vault: value.vault, allowance: value.allowance };
}

/** The `get_vault` view (`contracts/vault` `Vault`); null when it has another shape. */
export function parseVault(value: unknown): Vault | null {
  if (!isRecord(value) || !isU64(value.vault_id) || !isAccount(value.owner_account)) return null;
  if (!isHex(value.owner_key) || !VAULT_STATES.includes(value.state as VaultState)) return null;
  if (!isString(value.storage_balance)) return null;
  if (!isU64(value.created_at)) return null;
  const policy = parsePolicy(value.policy);
  const cosigners = parsePair(value.cosigner_pubkeys);
  const addresses = parsePair(value.addresses);
  if (policy === null || cosigners === undefined || addresses === undefined) return null;
  let pending: PolicyChange | null = null;
  if (value.pending_change !== null && value.pending_change !== undefined) {
    pending = parseChange(value.pending_change);
    if (pending === null) return null;
  }
  return {
    vault_id: value.vault_id,
    owner_account: value.owner_account,
    owner_key: value.owner_key,
    policy,
    state: value.state as VaultState,
    cosigner_pubkeys: cosigners,
    addresses,
    storage_balance: value.storage_balance,
    created_at: value.created_at,
    pending_change: pending,
  };
}

// view_account and view_access_key_list

/** The `code_hash` of a `view_account` result (base58); null when it is not one. */
export function codeHashFrom(result: unknown): string | null {
  if (!isRecord(result) || !isString(result.code_hash)) return null;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.code_hash) ? result.code_hash : null;
}

/**
 * The number of full-access keys in a `view_access_key_list` result: 0 is a locked contract.
 * Null when it is not a key list.
 */
export function fullAccessKeysFrom(result: unknown): number | null {
  if (!isRecord(result) || !Array.isArray(result.keys)) return null;
  let full = 0;
  for (const key of result.keys as unknown[]) {
    if (!isRecord(key) || !isRecord(key.access_key)) return null;
    const permission = key.access_key.permission;
    if (permission === "FullAccess") full += 1;
    else if (!isRecord(permission) || !isRecord(permission.FunctionCall)) return null;
  }
  return full;
}

// events_since

export interface ProofEvent {
  seq: string;
  block_timestamp: string;
  vault_id: string;
  kind: string;
  /** Read only for this Vault's events, and only when it is an object. */
  data: unknown;
}

/**
 * An `events_since` answer; null when an entry lacks the envelope (`seq`, time, Vault, kind).
 * `data` is not checked here: another Vault's is never read.
 */
export function parseEvents(value: unknown): ProofEvent[] | null {
  if (!Array.isArray(value)) return null;
  const events: ProofEvent[] = [];
  for (const event of value as unknown[]) {
    if (!isRecord(event) || !isU64(event.seq) || !isU64(event.block_timestamp)) return null;
    if (!isU64(event.vault_id) || !isString(event.kind)) return null;
    events.push({
      seq: event.seq,
      block_timestamp: event.block_timestamp,
      vault_id: event.vault_id,
      kind: event.kind,
      data: event.data,
    });
  }
  return events;
}

/** Thrown when a page cannot be read: the whole refresh counts as unreachable. */
class Unreachable extends Error {}
/** Thrown when the contract answers `events_since` with an error: not a Vault Contract. */
class Misconfigured extends Error {}

/** Events with `seq > cursor`, at most `limit`. */
export type EventPage = (cursor: bigint, limit: number) => Promise<ProofEvent[]>;

function eventPage(rpc: ProofRpc): EventPage {
  return async (cursor, limit) => {
    const answer = await rpc.view("events_since", { cursor: cursor.toString(), limit });
    if (answer.kind === "error") throw new Misconfigured();
    const events = answer.kind === "ok" ? parseEvents(answer.value) : null;
    if (events === null) throw new Unreachable();
    return events;
  };
}

/**
 * The smallest cursor whose next event is at or after `createdAt`, or past the end: a binary
 * search over `events_since(c, 1)` (as core-ts X-Ray's `firstCursorAtOrAfter`). `seq` is
 * gapless and ascending in time, so every event of the Vault comes after it.
 */
export async function firstCursorAtOrAfter(page: EventPage, createdAt: bigint): Promise<bigint> {
  const ok = async (cursor: bigint) => {
    const [event] = await page(cursor, 1);
    return !event || BigInt(event.block_timestamp) >= createdAt;
  };
  if (await ok(0n)) return 0n;
  let lo = 0n;
  let hi = 1n;
  while (!(await ok(hi))) {
    lo = hi;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Pending ops

export interface PendingWithdrawal {
  opId: string;
  amountSats: string;
  destination: string;
  /** ns; from the request, or a later `fast_approved`. */
  executableAt: string;
  requestedAt: string;
  /** Frozen: its transaction is built and being co-signed. */
  frozen: boolean;
}

export interface ClawedBack {
  recoveryAddress: string;
  /** ns, the block time of `vault_clawed_back`. */
  at: string;
}

/**
 * The history scan of one Vault, folded as it is read and kept between refreshes: each refresh
 * reads on from `cursor`, so the newest events are never the ones left out.
 */
export interface Scan {
  vaultId: string;
  createdAt: string;
  /** The last `seq` read; null until the binary search has found the start. */
  cursor: bigint | null;
  /** Withdrawals still Pending or Frozen, by op id, in request order. */
  open: Map<string, PendingWithdrawal>;
  clawedBack: ClawedBack | null;
  /** Events read from the start, every Vault's. */
  read: number;
  /** The last page came back short: everything up to it is folded. */
  caughtUp: boolean;
}

export const newScan = (vaultId: string, createdAt: string): Scan => ({
  vaultId,
  createdAt,
  cursor: null,
  open: new Map(),
  clawedBack: null,
  read: 0,
  caughtUp: false,
});

const copyScan = (scan: Scan): Scan => ({
  ...scan,
  open: new Map([...scan.open].map(([id, op]) => [id, { ...op }])),
});

/** Events that settle a withdrawal: it is no longer pending. */
const SETTLING = new Set(["withdrawal_cancelled", "op_signed", "op_voided"]);

/**
 * Folds one event into `scan`. Another Vault's event is skipped unread; this Vault's with
 * unreadable data is skipped too. A withdrawal stays open while Pending or Frozen: from
 * `withdrawal_requested` until `withdrawal_cancelled`, `op_signed` or `op_voided`.
 */
export function foldEvent(scan: Scan, event: ProofEvent): void {
  if (event.vault_id !== scan.vaultId || !isRecord(event.data)) return;
  const data = event.data;
  const opId = isU64(data.op_id) ? data.op_id : null;
  const op = opId === null ? undefined : scan.open.get(opId);
  if (event.kind === "withdrawal_requested") {
    if (opId === null || !isU64(data.amount_sats) || !isU64(data.executable_at)) return;
    scan.open.set(opId, {
      opId,
      amountSats: data.amount_sats,
      destination: isString(data.destination) ? data.destination : "",
      executableAt: data.executable_at,
      requestedAt: event.block_timestamp,
      frozen: false,
    });
  } else if (event.kind === "fast_approved") {
    if (op && isU64(data.executable_at)) op.executableAt = data.executable_at;
  } else if (event.kind === "op_frozen") {
    if (op) op.frozen = true;
  } else if (SETTLING.has(event.kind)) {
    if (opId !== null) scan.open.delete(opId);
  } else if (event.kind === "vault_clawed_back") {
    if (isAccount(data.recovery_address)) {
      scan.clawedBack = { recoveryAddress: data.recovery_address, at: event.block_timestamp };
    }
  }
}

/** The pending withdrawals and the Clawback of a Vault's events, ascending. Pure. */
export function pendingFrom(
  events: readonly ProofEvent[],
  vaultId = events[0]?.vault_id ?? "",
): { withdrawals: PendingWithdrawal[]; clawedBack: ClawedBack | null } {
  const scan = newScan(vaultId, "0");
  for (const event of events) foldEvent(scan, event);
  return { withdrawals: [...scan.open.values()], clawedBack: scan.clawedBack };
}

/**
 * Reads on from the scan's cursor (finding the start first), at most `maxPages` pages of 100,
 * folding each page as it comes. `caughtUp` once a page comes back short.
 */
export async function advanceScan(
  page: EventPage,
  scan: Scan,
  maxPages = MAX_EVENT_PAGES,
): Promise<void> {
  scan.cursor ??= await firstCursorAtOrAfter(page, BigInt(scan.createdAt));
  for (let pages = 0; pages < maxPages; pages++) {
    const batch = await page(scan.cursor, EVENTS_PAGE);
    for (const event of batch) foldEvent(scan, event);
    scan.read += batch.length;
    const last = batch.at(-1);
    if (last) scan.cursor = BigInt(last.seq);
    if (batch.length < EVENTS_PAGE) {
      scan.caughtUp = true;
      return;
    }
  }
  scan.caughtUp = false;
}

// One refresh

/** What one refresh read from the chain. */
export interface ProofFacts {
  vault: Vault;
  withdrawals: PendingWithdrawal[];
  clawedBack: ClawedBack | null;
  /** `caughtUp` false while the history is still being read: the pending list is partial. */
  history: { caughtUp: boolean; read: number };
  /** Null when `view_account` answered without a readable one. */
  codeHash: string | null;
  /** Full-access keys on the contract account; null when the list could not be read. */
  fullAccessKeys: number | null;
}

export type ProofAnswer =
  | { kind: "ok"; facts: ProofFacts }
  /** `get_vault` failed with `ERR_VAULT_NOT_FOUND`, verbatim in `code`. */
  | { kind: "missing"; code: string }
  /** The contract account answered, but not as a Vault Contract. */
  | { kind: "misconfigured" }
  | { kind: "unreachable" };

/** Where the scan of the Vault on screen is kept between refreshes. */
export interface ScanHolder {
  current: Scan | null;
}

/**
 * Reads the Vault and its facts. The history scan in `holder` is read on from its cursor; it
 * starts over for another Vault (or a recreated one). A refresh that fails keeps the scan as it
 * was, so no page is folded twice.
 */
export async function readProof(
  rpc: ProofRpc,
  contractId: string,
  vaultId: string,
  holder: ScanHolder = { current: null },
): Promise<ProofAnswer> {
  const answer = await rpc.view("get_vault", { vault_id: vaultId });
  if (answer.kind === "error") {
    return answer.text.includes("ERR_VAULT_NOT_FOUND")
      ? { kind: "missing", code: "ERR_VAULT_NOT_FOUND" }
      : { kind: "misconfigured" };
  }
  if (answer.kind === "unreachable") return { kind: "unreachable" };
  const vault = parseVault(answer.value);
  if (vault === null || vault.vault_id !== vaultId) return { kind: "misconfigured" };
  try {
    const before = holder.current;
    const same = before?.vaultId === vaultId && before.createdAt === vault.created_at;
    const scan = same && before ? copyScan(before) : newScan(vaultId, vault.created_at);
    const [account, keys] = await Promise.all([
      rpc.query({ request_type: "view_account", account_id: contractId }),
      rpc.query({ request_type: "view_access_key_list", account_id: contractId }),
      advanceScan(eventPage(rpc), scan),
    ]);
    if (account.kind === "unreachable" || keys.kind === "unreachable") {
      return { kind: "unreachable" };
    }
    if (account.kind === "error" || keys.kind === "error") return { kind: "misconfigured" };
    // Another refresh may have moved the scan on meanwhile: then this one is not kept.
    if (holder.current === before) holder.current = scan;
    return {
      kind: "ok",
      facts: {
        vault,
        withdrawals: [...scan.open.values()].map((op) => ({ ...op })),
        clawedBack: scan.clawedBack,
        history: { caughtUp: scan.caughtUp, read: scan.read },
        codeHash: codeHashFrom(account.value),
        fullAccessKeys: fullAccessKeysFrom(keys.value),
      },
    };
  } catch (error) {
    // A page that could not be read, or any other surprise: nothing is shown that was not
    // read, and the next refresh tries again.
    return error instanceof Misconfigured ? { kind: "misconfigured" } : { kind: "unreachable" };
  }
}

// Display

const UNITS: Record<CoreBtcNetwork, string> = {
  bitcoin: "BTC",
  signet: "sBTC",
  testnet4: "tBTC",
  regtest: "rBTC",
};

/** Sats as BTC without trailing zeros, with the network's unit: `0.0006 sBTC`. */
export function formatAmount(sats: string, network: CoreBtcNetwork): string {
  const value = BigInt(sats);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`} ${UNITS[network]}`;
}

/** A ns duration as `24 h`, `7 d`, `1 h`. */
export const durationOf = (ns: string) => formatDuration(nsToMs(ns));

/** The Escape Timelock in blocks, `26,280 blocks`. */
export const blocksOf = (blocks: number) =>
  `${blocks.toLocaleString("en-US")} ${blocks === 1 ? "block" : "blocks"}`;

/** About how long `blocks` take at 10 min per block: `182 d 12 h`. */
const blocksDuration = (blocks: number) => formatDuration(blocks * BLOCK_MS);

const KIND_LABELS: Record<GuardianKind, string> = copy.proof.guardianKinds;

/** `alice.testnet (Trusted Contact)`. */
export const guardianLabel = (guardian: Guardian) =>
  `${guardian.guardian_account} (${KIND_LABELS[guardian.kind]})`;

/** A Policy Change's fields: `Recovery Address → tb1q…`, joined by ` · `. */
export function changeSummary(changes: PolicyChangeFields, network: CoreBtcNetwork): string {
  const c = copy.proof.change;
  const parts: string[] = [];
  if (changes.delay_ns !== undefined) parts.push(c.field(c.delay, durationOf(changes.delay_ns)));
  if (changes.policy_change_delay_ns !== undefined) {
    parts.push(c.field(c.policyChangeDelay, durationOf(changes.policy_change_delay_ns)));
  }
  if (changes.recovery_address !== undefined) {
    parts.push(c.field(c.recoveryAddress, changes.recovery_address));
  }
  if (changes.allowance_limit_sats !== undefined) {
    parts.push(c.field(c.allowanceLimit, formatAmount(changes.allowance_limit_sats, network)));
  }
  if (changes.fee_cap_sats !== undefined) {
    parts.push(c.field(c.feeCap, formatAmount(changes.fee_cap_sats, network)));
  }
  if (changes.fast_approval !== undefined) {
    parts.push(c.field(c.fastApproval, changes.fast_approval ? c.on : c.off));
  }
  if (changes.fast_approval_floor_ns !== undefined) {
    parts.push(c.field(c.fastApprovalFloor, durationOf(changes.fast_approval_floor_ns)));
  }
  return parts.length === 0 ? c.none : parts.join(" · ");
}

/** One Policy row: a label and its value; `mono` values are identifiers shown in full. */
export interface PolicyRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** The Policy rows; the Guardians, with their keys, are drawn by the view. */
export function policyRows(policy: Policy): PolicyRow[] {
  const r = copy.proof.rows;
  const net = policy.btc_network;
  return [
    { label: r.delay, value: durationOf(policy.delay_ns) },
    { label: r.policyChangeDelay, value: durationOf(policy.policy_change_delay_ns) },
    { label: r.escapeTimelock, value: blocksOf(policy.escape_timelock_blocks) },
    { label: r.recoveryAddress, value: policy.recovery_address, mono: true },
    {
      label: r.allowanceLimit,
      value: r.perDay(formatAmount(policy.allowance_limit_sats, net)),
    },
    { label: r.feeCap, value: formatAmount(policy.fee_cap_sats, net) },
    {
      label: r.fastApproval,
      value: policy.fast_approval ? r.fastOn(durationOf(policy.fast_approval_floor_ns)) : r.fastOff,
    },
    { label: r.watcherKey, value: policy.watcher_x25519_pk, mono: true },
  ];
}

/** A Pending (not Frozen) withdrawal whose `executable_at` has passed at `now`. */
export const isDue = (op: PendingWithdrawal, now: number) =>
  !op.frozen && nsToMs(op.executableAt) <= now;

/** A pending Withdrawal Request's line: `Withdrawal #3 · 0.0006 sBTC · executable 13 Nov 14:02`. */
export function withdrawalLine(op: PendingWithdrawal, network: CoreBtcNetwork, now: number) {
  return copy.proof.pendingWithdrawal(
    op.opId,
    formatAmount(op.amountSats, network),
    absoluteTime(nsToMs(op.executableAt), now),
  );
}

/** The pending Policy Change's line: `Policy Change #4 · Recovery Address → … · effective …`. */
export function changeLine(change: PolicyChange, network: CoreBtcNetwork, now: number) {
  return copy.proof.pendingChange(
    change.change_id,
    changeSummary(change.changes, network),
    absoluteTime(nsToMs(change.effective_at), now),
  );
}

/** The Policy Change pending on the Vault, if any. */
export const pendingChangeOf = (vault: Vault) =>
  vault.pending_change?.state === "pending" ? vault.pending_change : null;

/** Whether the Vault has an Auto-Clawback Guardian, whose key the deployment's watcher holds. */
export const hasWatcher = (vault: Vault) =>
  vault.policy.guardians.some((guardian) => guardian.kind === "auto_clawback");

/**
 * The deployment watcher's heartbeat line: alarm when stale, missing, unreachable or silent.
 * Shown only for a Vault with an Auto-Clawback Guardian.
 */
export function watcherLine(heartbeat: HeartbeatState): { text: string; alarm: boolean } {
  const w = copy.proof.watcher;
  switch (heartbeat.kind) {
    case "seen":
      return { text: w.seen(heartbeat.minutes), alarm: heartbeat.stale };
    case "none":
      return { text: w.none, alarm: true };
    case "checking":
      return { text: w.checking, alarm: false };
    case "unreachable":
      return { text: w.unreachable, alarm: true };
    case "silent":
      return { text: w.silent, alarm: true };
  }
}

// Statements

export interface Statement {
  /** `G-1` … `G-4`, `T-1` … `T-6`, or `Closed`. */
  id: string;
  title: string;
  text: string;
  /** A warning drawn after the text in the alarm tone. */
  alert?: string;
  /** A link drawn after the text. */
  link?: { href: string; text: string };
}

/** What the statements read besides the Vault. */
export interface StatementFacts {
  now: number;
  contractId: string;
  /** The configured Co-signer (MPC signer) account. */
  coSigner: string;
  codeHash: string | null;
  withdrawals: readonly PendingWithdrawal[];
  clawedBack: ClawedBack | null;
  /** False while the history is still being read: no claim about pending requests. */
  caughtUp: boolean;
}

const guardiansOf = (vault: Vault, kind?: GuardianKind) =>
  vault.policy.guardians.filter((guardian) => kind === undefined || guardian.kind === kind);

const accounts = (guardians: readonly Guardian[]) =>
  guardians.map((guardian) => guardian.guardian_account).join(", ");

/** The earliest future `executable_at` among Pending (not Frozen) withdrawals, ns. */
function earliestExecutable(withdrawals: readonly PendingWithdrawal[], now: number): string | null {
  let earliest: string | null = null;
  for (const op of withdrawals) {
    if (op.frozen || isDue(op, now)) continue;
    if (earliest === null || BigInt(op.executableAt) < BigInt(earliest)) earliest = op.executableAt;
  }
  return earliest;
}

/**
 * G-1 to G-4 for an active Vault, every value from its Policy. A clawed-back Vault gets the
 * closed-Vault statement instead, and a Vault whose keys are still being derived none (see
 * `stateNotice`). Pure.
 */
export function guarantees(vault: Vault, facts: StatementFacts): Statement[] {
  const g = copy.proof.guarantees;
  const p = vault.policy;
  if (vault.state === "pending_keys") return [];
  if (vault.state === "clawed_back") {
    const recovery = facts.clawedBack?.recoveryAddress ?? p.recovery_address;
    return [
      {
        id: "Closed",
        title: g.closedTitle,
        text: facts.clawedBack
          ? g.closed(recovery, absoluteTime(nsToMs(facts.clawedBack.at), facts.now))
          : g.closedUntimed(recovery),
      },
    ];
  }
  const delay = durationOf(p.delay_ns);
  const blocks = blocksOf(p.escape_timelock_blocks);
  const g1 = [g.g1(delay, blocks)];
  if (p.fast_approval && guardiansOf(vault, "trusted_contact").length > 0) {
    g1.push(g.g1Fast(durationOf(p.fast_approval_floor_ns)));
  }
  g1.push(
    p.allowance_limit_sats === "0"
      ? g.g1NoAllowance
      : g.g1Allowance(formatAmount(p.allowance_limit_sats, p.btc_network)),
  );
  // Only a fully read history may claim anything about pending requests.
  const due = facts.caughtUp ? facts.withdrawals.filter((op) => isDue(op, facts.now)) : [];
  const earliest = facts.caughtUp ? earliestExecutable(facts.withdrawals, facts.now) : null;
  if (due.length === 0 && earliest !== null) {
    g1.push(g.g1Earliest(absoluteTime(nsToMs(earliest), facts.now)));
  }

  const change = pendingChangeOf(vault);
  const g4 = [g.g4(durationOf(p.policy_change_delay_ns), p.recovery_address)];
  if (change) {
    g4.push(g.g4Pending(change.change_id, absoluteTime(nsToMs(change.effective_at), facts.now)));
  }
  return [
    {
      id: "G-1",
      title: g.g1Title,
      text: g1.join(" "),
      ...(due.length > 0 ? { alert: due.map((op) => g.g1Due(op.opId)).join(" ") } : {}),
    },
    {
      id: "G-2",
      title: g.g2Title,
      text: g.g2(guardiansOf(vault).length, accounts(guardiansOf(vault)), p.recovery_address),
    },
    {
      id: "G-3",
      title: g.g3Title,
      text: g.g3(blocks, blocksDuration(p.escape_timelock_blocks)),
    },
    { id: "G-4", title: g.g4Title, text: g4.join(" ") },
  ];
}

/** The notice the Guarantees card shows instead of statements; null when it has some. */
export function stateNotice(vault: Vault): string | null {
  return vault.state === "pending_keys" ? copy.proof.guarantees.notActive : null;
}

/**
 * T-1 to T-4 for this Vault, T-5 only with Fast Approval on and T-6 only with an
 * Auto-Clawback Guardian. T-3, the one theft path, is always there. Pure.
 */
export function trustStatements(vault: Vault, facts: StatementFacts): Statement[] {
  const t = copy.proof.trust;
  const p = vault.policy;
  const statements: Statement[] = [
    { id: "T-1", title: t.t1Title, text: t.t1(facts.coSigner, facts.contractId) },
    {
      id: "T-2",
      title: t.t2Title,
      text:
        facts.codeHash === null
          ? t.t2Unread(facts.contractId)
          : t.t2(facts.contractId, facts.codeHash),
      link: { href: copy.proof.repoUrl, text: copy.proof.repoLink },
    },
    {
      id: "T-3",
      title: t.t3Title,
      text: t.t3(guardiansOf(vault).length, accounts(guardiansOf(vault)), facts.coSigner),
    },
    { id: "T-4", title: t.t4Title, text: t.t4(p.recovery_address) },
  ];
  if (p.fast_approval) {
    const contacts = guardiansOf(vault, "trusted_contact");
    statements.push({
      id: "T-5",
      title: t.t5Title,
      text:
        contacts.length === 0
          ? t.t5None
          : t.t5(accounts(contacts), durationOf(p.fast_approval_floor_ns), durationOf(p.delay_ns)),
    });
  }
  const watchers = guardiansOf(vault, "auto_clawback");
  if (watchers.length > 0) {
    statements.push({
      id: "T-6",
      title: t.t6Title,
      text: t.t6(accounts(watchers), p.recovery_address),
    });
  }
  return statements;
}

/**
 * Without an Auto-Clawback Guardian nothing vetoes a Recovery Address change on its own: the
 * plain sentence that says so. Null when the Vault has one.
 */
export function residualRisk(vault: Vault): string | null {
  if (hasWatcher(vault)) return null;
  return copy.proof.residual(durationOf(vault.policy.policy_change_delay_ns));
}

/** The `/proof/<digits>` id, canonical (`007` is `7`); null when it is not a u64. */
export function canonicalVaultId(digits: string): string | null {
  if (!/^\d{1,20}$/.test(digits)) return null;
  const value = BigInt(digits);
  return value > 18_446_744_073_709_551_615n ? null : value.toString();
}

// get_vault_kit and the address recompute (story 6.2)

/** The `get_vault_kit` fields the recompute reads; the witness templates are not read. */
export type ProofKit = Omit<VaultKit, "witness_templates">;

const isScriptHex = (value: unknown): value is string =>
  isHex(value) && value.length > 0 && value.length % 2 === 0;

/** The `get_vault_kit` view (`contracts/vault` `VaultKit`); null when it has another shape. */
export function parseKit(value: unknown): ProofKit | null {
  if (!isRecord(value) || value.kit_version !== 1) return null;
  if (!BTC_NETWORKS.includes(value.btc_network as CoreBtcNetwork)) return null;
  if (!isScriptHex(value.vault_script_hex) || !isScriptHex(value.allowance_script_hex)) return null;
  const blocks = value.escape_timelock_blocks;
  if (typeof blocks !== "number" || !Number.isSafeInteger(blocks) || blocks < 0) return null;
  const addresses = parsePair(value.addresses);
  const cosigners = parsePair(value.cosigner_pubkeys);
  if (!addresses || !cosigners || !isHex(cosigners.vault) || !isHex(cosigners.allowance)) {
    return null;
  }
  return {
    kit_version: 1,
    btc_network: value.btc_network as CoreBtcNetwork,
    vault_script_hex: value.vault_script_hex,
    allowance_script_hex: value.allowance_script_hex,
    addresses,
    escape_timelock_blocks: blocks,
    cosigner_pubkeys: cosigners,
  };
}

export type KitAnswer = { kind: "ok"; kit: ProofKit } | { kind: "failed" };

/**
 * Reads `get_vault_kit` of `vaultId`. Any failure (the RPC, a contract error such as
 * ERR_VAULT_NOT_ACTIVE, another shape) is one answer: the kit could not be read.
 */
export async function readKit(rpc: ProofRpc, vaultId: string): Promise<KitAnswer> {
  const answer = await rpc.view("get_vault_kit", { vault_id: vaultId });
  const kit = answer.kind === "ok" ? parseKit(answer.value) : null;
  return kit === null ? { kind: "failed" } : { kind: "ok", kit };
}

/** Which of the Vault's two scripts: the Vault Address's or the Allowance Address's. */
export type ScriptSource = "vault" | "allowance";

/** Lowercase even-length hex as bytes (the kit's scripts are checked by `parseKit`). */
function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** One row of the decoded script: one element, where it sits and what it is for. */
export interface ScriptRow {
  index: number;
  /** Its first byte in the script. */
  offset: number;
  size: number;
  /** The opcode name: `OP_CHECKSIG`, `OP_PUSHBYTES_33`. */
  name: string;
  /** The pushed bytes in full, hex; null for an opcode without data. */
  data: string | null;
  /** The number a small push or OP_N encodes, when it is the Vault Script's number. */
  number: number | null;
  /** What the template's element at this place is for, while the bytes line up with it. */
  kind: VaultScriptRole | null;
  /** Whose key or which number, from the rebuilt template: `Owner key`. */
  role: string | null;
  /** The path it is on, from the script's own IF / ELSE structure. */
  path: ScriptPath | null;
  /** `IF`, `ELSE IF`, `ELSE` or `ENDIF` for the structure's opcodes. */
  branch: string | null;
  /** Not the template's element at this place. */
  differs: boolean;
  /** One of its bytes is flipped. */
  flipped: boolean;
}

/** The script check: the decoded script against the template rebuilt from `get_vault`. */
export type ScriptCheck =
  | { ok: true }
  /** `element` names the first differing element (`Owner key`), at byte `at`. */
  | { ok: false; element: string; at: number | null };

/** What the recompute of one script found. Every value is computed here, from the kit's bytes. */
export interface Recomputed {
  source: ScriptSource;
  network: CoreBtcNetwork;
  /** The script hashed: the kit's, with the flipped bytes flipped. */
  bytes: Uint8Array;
  flipped: readonly number[];
  rows: ScriptRow[];
  /** The P2WSH address of `bytes`, computed in the browser. */
  address: string;
  /** The address `get_vault` states for this script. */
  funded: string;
  addressMatch: boolean;
  scriptCheck: ScriptCheck;
  /** The byte Flip a byte flips: the last byte of the Owner key's push. */
  flipTarget: number;
}

/** Whose key or which number a template element is: `Owner key`, `Guardian key · alice`. */
function roleOf(element: VaultScriptElement, vault: Vault): string | null {
  const r = copy.proof.recompute.roles;
  switch (element.role) {
    case "owner_key":
      return r.owner;
    case "cosigner_key":
      return r.cosigner;
    case "guardian_key": {
      const guardian = vault.policy.guardians[element.guardian ?? -1];
      return r.guardian((element.guardian ?? 0) + 1, guardian?.guardian_account ?? "");
    }
    case "threshold":
      return r.threshold;
    case "guardian_count":
      return r.guardianCount(vault.policy.guardians.length);
    case "timelock":
      return r.timelock(blocksOf(vault.policy.escape_timelock_blocks));
    default:
      return null;
  }
}

/** The template of `source` from `get_vault`'s keys and timelock; null when a key is unreadable. */
function templateOf(kit: ProofKit, vault: Vault, source: ScriptSource) {
  try {
    return vaultScriptTemplate(
      vault.owner_key,
      kit.cosigner_pubkeys[source],
      vault.policy.guardians.map((guardian) => guardian.guardian_key),
      vault.policy.escape_timelock_blocks,
    );
  } catch {
    return null;
  }
}

/** What the first differing element is called in the script check. */
function elementName(
  element: VaultScriptElement | undefined,
  actual: ScriptOp | null,
  vault: Vault,
): string {
  const r = copy.proof.recompute;
  if (!element) return r.extra(actual?.name ?? "");
  const role = roleOf(element, vault);
  const name = role ?? element.op.name;
  return actual === null ? r.missingElement(name) : r.differs(name);
}

const BRANCHES: Record<ScriptPath, string> = {
  withdrawal: "IF",
  clawback: "ELSE IF",
  escape: "ELSE",
};

/**
 * Recomputes the `source` script of the kit in the browser, with the bytes at `flipped` XOR
 * 0x01: decodes it element by element, hashes it to its P2WSH address and checks both the
 * address against `get_vault`'s and the script against the template rebuilt from `get_vault`'s
 * Owner key, Guardian keys (in Policy order) and Escape Timelock with the kit's Co-signer key.
 * Null when `get_vault` states no address to check against. Pure.
 */
export function recompute(
  kit: ProofKit,
  vault: Vault,
  flipped: readonly number[] = [],
  source: ScriptSource = "vault",
): Recomputed | null {
  if (vault.addresses === null) return null;
  const original = bytesOf(source === "vault" ? kit.vault_script_hex : kit.allowance_script_hex);
  const bytes = original.slice();
  const flips = [...new Set(flipped)].filter((at) => at >= 0 && at < bytes.length);
  for (const at of flips) bytes[at] = (bytes[at] as number) ^ 0x01;

  const ops = decodeScript(bytes);
  const paths = scriptPaths(ops);
  const template = templateOf(kit, vault, source);
  const elements = template?.elements ?? [];
  const difference = template
    ? compareScripts(
        ops,
        elements.map((e) => e.op),
      )
    : null;

  const rows = ops.map((op, index): ScriptRow => {
    const element = elements[index];
    // Labels follow the template only while the bytes line up with it.
    const aligned = element !== undefined && element.op.offset === op.offset;
    const path = paths[index] ?? null;
    const isBranch = op.kind === "op" && [0x63, 0x64, 0x67, 0x68].includes(op.opcode);
    const same = aligned && sameOp(op, element.op);
    const number =
      aligned && ["threshold", "guardian_count", "timelock"].includes(element.role)
        ? scriptNumber(op)
        : null;
    return {
      index,
      offset: op.offset,
      size: op.size,
      name: op.name,
      data: op.kind === "push" ? hexOf(op.data) : null,
      number,
      kind: aligned ? element.role : null,
      role: aligned ? roleOf(element, vault) : null,
      path,
      branch: isBranch ? (op.opcode === 0x68 || path === null ? "ENDIF" : BRANCHES[path]) : null,
      differs: template !== null && !same,
      flipped: flips.some((at) => at >= op.offset && at < op.offset + op.size),
    };
  });

  // Flip a byte targets the Owner key's last byte, found in the kit's own script.
  const originalOps = decodeScript(original);
  const ownerAt = elements.findIndex((e) => e.role === "owner_key");
  const owner = ownerAt >= 0 ? originalOps[ownerAt] : undefined;
  const firstPush = originalOps.find((op) => op.kind === "push");
  const target = owner?.kind === "push" ? owner : firstPush;
  const flipTarget = target ? target.offset + target.size - 1 : 0;

  const address = p2wshAddress(bytes, kit.btc_network);
  const funded = vault.addresses[source];
  let scriptCheck: ScriptCheck;
  if (template === null) {
    scriptCheck = { ok: false, element: copy.proof.recompute.unreadableKeys, at: null };
  } else if (difference === null) {
    scriptCheck = { ok: true };
  } else {
    scriptCheck = {
      ok: false,
      element: elementName(elements[difference.index], difference.actual, vault),
      at: difference.actual?.offset ?? difference.expected?.offset ?? null,
    };
  }
  return {
    source,
    network: kit.btc_network,
    bytes,
    flipped: flips,
    rows,
    address,
    funded,
    addressMatch: address === funded,
    scriptCheck,
    flipTarget,
  };
}

/** What the visitor just did to a recomputed script. */
export type RecomputeEvent =
  { kind: "recompute" } | { kind: "flip"; at: number } | { kind: "reset" };

/** The line the live region reads after a recompute, a flip or a reset. */
export function recomputeAnnouncement(result: Recomputed, event: RecomputeEvent): string {
  const r = copy.proof.recompute;
  const what = result.source === "vault" ? r.vaultAddress : r.allowanceAddress;
  const address = result.addressMatch ? r.matchesShort(what) : r.noMatchShort(what);
  const script = result.scriptCheck.ok ? r.scriptOkShort : result.scriptCheck.element;
  if (event.kind === "flip") return r.announceFlip(event.at, address, script);
  if (event.kind === "reset") return r.announceReset(address, script);
  return r.announce(what, address, script);
}
