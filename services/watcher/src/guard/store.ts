import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Hex, U64 } from "@morrow/core-ts";
import type { Logger } from "../log.js";

/** The Watcher Envelope's flag; `unknown` when the guard cannot open it. */
export type GuardDuress = "normal" | "duress" | "unknown";

/**
 * scheduled → vetoed (the guard's veto landed) | settled (the change stopped being pending some
 * other way). `skipped`: nothing to veto (tightening, not duress), a Challenge Vault (whose
 * changes the challenge handler vetoes) or a misconfigured Vault. `cause` says why.
 */
export type GuardStatus = "scheduled" | "vetoed" | "settled" | "skipped";

export const GUARD_FINAL_STATUSES: readonly GuardStatus[] = ["vetoed", "settled", "skipped"];

/** Final entries are dropped this long after their last update. */
export const GUARD_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Owner Confirmation (5.3b): `none` until a request is delivered to an owner chat, `requested`
 * after, `confirmed` once the Owner confirmed from the active owner chat, `rejected` once an owner
 * chat pressed Reject (which vetoes at once).
 */
export type GuardConfirmation = "none" | "requested" | "confirmed" | "rejected";

type ConfirmationFields = Pick<
  GuardEntry,
  "confirmation" | "binding" | "confirmed_by_chat" | "confirmed_at" | "request_chats"
>;

/** The Owner Confirmation fields of an entry that has none yet. */
export const noConfirmation = (): ConfirmationFields => ({
  confirmation: "none",
  binding: null,
  confirmed_by_chat: null,
  confirmed_at: null,
  request_chats: [],
});

/** One Policy Change on a guarded Vault. Never holds the envelope or any secret. */
export interface GuardEntry {
  change_id: U64;
  vault_id: U64;
  /** NEAR block time (ns) of the proposal. */
  proposed_at: U64;
  effective_at: U64;
  /** `effective_at − 65 min`: from then on the guard vetoes the change while it is pending. */
  veto_at: U64;
  loosening: boolean;
  /** `looseningReasons`. */
  reasons: string[];
  duress: GuardDuress;
  status: GuardStatus;
  /** Why the entry was skipped or settled; null while scheduled and once vetoed. */
  cause: string | null;
  confirmation: GuardConfirmation;
  /**
   * `changeBinding` of the change as the request showed it; a confirmation counts only while the
   * change read from the contract still has this binding.
   */
  binding: Hex | null;
  /** The owner chat that confirmed, and the NEAR time (ns) it did. */
  confirmed_by_chat: number | null;
  confirmed_at: U64 | null;
  /** Owner chats the confirmation request was delivered to (each gets it once). */
  request_chats: number[];
  /** The last failed read or veto, kept for the operator. */
  last_error: string | null;
  updated_at: string;
}

interface State {
  entries: GuardEntry[];
}

const empty = (): State => ({ entries: [] });

/** Entries written before Owner Confirmation have none of its fields. */
const withDefaults = (entry: GuardEntry): GuardEntry => ({
  ...noConfirmation(),
  ...entry,
  request_chats: [...(entry.request_chats ?? [])],
});

/** Loosening-guard schedule. Writes are serialized per instance. */
export abstract class GuardStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Drops final entries not updated for `GUARD_PRUNE_AFTER_MS`, then saves. */
  private async prunedSave(state: State): Promise<void> {
    const cutoff = Date.now() - GUARD_PRUNE_AFTER_MS;
    state.entries = state.entries.filter(
      (e) => !GUARD_FINAL_STATUSES.includes(e.status) || Date.parse(e.updated_at) >= cutoff,
    );
    await this.save(state);
  }

  /** Stores the entry, or returns the one already stored for its change id. */
  add(entry: Omit<GuardEntry, "updated_at">): Promise<GuardEntry> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.entries.find((e) => e.change_id === entry.change_id);
      if (existing) return existing;
      const stored = { ...structuredClone(entry), updated_at: new Date().toISOString() };
      state.entries.push(stored);
      await this.prunedSave(state);
      return stored;
    });
  }

  /**
   * Compare-and-set: replaces the stored entry with the same change id only while its stored
   * status is still `expected`, so a stale snapshot never reverts a final status. Returns whether
   * it wrote. The Owner Confirmation fields (written with `modify`) are kept as stored, and
   * `veto_at`, which a Reject brings forward, keeps the earlier of the two, so a stale snapshot
   * never undoes a confirmation or a Reject either.
   */
  update(entry: GuardEntry, expected: GuardStatus): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.entries.findIndex((e) => e.change_id === entry.change_id);
      const stored = state.entries[index];
      if (!stored || stored.status !== expected) return false;
      const kept = withDefaults(stored);
      state.entries[index] = {
        ...structuredClone(entry),
        confirmation: kept.confirmation,
        binding: kept.binding,
        confirmed_by_chat: kept.confirmed_by_chat,
        confirmed_at: kept.confirmed_at,
        request_chats: kept.request_chats,
        veto_at: BigInt(kept.veto_at) < BigInt(entry.veto_at) ? kept.veto_at : entry.veto_at,
        updated_at: new Date().toISOString(),
      };
      await this.prunedSave(state);
      return true;
    });
  }

  /**
   * Atomic read-modify-write of one entry: `change` gets the stored entry and returns the new one,
   * or null to leave it. Returns what was written, or null.
   */
  modify(
    changeId: U64,
    change: (entry: GuardEntry) => GuardEntry | null,
  ): Promise<GuardEntry | null> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.entries.findIndex((e) => e.change_id === changeId);
      const current = state.entries[index];
      if (!current) return null;
      const next = change(structuredClone(withDefaults(current)));
      if (!next) return null;
      const stored = { ...structuredClone(next), updated_at: new Date().toISOString() };
      state.entries[index] = stored;
      await this.prunedSave(state);
      return stored;
    });
  }

  async entries(): Promise<GuardEntry[]> {
    return (await this.load()).entries.map(withDefaults);
  }

  async entry(changeId: U64): Promise<GuardEntry | null> {
    const found = (await this.load()).entries.find((e) => e.change_id === changeId);
    return found ? withDefaults(found) : null;
  }
}

export class InMemoryGuardStore extends GuardStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

export interface FileGuardStoreOptions {
  log?: Logger;
  /**
   * Called after a corrupt file was moved aside: resets the guard cursor to 0 so the loop rebuilds
   * the schedule from the whole event history.
   */
  onCorrupt?: () => Promise<void>;
}

/** Local development store: one JSON file, replaced atomically on every write. */
export class FileGuardStore extends GuardStore {
  constructor(
    private readonly path: string,
    private readonly options: FileGuardStoreOptions = {},
  ) {
    super();
  }

  protected async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<State>;
      if (!Array.isArray(parsed.entries)) throw new Error("no entries array");
      return { ...empty(), ...parsed };
    } catch (error) {
      return this.quarantine(error);
    }
  }

  /**
   * Moves a corrupt file to `<file>.corrupt-<ts>`, resets the cursor and throws, so the caller
   * retries against an empty store and the event that was being handled is not committed.
   */
  private async quarantine(cause: unknown): Promise<never> {
    const aside = `${this.path}.corrupt-${Date.now()}`;
    try {
      await rename(this.path, aside);
    } catch (error) {
      // Another reader already moved it aside.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.options.log?.("error", "loosening guard: guard file corrupt; moved aside, rebuilding", {
      moved_to: aside,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await this.options.onCorrupt?.();
    throw new Error("guard file was corrupt; rebuilding the schedule from event 0");
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
