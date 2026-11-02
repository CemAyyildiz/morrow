import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountId, BtcNetwork, Hex, U64 } from "@morrow/core-ts";

/** opening: some steps done, not yet funded; open: funded and published; closed: replaced. */
export type RoundStatus = "opening" | "open" | "closed";

/** The steps of `open`, in order. A failure names one of them. */
export type RoundStep = "account" | "vault" | "function_call_key" | "funding";

export type NearNetwork = "testnet" | "mainnet";

export interface RoundRecord {
  round: number;
  status: RoundStatus;
  vault_contract: AccountId;
  near_network: NearNetwork;
  btc_network: BtcNetwork;
  /** The step that failed while opening; null once open. */
  failed_step: RoundStep | null;
  last_error: string | null;
  owner_account: AccountId;
  /** Operator-only full-access key ("ed25519:…") of the Owner Account. Never published or logged. */
  owner_account_full_access_key: string;
  /** Published: 33-byte compressed Owner Key and its 32-byte secret (hex). */
  owner_key: Hex;
  owner_key_secret: Hex;
  /** Published: function-call key ("ed25519:…") scoped to the Vault Contract. */
  near_function_call_key: string;
  near_function_call_public_key: string;
  function_call_key_added: boolean;
  /**
   * A replacement function-call key, saved before it is added on chain so a crash never loses
   * it; swapped into `near_function_call_key` once added. Never published while pending.
   */
  next_function_call_key?: string | null;
  next_function_call_public_key?: string | null;
  /** Replaced published keys still to delete from the Owner Account. */
  retired_function_call_public_keys?: string[];
  /** Set once a retired round's published key is deleted; the round is no longer scanned. */
  published_key_deleted?: boolean;
  vault_id: U64 | null;
  vault_address: string | null;
  allowance_address: string | null;
  escape_timelock_blocks: number;
  fund_sats: U64;
  funding_txid: Hex | null;
  /** Block height of the funding transaction; null while unconfirmed. */
  funding_height: number | null;
  /** funding_height + 80% of the Escape Timelock; null (pending) until the funding confirms. */
  rotation_deadline_height: number | null;
  opened_at: string;
  updated_at: string;
}

/** What `GET /round` serves: everything an attacker needs, nothing the operator keeps. */
export interface PublicRound {
  round: number;
  vault_contract: AccountId;
  near_network: NearNetwork;
  btc_network: BtcNetwork;
  vault_id: U64 | null;
  owner_account: AccountId;
  owner_key: Hex;
  owner_key_secret: Hex;
  near_function_call_key: string;
  vault_address: string | null;
  escape_timelock_blocks: number;
  funding_txid: Hex | null;
  funding_height: number | null;
  rotation_deadline_height: number | null;
}

export function publicRound(round: RoundRecord): PublicRound {
  return {
    round: round.round,
    vault_contract: round.vault_contract,
    near_network: round.near_network,
    btc_network: round.btc_network,
    vault_id: round.vault_id,
    owner_account: round.owner_account,
    owner_key: round.owner_key,
    owner_key_secret: round.owner_key_secret,
    near_function_call_key: round.near_function_call_key,
    vault_address: round.vault_address,
    escape_timelock_blocks: round.escape_timelock_blocks,
    funding_txid: round.funding_txid,
    funding_height: round.funding_height,
    rotation_deadline_height: round.rotation_deadline_height,
  };
}

/** Rotate before the published Owner Key could use the Escape Path on the funding coin. */
export function rotationDeadline(fundingHeight: number, escapeTimelockBlocks: number): number {
  return fundingHeight + Math.floor((escapeTimelockBlocks * 4) / 5);
}

/** An old round's Vault the watcher must claw back (rotation): its keys are public. */
export interface PendingSweep {
  round: number;
  vault_id: U64;
  added_at: string;
}

/** A NEAR top-up the operator paid (storage or Owner Account balance), for the rate limits. */
export interface TopUp {
  /** `storage:<vault_id>` or `balance:<account_id>`. */
  target: string;
  /** Milliseconds since the Unix epoch. */
  at: number;
}

interface State {
  rounds: RoundRecord[];
  pending_sweeps: PendingSweep[];
  top_ups: TopUp[];
}

const empty = (): State => ({ rounds: [], pending_sweeps: [], top_ups: [] });

const TOP_UP_HISTORY_MS = 2 * 24 * 60 * 60_000;

/** Every round, oldest first. Writes are serialized per instance. */
export abstract class RoundStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async rounds(): Promise<RoundRecord[]> {
    return (await this.load()).rounds;
  }

  async latest(): Promise<RoundRecord | null> {
    return (await this.load()).rounds.at(-1) ?? null;
  }

  /** The round being served: the latest one that is open. */
  async current(): Promise<RoundRecord | null> {
    return (await this.load()).rounds.findLast((r) => r.status === "open") ?? null;
  }

  /**
   * Inserts or replaces the round with the same number. With `closeOthers`, every other round
   * that is not closed is closed in the same write.
   */
  put(round: RoundRecord, options: { closeOthers?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const now = new Date().toISOString();
      const stored = { ...structuredClone(round), updated_at: now };
      if (options.closeOthers) {
        for (const other of state.rounds) {
          if (other.round !== round.round && other.status !== "closed") {
            other.status = "closed";
            other.updated_at = now;
          }
        }
      }
      const index = state.rounds.findIndex((r) => r.round === round.round);
      if (index < 0) state.rounds.push(stored);
      else state.rounds[index] = stored;
      await this.save(state);
    });
  }

  /**
   * Re-reads the store and sets only the funding height and rotation deadline of round `number`,
   * if it is still open. Returns the updated round, or null when it is gone or no longer open.
   */
  patchFunding(
    number: number,
    fundingHeight: number,
    rotationDeadlineHeight: number,
  ): Promise<RoundRecord | null> {
    return this.exclusive(async () => {
      const state = await this.load();
      const round = state.rounds.find((r) => r.round === number);
      if (!round || round.status !== "open") return null;
      round.funding_height = fundingHeight;
      round.rotation_deadline_height = rotationDeadlineHeight;
      round.updated_at = new Date().toISOString();
      await this.save(state);
      return structuredClone(round);
    });
  }

  /**
   * Re-reads the store and sets only `fields` on round `number`, if it is still open. Returns
   * the updated round, or null when it is gone or no longer open.
   */
  patchOpen(number: number, fields: Partial<RoundRecord>): Promise<RoundRecord | null> {
    return this.patch(number, fields, ["open"]);
  }

  /** `patchOpen` for a round whose status is one of `statuses`. */
  patch(
    number: number,
    fields: Partial<RoundRecord>,
    statuses: RoundStatus[],
  ): Promise<RoundRecord | null> {
    return this.exclusive(async () => {
      const state = await this.load();
      const round = state.rounds.find((r) => r.round === number);
      if (!round || !statuses.includes(round.status)) return null;
      Object.assign(round, structuredClone(fields), {
        round: number,
        status: round.status,
        updated_at: new Date().toISOString(),
      });
      await this.save(state);
      return structuredClone(round);
    });
  }

  async pendingSweeps(): Promise<PendingSweep[]> {
    return (await this.load()).pending_sweeps;
  }

  /** Records a Vault to claw back; a Vault already listed is kept as is. */
  addPendingSweep(round: number, vaultId: U64): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (state.pending_sweeps.some((s) => s.vault_id === vaultId)) return;
      state.pending_sweeps.push({ round, vault_id: vaultId, added_at: new Date().toISOString() });
      await this.save(state);
    });
  }

  /** Top-ups of the last two days, oldest first. */
  async topUps(): Promise<TopUp[]> {
    return (await this.load()).top_ups;
  }

  addTopUp(target: string, at: number): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      state.top_ups = [
        ...state.top_ups.filter((t) => t.at > at - TOP_UP_HISTORY_MS),
        { target, at },
      ];
      await this.save(state);
    });
  }

  removePendingSweep(vaultId: U64): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const kept = state.pending_sweeps.filter((s) => s.vault_id !== vaultId);
      if (kept.length === state.pending_sweeps.length) return;
      state.pending_sweeps = kept;
      await this.save(state);
    });
  }
}

export class InMemoryRoundStore extends RoundStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** One JSON file holding operator secrets: owner-only mode, replaced atomically on every write. */
export class FileRoundStore extends RoundStore {
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

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Takes the single-writer lock `<stateFile>.lock` (created with O_EXCL, holding the pid) for
 * `run` and `open`. A lock whose pid is no longer alive is taken over. Throws when another live
 * process holds it. The lock is removed on `release()` and on process exit.
 */
export function acquireStateLock(stateFile: string): { path: string; release(): void } {
  const path = `${stateFile}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        process.off("exit", release);
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // Already gone.
        }
      };
      process.on("exit", release);
      return { path, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(path, "utf8").trim());
      } catch {
        // Removed in between: retry.
      }
      if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new Error(
          `STATE_LOCKED: ${path} is held by pid ${pid}; another run or open is active`,
          { cause: error },
        );
      }
      // Stale: its process is gone.
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it.
      }
    }
  }
  throw new Error(`STATE_LOCKED: could not take ${path}`);
}
