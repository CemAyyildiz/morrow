import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { U64 } from "@morrow/core-ts";

/** The Watcher Envelope's flag; `unknown` when the guard cannot open it. */
export type GuardDuress = "normal" | "duress" | "unknown";

/**
 * scheduled → vetoed (the guard's veto landed) | settled (no longer pending at veto time, or the
 * window was missed). `skipped`: nothing to veto (tightening, not duress) or a Challenge Vault,
 * whose changes the challenge handler vetoes.
 */
export type GuardStatus = "scheduled" | "vetoed" | "settled" | "skipped";

export const GUARD_FINAL_STATUSES: readonly GuardStatus[] = ["vetoed", "settled", "skipped"];

/** One Policy Change on a guarded Vault. Never holds the envelope or any secret. */
export interface GuardEntry {
  change_id: U64;
  vault_id: U64;
  /** NEAR block time (ns) of the proposal. */
  proposed_at: U64;
  effective_at: U64;
  /** `effective_at − 65 min`: when the guard vetoes a change that is still pending. */
  veto_at: U64;
  loosening: boolean;
  /** `looseningReasons`, or why the entry was skipped. */
  reasons: string[];
  duress: GuardDuress;
  status: GuardStatus;
  /** The last failed veto, kept for the operator. */
  last_error: string | null;
  updated_at: string;
}

interface State {
  entries: GuardEntry[];
}

const empty = (): State => ({ entries: [] });

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

  /** Stores the entry, or returns the one already stored for its change id. */
  add(entry: Omit<GuardEntry, "updated_at">): Promise<GuardEntry> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.entries.find((e) => e.change_id === entry.change_id);
      if (existing) return existing;
      const stored = { ...structuredClone(entry), updated_at: new Date().toISOString() };
      state.entries.push(stored);
      await this.save(state);
      return stored;
    });
  }

  /** Replaces the stored entry with the same change id. */
  update(entry: GuardEntry): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.entries.findIndex((e) => e.change_id === entry.change_id);
      if (index < 0) throw new Error(`Unknown guard entry ${entry.change_id}`);
      state.entries[index] = { ...structuredClone(entry), updated_at: new Date().toISOString() };
      await this.save(state);
    });
  }

  async entries(): Promise<GuardEntry[]> {
    return (await this.load()).entries;
  }

  async entry(changeId: U64): Promise<GuardEntry | null> {
    return (await this.load()).entries.find((e) => e.change_id === changeId) ?? null;
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

/** Local development store: one JSON file, replaced atomically on every write. */
export class FileGuardStore extends GuardStore {
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
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
