import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  NearRpcError,
  txFailure,
  type AccountId,
  type ErrorCode,
  type RpcTxStatus,
  type SignedTx,
} from "@morrow/core-ts";
import type { Logger } from "./log.js";

/**
 * A call from a round's Owner Account that NEAR or the Vault Contract rejected. Rejected calls
 * emit no contract event, so this is their only public record.
 */
export interface RejectedAttempt {
  type: "rejected";
  round: number;
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

export type AttemptEntry = RejectedAttempt | KeyRotated;

/** Entries kept (newest first). */
export const MAX_ATTEMPT_ENTRIES = 500;
/** Seen (and pending) hashes kept per round, and rounds kept. */
const MAX_SEEN_PER_ROUND = 5_000;
const MAX_SEEN_ROUNDS = 10;
/** NEAR RPC lookups per tick; the rest stay pending. */
export const MAX_LOOKUPS_PER_TICK = 50;
/** A pending hash RPC still cannot read after this many lookups is given up (marked seen). */
const MAX_LOOKUP_TRIES = 20;

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
}

const empty = (): State => ({ entries: [], seen: {}, pending: {} });

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
   * dropped.
   */
  record(
    round: number,
    hashes: string[],
    entries: AttemptEntry[] = [],
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
        }
        state.entries.push(entry);
      }
      // Stable sort: newest first, ties keep their order.
      state.entries = state.entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => timeOf(b.entry) - timeOf(a.entry) || a.index - b.index)
        .map(({ entry }) => entry)
        .slice(0, MAX_ATTEMPT_ENTRIES);
      await this.save(state);
    });
  }

  add(entry: AttemptEntry): Promise<void> {
    return this.record(entry.round, [], [entry]);
  }
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
      return { ...empty(), ...(JSON.parse(await readFile(this.path, "utf8")) as Partial<State>) };
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
 * Vault Contract that failed. Successful calls (they have contract events) and other
 * transactions are only marked seen. A hash RPC cannot read yet stays pending and is retried
 * directly. Pending hashes are read even when the listing fails; the listing failure is then
 * returned as `listError`. Store failures throw.
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
  const entries: RejectedAttempt[] = [];
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
    if (!failure) continue;
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
