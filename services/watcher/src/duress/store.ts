import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { U64 } from "@morrow/core-ts";
import type { Logger } from "../log.js";

/** What the duress handler knows about one guarded Vault. Never holds an envelope or a secret. */
export interface DuressVault {
  vault_id: U64;
  /** Every `withdrawal_requested` op id seen for the Vault, in event order. */
  ops: U64[];
  /** NEAR block time (ns) of the first duress-flagged Owner envelope; null until there is one. */
  first_duress_signal_at: U64 | null;
  updated_at: string;
}

interface State {
  vaults: Record<U64, DuressVault>;
}

const empty = (): State => ({ vaults: {} });

const blank = (vaultId: U64): Omit<DuressVault, "updated_at"> => ({
  vault_id: vaultId,
  ops: [],
  first_duress_signal_at: null,
});

/**
 * Duress handler state per guarded Vault. Writes are serialized per instance and each one is a
 * read-modify-write of the stored Vault inside the queue that only adds: an op id joins the set and
 * `first_duress_signal_at` keeps the earlier time. A stale caller can never undo a write.
 */
export abstract class DuressStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Applies `change` to the stored Vault (or a blank one) and saves it if it changed. */
  private change(
    vaultId: U64,
    change: (vault: Omit<DuressVault, "updated_at">) => boolean,
  ): Promise<DuressVault> {
    return this.exclusive(async () => {
      const state = await this.load();
      const stored = state.vaults[vaultId];
      const next = structuredClone(stored ?? { ...blank(vaultId), updated_at: "" });
      if (!change(next) && stored) return stored;
      const saved = { ...next, updated_at: new Date().toISOString() };
      state.vaults[vaultId] = saved;
      await this.save(state);
      return saved;
    });
  }

  /** Records a withdrawal op id of the Vault; recording it twice changes nothing. */
  recordOp(vaultId: U64, opId: U64): Promise<DuressVault> {
    return this.change(vaultId, (vault) => {
      if (vault.ops.includes(opId)) return false;
      vault.ops.push(opId);
      return true;
    });
  }

  /** Records a duress signal at `at` (ns); the Vault keeps its earliest one. */
  markDuress(vaultId: U64, at: U64): Promise<DuressVault> {
    return this.change(vaultId, (vault) => {
      const first = vault.first_duress_signal_at;
      if (first !== null && BigInt(first) <= BigInt(at)) return false;
      vault.first_duress_signal_at = at;
      return true;
    });
  }

  async vault(vaultId: U64): Promise<DuressVault | null> {
    return (await this.load()).vaults[vaultId] ?? null;
  }

  async vaults(): Promise<DuressVault[]> {
    return Object.values((await this.load()).vaults);
  }
}

export class InMemoryDuressStore extends DuressStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

export interface FileDuressStoreOptions {
  log?: Logger;
  /**
   * Called after a corrupt file was moved aside: resets the duress cursor to 0 so the loop rebuilds
   * the state from the whole event history.
   */
  onCorrupt?: () => Promise<void>;
}

/** Local development store: one JSON file, replaced atomically on every write. */
export class FileDuressStore extends DuressStore {
  constructor(
    private readonly path: string,
    private readonly options: FileDuressStoreOptions = {},
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
      const vaults = parsed.vaults;
      if (typeof vaults !== "object" || vaults === null || Array.isArray(vaults)) {
        throw new Error("no vaults object");
      }
      const u64 = (value: unknown) => typeof value === "string" && /^\d+$/.test(value);
      for (const [key, vault] of Object.entries(vaults)) {
        if (vault?.vault_id !== key) throw new Error("a vault's id differs from its key");
        if (!Array.isArray(vault.ops) || !vault.ops.every(u64)) {
          throw new Error("a vault's ops are not u64 strings");
        }
        const first = vault.first_duress_signal_at;
        if (first !== null && !u64(first)) {
          throw new Error("a vault's first_duress_signal_at is not null or a u64 string");
        }
      }
      return { vaults };
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
    this.options.log?.("error", "duress handler: state file corrupt; moved aside, rebuilding", {
      moved_to: aside,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await this.options.onCorrupt?.();
    throw new Error("duress state file was corrupt; rebuilding from event 0");
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
