import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  NearRpcError,
  txFailure,
  type AccountId,
  type ErrorCode,
  type MorrowEvent,
  type PolicyChangeFields,
  type RpcTxStatus,
  type SignedTx,
  type U64,
} from "@morrow/core-ts";
import type { Logger } from "./log.js";

/**
 * A call from a round's Owner Account that NEAR or the Vault Contract rejected. Rejected calls
 * emit no contract event, so this is their only public record.
 */
export interface RejectedAttempt {
  type: "rejected";
  round: number;
  /** The attempt number in its round (discovery order, never reused). */
  n: number;
  tx_hash: string;
  /** Block time of the transaction (ns since the Unix epoch, decimal). */
  block_timestamp: string;
  /** ISO time of `block_timestamp`; null when the indexer gave an unreadable timestamp. */
  time: string | null;
  method: string | null;
  /** The contract's `ERR_*` code; null when the call failed outside the contract (gas, …). */
  code: ErrorCode | null;
  /** The raw NEAR failure kind, e.g. `ActionError.FunctionCallError.HostError.GasExceeded`. */
  failure: string;
}

/** The published function-call key was replaced (spent allowance or deleted). */
export interface KeyRotated {
  type: "key_rotated";
  round: number;
  time: string;
  reason: "allowance_low" | "key_missing";
  old_public_key: string;
  new_public_key: string;
}

/** A rejected call as the scanner finds it, before the store numbers it. */
export type NewRejectedAttempt = Omit<RejectedAttempt, "n">;

export type WithdrawalOutcome = "pending" | "clawed_back" | "cancelled" | "signed";

/** A `withdrawal_requested` event of a served round, followed to its outcome. */
export interface WithdrawalAttempt {
  type: "withdrawal";
  round: number;
  n: number;
  /** The `withdrawal_requested` event's seq. */
  seq: U64;
  vault_id: U64;
  op_id: U64;
  amount_sats: U64;
  destination: string;
  /** ns since the Unix epoch, decimal, like every event timestamp. */
  requested_at: U64;
  executable_at: U64;
  /** ISO time of `requested_at`. */
  time: string | null;
  /** `op_voided` → clawed_back, `withdrawal_cancelled` → cancelled, `op_signed` → signed. */
  outcome: WithdrawalOutcome;
  outcome_at: U64 | null;
  outcome_time: string | null;
  /** The Clawback op that voided this request (`op_voided.by_op_id`). */
  clawback_op_id: U64 | null;
  /** Txid of the Clawback's transaction, from `get_op(by_op_id).unsigned_tx_hex`. */
  clawback_txid: string | null;
  /** True once the Bitcoin backend returns the Clawback transaction. */
  clawback_broadcast: boolean;
  /** The NEAR transaction that requested it; null until the scanner has read it. */
  tx_hash: string | null;
}

export type PolicyChangeOutcome = "pending" | "vetoed" | "withdrawn" | "applied";

/** A `policy_change_proposed` event of a served round, followed to its outcome. */
export interface PolicyChangeAttempt {
  type: "policy_change";
  round: number;
  n: number;
  seq: U64;
  vault_id: U64;
  change_id: U64;
  changes: PolicyChangeFields;
  proposed_at: U64;
  effective_at: U64;
  time: string | null;
  outcome: PolicyChangeOutcome;
  outcome_at: U64 | null;
  outcome_time: string | null;
  tx_hash: string | null;
}

/** Attempts derived from `events_since`. */
export type EventAttempt = WithdrawalAttempt | PolicyChangeAttempt;

/** Entries that count as attempts and carry a per-round `n`. */
export type Attempt = RejectedAttempt | EventAttempt;

export type AttemptEntry = Attempt | KeyRotated;

/** Persisted counters: never derived from the trimmed entries. */
export interface AttemptCounters {
  attempts_total: number;
  /** Round number → attempts in that round. */
  rounds: Record<string, number>;
  /** Sum of `amount_sats` of signed withdrawals, decimal. */
  sats_taken_total: string;
  /** ISO time of the newest attempt. */
  last_attempt_at: string | null;
}

/** The summary `GET /attempts` serves next to the entries. */
export interface AttemptSummary {
  round: number | null;
  attempts_round: number;
  attempts_total: number;
  sats_taken_total: number;
  last_attempt_at: string | null;
}

/** Entries kept (newest first). */
export const MAX_ATTEMPT_ENTRIES = 500;
/** Seen (and pending) hashes kept per round, and rounds kept. */
const MAX_SEEN_PER_ROUND = 5_000;
const MAX_SEEN_ROUNDS = 10;
/** NEAR RPC lookups per tick; the rest stay pending. */
export const MAX_LOOKUPS_PER_TICK = 50;
/** A pending hash RPC still cannot read after this many lookups is given up (marked seen). */
const MAX_LOOKUP_TRIES = 20;
/** Event identities → NEAR tx hash kept (oldest dropped first). */
export const MAX_TX_HASHES = 5_000;

/** A listed hash RPC has not resolved yet. */
export interface PendingTx {
  hash: string;
  block_timestamp: string;
  tries: number;
}

interface State {
  entries: AttemptEntry[];
  /** Round number → transaction hashes already read (successful or not), oldest first. */
  seen: Record<string, string[]>;
  /** Round number → listed hashes still to read over RPC, oldest first. */
  pending: Record<string, PendingTx[]>;
  /** The last `events_since` seq applied; the tail resumes after it. */
  cursor: U64;
  /** Round number → the last attempt number given out in that round. */
  last_n: Record<string, number>;
  counters: AttemptCounters;
  /**
   * `[event identity, tx hash]`, oldest first, at most `MAX_TX_HASHES`. NEP-297 logs carry no
   * seq, so an event is identified by `eventIdentity` and matched to its seq when tailed.
   */
  tx_hashes: [string, string][];
}

const emptyCounters = (): AttemptCounters => ({
  attempts_total: 0,
  rounds: {},
  sats_taken_total: "0",
  last_attempt_at: null,
});

const empty = (): State => ({
  entries: [],
  seen: {},
  pending: {},
  cursor: "0",
  last_n: {},
  counters: emptyCounters(),
  tx_hashes: [],
});

/**
 * The identity of an event that opens an attempt, the same from an `events_since` view and from
 * its `EVENT_JSON:` log line; null for every other kind.
 */
export function eventIdentity(kind: string, vaultId: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as Record<string, unknown>;
  if (kind === "withdrawal_requested" && typeof data.op_id === "string") {
    return `withdrawal_requested:${vaultId}:${data.op_id}`;
  }
  if (kind === "policy_change_proposed" && typeof data.change_id === "string") {
    return `policy_change_proposed:${vaultId}:${data.change_id}`;
  }
  return null;
}

/** Identities of the attempt-opening events in a transaction's Vault Contract logs. */
export function loggedIdentities(tx: RpcTxStatus, vaultContract: AccountId): string[] {
  const identities: string[] = [];
  for (const outcome of tx.receipts_outcome) {
    if (outcome.outcome.executor_id !== vaultContract) continue;
    for (const line of outcome.outcome.logs) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      let log: unknown;
      try {
        log = JSON.parse(line.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (typeof log !== "object" || log === null) continue;
      const { standard, event, data } = log as Record<string, unknown>;
      if (standard !== "morrow" || typeof event !== "string" || !Array.isArray(data)) continue;
      for (const item of data as unknown[]) {
        if (typeof item !== "object" || item === null) continue;
        const { vault_id, payload } = item as Record<string, unknown>;
        if (typeof vault_id !== "string") continue;
        const identity = eventIdentity(event, vault_id, payload);
        if (identity) identities.push(identity);
      }
    }
  }
  return identities;
}

const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b;

const timeOf = (entry: AttemptEntry) => (entry.time === null ? 0 : Date.parse(entry.time));

/** Keeps the newest `MAX_SEEN_ROUNDS` rounds of a per-round map. */
function newestRounds<T>(map: Record<string, T>): Record<string, T> {
  const kept = Object.keys(map)
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, MAX_SEEN_ROUNDS);
  return Object.fromEntries(kept.map((k) => [k, map[k] as T]));
}

/** The Attempt Log's rejected calls and key rotations. Writes are serialized per instance. */
export abstract class AttemptStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Newest first, at most `MAX_ATTEMPT_ENTRIES`. */
  async entries(): Promise<AttemptEntry[]> {
    return (await this.load()).entries;
  }

  /** The persisted counters (attempts per round and in total, sats taken, last attempt). */
  async counters(): Promise<AttemptCounters> {
    return (await this.load()).counters;
  }

  /** `GET /attempts`'s summary for the current round (null when none is open). */
  async summary(round: number | null): Promise<AttemptSummary> {
    const counters = await this.counters();
    return {
      round,
      attempts_round: round === null ? 0 : (counters.rounds[String(round)] ?? 0),
      attempts_total: counters.attempts_total,
      sats_taken_total: Number(counters.sats_taken_total),
      last_attempt_at: counters.last_attempt_at,
    };
  }

  /** The last applied event seq. */
  async cursor(): Promise<U64> {
    return (await this.load()).cursor;
  }

  async seen(round: number): Promise<Set<string>> {
    return new Set((await this.load()).seen[String(round)] ?? []);
  }

  async pending(round: number): Promise<PendingTx[]> {
    return (await this.load()).pending[String(round)] ?? [];
  }

  /** Queues listed hashes (oldest first) that are neither seen nor already pending. */
  addPending(round: number, txs: SignedTx[]): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const key = String(round);
      const queue = state.pending[key] ?? [];
      const known = new Set([...(state.seen[key] ?? []), ...queue.map((p) => p.hash)]);
      for (const tx of txs) {
        if (known.has(tx.hash)) continue;
        known.add(tx.hash);
        queue.push({ hash: tx.hash, block_timestamp: String(tx.blockTimestampNs), tries: 0 });
      }
      state.pending[key] = queue.slice(-MAX_SEEN_PER_ROUND);
      state.pending = newestRounds(state.pending);
      await this.save(state);
    });
  }

  /**
   * Marks `hashes` seen (and no longer pending) for `round`, counts a failed lookup for each of
   * `retry`, and adds `entries`, in one write. A rejected entry whose hash is already logged is
   * dropped; a new one gets the round's next attempt number.
   */
  record(
    round: number,
    hashes: string[],
    entries: (NewRejectedAttempt | KeyRotated)[] = [],
    retry: string[] = [],
  ): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const key = String(round);
      const seen = new Set(state.seen[key] ?? []);
      for (const hash of hashes) seen.add(hash);
      state.seen[key] = [...seen].slice(-MAX_SEEN_PER_ROUND);
      state.seen = newestRounds(state.seen);
      if (state.pending[key]) {
        const failed = new Set(retry);
        state.pending[key] = state.pending[key]
          .filter((p) => !seen.has(p.hash))
          .map((p) => (failed.has(p.hash) ? { ...p, tries: p.tries + 1 } : p));
      }

      const logged = new Set(
        state.entries.flatMap((e) => (e.type === "rejected" ? [e.tx_hash] : [])),
      );
      for (const entry of entries) {
        if (entry.type === "rejected") {
          if (logged.has(entry.tx_hash)) continue;
          logged.add(entry.tx_hash);
          state.entries.push({ ...entry, n: nextAttempt(state, entry.round, entry.time) });
        } else {
          state.entries.push(entry);
        }
      }
      sortAndTrim(state);
      await this.save(state);
    });
  }

  add(entry: KeyRotated): Promise<void> {
    return this.record(entry.round, [], [entry]);
  }

  /**
   * Applies one `events_since` page in one write: events after the cursor whose Vault belongs
   * to a served round (`roundOf` non-null) open attempts or settle their outcome; every other
   * event, and every unknown kind, is skipped. The cursor moves to the page's last seq. Returns
   * the attempts opened and the cursor.
   */
  applyEvents(
    events: readonly MorrowEvent[],
    roundOf: (vaultId: U64) => number | null,
  ): Promise<{ opened: EventAttempt[]; settled: EventAttempt[]; cursor: U64 }> {
    return this.exclusive(async () => {
      const state = await this.load();
      let cursor = BigInt(state.cursor);
      const opened: EventAttempt[] = [];
      const settled: EventAttempt[] = [];
      const hashes = new Map(state.tx_hashes);
      const knownSeqs = new Set(
        state.entries.flatMap((e) =>
          e.type === "withdrawal" || e.type === "policy_change" ? [e.seq] : [],
        ),
      );
      const sorted = [...events].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
      for (const event of sorted) {
        const seq = BigInt(event.seq);
        if (seq <= cursor) continue;
        cursor = seq;
        const round = roundOf(event.vault_id);
        if (round === null || knownSeqs.has(event.seq)) continue;
        const at = event.block_timestamp;
        const time = nsToIso(at);
        switch (event.kind) {
          case "withdrawal_requested": {
            const identity = eventIdentity(event.kind, event.vault_id, event.data);
            const entry: WithdrawalAttempt = {
              type: "withdrawal",
              round,
              n: nextAttempt(state, round, time),
              seq: event.seq,
              vault_id: event.vault_id,
              op_id: event.data.op_id,
              amount_sats: event.data.amount_sats,
              destination: event.data.destination,
              requested_at: at,
              executable_at: event.data.executable_at,
              time,
              outcome: "pending",
              outcome_at: null,
              outcome_time: null,
              clawback_op_id: null,
              clawback_txid: null,
              clawback_broadcast: false,
              tx_hash: (identity && hashes.get(identity)) ?? null,
            };
            state.entries.push(entry);
            knownSeqs.add(event.seq);
            opened.push(entry);
            break;
          }
          case "policy_change_proposed": {
            const identity = eventIdentity(event.kind, event.vault_id, event.data);
            const entry: PolicyChangeAttempt = {
              type: "policy_change",
              round,
              n: nextAttempt(state, round, time),
              seq: event.seq,
              vault_id: event.vault_id,
              change_id: event.data.change_id,
              changes: event.data.changes,
              proposed_at: at,
              effective_at: event.data.effective_at,
              time,
              outcome: "pending",
              outcome_at: null,
              outcome_time: null,
              tx_hash: (identity && hashes.get(identity)) ?? null,
            };
            state.entries.push(entry);
            knownSeqs.add(event.seq);
            opened.push(entry);
            break;
          }
          case "op_voided":
          case "withdrawal_cancelled":
          case "op_signed": {
            const entry = state.entries.find(
              (e): e is WithdrawalAttempt =>
                e.type === "withdrawal" &&
                e.vault_id === event.vault_id &&
                e.op_id === event.data.op_id,
            );
            if (!entry || entry.outcome !== "pending") break;
            entry.outcome_at = at;
            entry.outcome_time = time;
            if (event.kind === "op_voided") {
              entry.outcome = "clawed_back";
              entry.clawback_op_id = event.data.by_op_id;
            } else if (event.kind === "withdrawal_cancelled") {
              entry.outcome = "cancelled";
            } else {
              entry.outcome = "signed";
              state.counters.sats_taken_total = (
                BigInt(state.counters.sats_taken_total) + BigInt(entry.amount_sats)
              ).toString();
            }
            settled.push(entry);
            break;
          }
          case "policy_change_vetoed":
          case "policy_change_withdrawn":
          case "policy_change_applied": {
            const entry = state.entries.find(
              (e): e is PolicyChangeAttempt =>
                e.type === "policy_change" &&
                e.vault_id === event.vault_id &&
                e.change_id === event.data.change_id,
            );
            if (!entry || entry.outcome !== "pending") break;
            entry.outcome_at = at;
            entry.outcome_time = time;
            entry.outcome =
              event.kind === "policy_change_vetoed"
                ? "vetoed"
                : event.kind === "policy_change_withdrawn"
                  ? "withdrawn"
                  : "applied";
            settled.push(entry);
            break;
          }
          default:
            // Not an attempt (vault_created, op_frozen, …) or a kind this tool does not know.
            break;
        }
      }
      state.cursor = cursor.toString();
      sortAndTrim(state);
      await this.save(state);
      return { opened, settled, cursor: state.cursor };
    });
  }

  /**
   * Remembers which NEAR transaction emitted each event identity (at most `MAX_TX_HASHES`,
   * oldest dropped) and fills `tx_hash` of the entries it opened.
   */
  addTxHashes(pairs: readonly (readonly [string, string])[]): Promise<void> {
    if (pairs.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      const state = await this.load();
      const map = new Map(state.tx_hashes);
      for (const [identity, hash] of pairs) {
        map.delete(identity);
        map.set(identity, hash);
      }
      state.tx_hashes = [...map].slice(-MAX_TX_HASHES);
      for (const entry of state.entries) {
        if ((entry.type !== "withdrawal" && entry.type !== "policy_change") || entry.tx_hash) {
          continue;
        }
        const identity =
          entry.type === "withdrawal"
            ? eventIdentity("withdrawal_requested", entry.vault_id, { op_id: entry.op_id })
            : eventIdentity("policy_change_proposed", entry.vault_id, {
                change_id: entry.change_id,
              });
        const hash = identity === null ? undefined : map.get(identity);
        if (hash !== undefined) entry.tx_hash = hash;
      }
      await this.save(state);
    });
  }

  /** Sets the Clawback txid and broadcast flag of the withdrawal opened by event `seq`. */
  patchClawback(
    seq: U64,
    patch: Pick<WithdrawalAttempt, "clawback_txid" | "clawback_broadcast">,
  ): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const entry = state.entries.find(
        (e): e is WithdrawalAttempt => e.type === "withdrawal" && e.seq === seq,
      );
      if (!entry) return;
      entry.clawback_txid = patch.clawback_txid;
      entry.clawback_broadcast = patch.clawback_broadcast;
      await this.save(state);
    });
  }
}

/** The round's next attempt number; counts the attempt. */
function nextAttempt(state: State, round: number, time: string | null): number {
  const key = String(round);
  const n = (state.last_n[key] ?? 0) + 1;
  state.last_n[key] = n;
  state.counters.rounds[key] = (state.counters.rounds[key] ?? 0) + 1;
  state.counters.attempts_total += 1;
  state.counters.last_attempt_at = later(state.counters.last_attempt_at, time);
  return n;
}

/** Newest first (stable: ties keep their order), at most `MAX_ATTEMPT_ENTRIES`. */
function sortAndTrim(state: State): void {
  state.entries = state.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => timeOf(b.entry) - timeOf(a.entry) || a.index - b.index)
    .map(({ entry }) => entry)
    .slice(0, MAX_ATTEMPT_ENTRIES);
}

export class InMemoryAttemptStore extends AttemptStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** One JSON file, replaced atomically on every write. Holds public data only. */
export class FileAttemptStore extends AttemptStore {
  constructor(private readonly path: string) {
    super();
  }

  protected async load(): Promise<State> {
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as Partial<State>;
      return { ...empty(), ...stored, counters: { ...emptyCounters(), ...stored.counters } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** Where rejected calls are found: the indexer lists hashes, NEAR RPC is the source of truth. */
export interface AttemptSources {
  /** Transactions signed by `accountId`, newest first (FastNEAR `signedBy`). */
  signedBy(accountId: AccountId, isKnown: (hash: string) => boolean): Promise<SignedTx[]>;
  /** `EXPERIMENTAL_tx_status` (core-ts `FetchNearRpc.txStatus`). */
  txStatus(hash: string, senderId: AccountId): Promise<RpcTxStatus>;
}

export interface ScanTarget {
  round: number;
  owner_account: AccountId;
  vault_contract: AccountId;
}

/** ISO time of a decimal ns timestamp; null when it is not one. */
export function nsToIso(ns: string): string | null {
  if (!/^\d{1,30}$/.test(ns)) return null;
  const date = new Date(Number(BigInt(ns) / 1_000_000n));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The indexer (or a transport to it) failed: the listing is skipped this tick. */
export class AttemptSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AttemptSourceError";
  }
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Lists the round Owner Account's transactions and queues the new hashes as pending (persisted),
 * then reads up to `maxLookups` pending hashes over RPC, oldest first, and logs the calls to the
 * Vault Contract that failed. Successful calls (they have contract events) give the tx hash of
 * the attempts their `EVENT_JSON:` logs opened; other transactions are only marked seen. A
 * hash RPC cannot read yet stays pending and is retried directly. Pending hashes are read even
 * when the listing fails; the listing failure is then returned as `listError`. Store failures
 * throw.
 */
export async function scanRejectedAttempts(
  target: ScanTarget,
  sources: AttemptSources,
  store: AttemptStore,
  log: Logger,
  maxLookups = MAX_LOOKUPS_PER_TICK,
): Promise<{ entries: number; lookups: number; listError: AttemptSourceError | null }> {
  const seen = await store.seen(target.round);
  const known = new Set([...seen, ...(await store.pending(target.round)).map((p) => p.hash)]);
  let listError: AttemptSourceError | null = null;
  let listed: SignedTx[] = [];
  try {
    listed = await sources.signedBy(target.owner_account, (hash) => known.has(hash));
  } catch (error) {
    listError = new AttemptSourceError(`indexer: ${text(error)}`, { cause: error });
  }
  // Oldest first, so the queue grows from the past. A store failure throws.
  if (listed.length > 0) await store.addPending(target.round, [...listed].reverse());

  const queue = (await store.pending(target.round)).slice(0, Math.max(0, maxLookups));
  const done: string[] = [];
  const retry: string[] = [];
  const entries: NewRejectedAttempt[] = [];
  const hashes: [string, string][] = [];
  for (const pending of queue) {
    let tx: RpcTxStatus;
    try {
      tx = await sources.txStatus(pending.hash, target.owner_account);
    } catch (error) {
      if (pending.tries + 1 >= MAX_LOOKUP_TRIES) {
        done.push(pending.hash);
        log("warn", "attempt scan: giving up on a transaction RPC cannot read", {
          round: target.round,
          tx_hash: pending.hash,
          error: text(error),
        });
        continue;
      }
      retry.push(pending.hash);
      const unknown = error instanceof NearRpcError && error.causeName === "UNKNOWN_TRANSACTION";
      log(unknown ? "debug" : "warn", "attempt scan: transaction not readable yet; will retry", {
        round: target.round,
        tx_hash: pending.hash,
        error: text(error),
      });
      continue;
    }
    done.push(pending.hash);
    if (tx.transaction.receiver_id !== target.vault_contract) continue;
    const failure = txFailure(tx, target.vault_contract);
    if (!failure) {
      // A successful call: its events are tailed from `events_since`; keep its hash for them.
      for (const identity of loggedIdentities(tx, target.vault_contract)) {
        hashes.push([identity, pending.hash]);
      }
      continue;
    }
    entries.push({
      type: "rejected",
      round: target.round,
      tx_hash: pending.hash,
      block_timestamp: pending.block_timestamp,
      time: nsToIso(pending.block_timestamp),
      method: failure.method,
      code: failure.code,
      failure: failure.failure,
    });
  }
  // Hashes first: a crash before `record` only re-reads these transactions.
  await store.addTxHashes(hashes);
  if (queue.length > 0) await store.record(target.round, done, entries, retry);
  for (const entry of entries) {
    log("info", "rejected attempt", {
      round: entry.round,
      tx_hash: entry.tx_hash,
      method: entry.method,
      code: entry.code,
      failure: entry.failure,
    });
  }
  return { entries: entries.length, lookups: queue.length, listError };
}
