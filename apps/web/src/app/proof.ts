// The Proof Page's chain reads (story 6.1): `get_vault`, `events_since` (paged from the Vault's
// `created_at`), RPC `view_account` (the contract's `code_hash`) and `view_access_key_list`
// (its full-access keys), all over the configured NEAR RPC, plus the pure mapping and the
// generated guarantee and trust statements. Nothing is cached anywhere but in this page's
// memory, and nothing here invents a value: what cannot be read is said to be unreadable.
import type {
  BtcNetwork as CoreBtcNetwork,
  Guardian,
  GuardianKind,
  Policy,
  PolicyChange,
  PolicyChangeFields,
  Vault,
  VaultState,
} from "@morrow/core-ts/browser";
import { copy } from "@/copy";
import { absoluteTime, formatDuration, nsToMs, viewResult } from "./challenge";
import { withTimeout } from "./live";

/** How often the page reads the chain again. */
export const PROOF_POLL_MS = 30_000;
/** `events_since` answers at most this many events per call. */
export const EVENTS_PAGE = 100;
/** Pages read per refresh; past that the page says the history is truncated. */
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
  data: Record<string, unknown>;
}

/** An `events_since` answer; null when any entry has another shape. */
export function parseEvents(value: unknown): ProofEvent[] | null {
  if (!Array.isArray(value)) return null;
  const events: ProofEvent[] = [];
  for (const event of value as unknown[]) {
    if (!isRecord(event) || !isU64(event.seq) || !isU64(event.block_timestamp)) return null;
    if (!isU64(event.vault_id) || !isString(event.kind) || !isRecord(event.data)) return null;
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

/** Events with `seq > cursor`, at most `limit`. */
export type EventPage = (cursor: bigint, limit: number) => Promise<ProofEvent[]>;

function eventPage(rpc: ProofRpc): EventPage {
  return async (cursor, limit) => {
    const answer = await rpc.view("events_since", { cursor: cursor.toString(), limit });
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

/**
 * The Vault's events from `start`, ascending, reading at most `maxPages` pages of 100.
 * `truncated` when more events follow the last page read.
 */
export async function vaultEvents(
  page: EventPage,
  vaultId: string,
  start: bigint,
  maxPages = MAX_EVENT_PAGES,
): Promise<{ events: ProofEvent[]; truncated: boolean }> {
  const events: ProofEvent[] = [];
  let cursor = start;
  for (let pages = 0; pages < maxPages; pages++) {
    const batch = await page(cursor, EVENTS_PAGE);
    for (const event of batch) if (event.vault_id === vaultId) events.push(event);
    const last = batch.at(-1);
    if (!last || batch.length < EVENTS_PAGE) return { events, truncated: false };
    cursor = BigInt(last.seq);
  }
  // The cap was reached: one more event means the history goes on past what was read.
  const more = await page(cursor, 1);
  return { events, truncated: more.length > 0 };
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

/** Events that settle a withdrawal: it is no longer pending. */
const SETTLING = new Set(["withdrawal_cancelled", "op_signed", "op_voided"]);

/**
 * Withdrawals still Pending or Frozen: a `withdrawal_requested` without a later
 * `withdrawal_cancelled`, `op_signed` or `op_voided`, in request order. Also the Clawback,
 * from `vault_clawed_back`. `events` are the Vault's, ascending.
 */
export function pendingFrom(events: readonly ProofEvent[]): {
  withdrawals: PendingWithdrawal[];
  clawedBack: ClawedBack | null;
} {
  const open = new Map<string, PendingWithdrawal>();
  let clawedBack: ClawedBack | null = null;
  for (const event of events) {
    const data = event.data;
    const opId = isU64(data.op_id) ? data.op_id : null;
    if (event.kind === "withdrawal_requested") {
      if (opId === null || !isU64(data.amount_sats) || !isU64(data.executable_at)) continue;
      open.set(opId, {
        opId,
        amountSats: data.amount_sats,
        destination: isString(data.destination) ? data.destination : "",
        executableAt: data.executable_at,
        requestedAt: event.block_timestamp,
        frozen: false,
      });
    } else if (event.kind === "fast_approved") {
      const op = opId === null ? undefined : open.get(opId);
      if (op && isU64(data.executable_at)) op.executableAt = data.executable_at;
    } else if (event.kind === "op_frozen") {
      const op = opId === null ? undefined : open.get(opId);
      if (op) op.frozen = true;
    } else if (SETTLING.has(event.kind)) {
      if (opId !== null) open.delete(opId);
    } else if (event.kind === "vault_clawed_back") {
      if (isAccount(data.recovery_address)) {
        clawedBack = { recoveryAddress: data.recovery_address, at: event.block_timestamp };
      }
    }
  }
  return { withdrawals: [...open.values()], clawedBack };
}

// One refresh

/** What one refresh read from the chain. */
export interface ProofFacts {
  vault: Vault;
  withdrawals: PendingWithdrawal[];
  clawedBack: ClawedBack | null;
  /** More than `MAX_EVENT_PAGES` pages of history: the pending list may miss some. */
  truncated: boolean;
  /** Null when `view_account` answered without a readable one. */
  codeHash: string | null;
  /** Full-access keys on the contract account; null when the list could not be read. */
  fullAccessKeys: number | null;
}

export type ProofAnswer =
  | { kind: "ok"; facts: ProofFacts }
  /** `get_vault` failed in the contract: no such Vault. `code` is its `ERR_*`, verbatim. */
  | { kind: "missing"; code: string | null }
  | { kind: "unreachable" };

/**
 * Reads the Vault and its facts. `starts` keeps the scan's first cursor per Vault between
 * refreshes (it never moves: the log is append-only), so the binary search runs once.
 */
export async function readProof(
  rpc: ProofRpc,
  contractId: string,
  vaultId: string,
  starts: Map<string, bigint> = new Map(),
): Promise<ProofAnswer> {
  const answer = await rpc.view("get_vault", { vault_id: vaultId });
  if (answer.kind === "error") {
    return { kind: "missing", code: /ERR_[A-Z_]+/.exec(answer.text)?.[0] ?? null };
  }
  if (answer.kind === "unreachable") return { kind: "unreachable" };
  const vault = parseVault(answer.value);
  if (vault === null || vault.vault_id !== vaultId) return { kind: "unreachable" };
  try {
    const page = eventPage(rpc);
    const key = `${vaultId}:${vault.created_at}`;
    const scan = async () => {
      let start = starts.get(key);
      if (start === undefined) {
        start = await firstCursorAtOrAfter(page, BigInt(vault.created_at));
        starts.set(key, start);
      }
      return vaultEvents(page, vaultId, start);
    };
    const [account, keys, history] = await Promise.all([
      rpc.query({ request_type: "view_account", account_id: contractId }),
      rpc.query({ request_type: "view_access_key_list", account_id: contractId }),
      scan(),
    ]);
    if (account.kind === "unreachable" || keys.kind === "unreachable") {
      return { kind: "unreachable" };
    }
    const { withdrawals, clawedBack } = pendingFrom(history.events);
    return {
      kind: "ok",
      facts: {
        vault,
        withdrawals,
        clawedBack,
        truncated: history.truncated,
        codeHash: account.kind === "ok" ? codeHashFrom(account.value) : null,
        fullAccessKeys: keys.kind === "ok" ? fullAccessKeysFrom(keys.value) : null,
      },
    };
  } catch {
    // A page that could not be read (`Unreachable`) or any other surprise: nothing is shown
    // that was not read, and the next refresh tries again.
    return { kind: "unreachable" };
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
  ];
}

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

// Statements

export interface Statement {
  /** `G-1` … `G-4`, `T-1` … `T-6`. */
  id: string;
  title: string;
  text: string;
}

/** What the statements read besides the Vault. */
export interface StatementFacts {
  now: number;
  contractId: string;
  /** The configured Co-signer (MPC signer) account. */
  coSigner: string;
  codeHash: string | null;
  withdrawals: readonly PendingWithdrawal[];
}

const guardiansOf = (vault: Vault, kind?: GuardianKind) =>
  vault.policy.guardians.filter((guardian) => kind === undefined || guardian.kind === kind);

const accounts = (guardians: readonly Guardian[]) =>
  guardians.map((guardian) => guardian.guardian_account).join(", ");

/** The earliest `executable_at` among pending withdrawals, ns. */
function earliestExecutable(withdrawals: readonly PendingWithdrawal[]): string | null {
  let earliest: string | null = null;
  for (const op of withdrawals) {
    if (earliest === null || BigInt(op.executableAt) < BigInt(earliest)) earliest = op.executableAt;
  }
  return earliest;
}

/** G-1 to G-4 for this Vault, every value from its Policy. Pure. */
export function guarantees(vault: Vault, facts: StatementFacts): Statement[] {
  const g = copy.proof.guarantees;
  const p = vault.policy;
  const delay = durationOf(p.delay_ns);
  const blocks = blocksOf(p.escape_timelock_blocks);
  const earliest = earliestExecutable(facts.withdrawals);
  const g1 = [g.g1(delay, blocks)];
  if (p.fast_approval) g1.push(g.g1Fast(durationOf(p.fast_approval_floor_ns)));
  g1.push(
    p.allowance_limit_sats === "0"
      ? g.g1NoAllowance
      : g.g1Allowance(formatAmount(p.allowance_limit_sats, p.btc_network)),
  );
  if (earliest !== null) g1.push(g.g1Earliest(absoluteTime(nsToMs(earliest), facts.now)));

  const change = pendingChangeOf(vault);
  const g4 = [g.g4(durationOf(p.policy_change_delay_ns), p.recovery_address)];
  if (change) {
    g4.push(g.g4Pending(change.change_id, absoluteTime(nsToMs(change.effective_at), facts.now)));
  }
  return [
    { id: "G-1", title: g.g1Title, text: g1.join(" ") },
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
      text: t.t5(
        contacts.length === 0 ? t.noTrustedContact : accounts(contacts),
        durationOf(p.fast_approval_floor_ns),
        durationOf(p.delay_ns),
      ),
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
  if (guardiansOf(vault, "auto_clawback").length > 0) return null;
  return copy.proof.residual(durationOf(vault.policy.policy_change_delay_ns));
}

/** The `/proof/<digits>` id, canonical (`007` is `7`); null when it is not a u64. */
export function canonicalVaultId(digits: string): string | null {
  if (!/^\d{1,20}$/.test(digits)) return null;
  const value = BigInt(digits);
  return value > 18_446_744_073_709_551_615n ? null : value.toString();
}
