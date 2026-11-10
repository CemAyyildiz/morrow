import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Hex, Outpoint, SpendOpKind, SpendSource, U64 } from "@morrow/core-ts";

/** What queued the job: the admin API, challenge mode (7.1) or a duress signal (8.2). */
export type ClawbackTrigger = "manual" | "challenge" | "duress";

/**
 * queued → running (planning, begin, signing) → broadcast | pinned → done | lost.
 * `failed` is for jobs that can never succeed (not a Guardian, unknown Vault).
 */
export type JobStatus = "queued" | "running" | "broadcast" | "pinned" | "done" | "lost" | "failed";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "lost", "failed"];

/** A transaction or op competing for the swept coins when the rate was chosen. */
export interface Conflict {
  /** Mempool spender txid, or null for a frozen/signed op not seen in the mempool. */
  txid: Hex | null;
  op_id: U64 | null;
  fee_rate_sat_vb: number;
  descendant_fees_sats: U64 | null;
}

/**
 * planned → begun (op exists) → signed (every input co-signed) → broadcast → confirmed;
 * skipped (the contract refused it), covered (another clawback op already holds every coin) and
 * lost (a conflict confirmed instead) are final.
 */
export type SweepState =
  "planned" | "begun" | "signed" | "broadcast" | "confirmed" | "skipped" | "covered" | "lost";

/** One Clawback op: up to 5 coins from one source address. */
export interface Sweep {
  source: SpendSource;
  utxos: Outpoint[];
  fee_rate_sat_vb: number;
  vsize: number;
  conflicts: Conflict[];
  pinned: boolean;
  op_id: U64 | null;
  txid: Hex | null;
  state: SweepState;
  last_error: string | null;
}

export interface ClawbackJob {
  job_id: string;
  vault_id: U64;
  trigger: ClawbackTrigger;
  /** NEAR block time (ns) from which the job may run. */
  due_at: U64;
  status: JobStatus;
  /** Null until planned; the plan (and so the fee rate) never changes afterwards. */
  sweeps: Sweep[] | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface IndexedOp {
  op_id: U64;
  kind: SpendOpKind;
}

interface State {
  next_job_id: number;
  jobs: ClawbackJob[];
  /** Every op_frozen op per Vault, from the event feed: the contract has no per-Vault op view. */
  frozen_ops: Record<U64, IndexedOp[]>;
}

const empty = (): State => ({ next_job_id: 1, jobs: [], frozen_ops: {} });

/** Clawback jobs and the per-Vault frozen-op index. Writes are serialized per instance. */
export abstract class JobStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Queues a job, or returns the Vault's unfinished job so a Vault never has two. */
  enqueue(vaultId: U64, trigger: ClawbackTrigger, dueAt: U64): Promise<ClawbackJob> {
    return this.exclusive(async () => {
      const state = await this.load();
      const open = state.jobs.find(
        (j) => j.vault_id === vaultId && !TERMINAL_JOB_STATUSES.includes(j.status),
      );
      if (open) return open;
      const now = new Date().toISOString();
      const job: ClawbackJob = {
        job_id: String(state.next_job_id++),
        vault_id: vaultId,
        trigger,
        due_at: dueAt,
        status: "queued",
        sweeps: null,
        created_at: now,
        updated_at: now,
        last_error: null,
      };
      state.jobs.push(job);
      await this.save(state);
      return job;
    });
  }

  /**
   * Moves the Vault's open job earlier, never later: `due_at` becomes `dueAt` only while the job is
   * still `queued` and `dueAt` is earlier than its `due_at`. Returns the open job as stored
   * afterwards, or null when the Vault has none.
   */
  advance(vaultId: U64, dueAt: U64): Promise<ClawbackJob | null> {
    return this.exclusive(async () => {
      const state = await this.load();
      const open = state.jobs.find(
        (j) => j.vault_id === vaultId && !TERMINAL_JOB_STATUSES.includes(j.status),
      );
      if (!open) return null;
      if (open.status !== "queued" || BigInt(dueAt) >= BigInt(open.due_at)) return open;
      open.due_at = dueAt;
      open.updated_at = new Date().toISOString();
      await this.save(state);
      return open;
    });
  }

  async jobs(): Promise<ClawbackJob[]> {
    return (await this.load()).jobs;
  }

  async job(jobId: string): Promise<ClawbackJob | null> {
    return (await this.load()).jobs.find((j) => j.job_id === jobId) ?? null;
  }

  /** Replaces the stored job with the same id. */
  update(job: ClawbackJob): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.jobs.findIndex((j) => j.job_id === job.job_id);
      if (index < 0) throw new Error(`Unknown clawback job ${job.job_id}`);
      state.jobs[index] = { ...structuredClone(job), updated_at: new Date().toISOString() };
      await this.save(state);
    });
  }

  recordFrozenOp(vaultId: U64, op: IndexedOp): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const ops = state.frozen_ops[vaultId] ?? [];
      if (ops.some((o) => o.op_id === op.op_id)) return;
      state.frozen_ops[vaultId] = [...ops, op];
      await this.save(state);
    });
  }

  async frozenOps(vaultId: U64): Promise<IndexedOp[]> {
    return (await this.load()).frozen_ops[vaultId] ?? [];
  }
}

export class InMemoryJobStore extends JobStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** Local development store: one JSON file, replaced atomically on every write. */
export class FileJobStore extends JobStore {
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
