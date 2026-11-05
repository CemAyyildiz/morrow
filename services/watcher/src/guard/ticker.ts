import {
  MorrowContractError,
  type ContractClient,
  type ErrorCode,
  type PolicyChangeState,
} from "@morrow/core-ts";
import type { ChainClock } from "../clock.js";
import type { Logger } from "../log.js";
import { failureSummary } from "../loop.js";
import type { GuardEntry, GuardStore } from "./store.js";

export interface GuardTickerOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** Client signed by the Guardian account, for `veto_policy_change`. */
  signer: ContractClient;
  store: GuardStore;
  /** The guard's Guardian account: a veto by it whose result was lost still counts as vetoed. */
  guardianAccount: string;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  log: Logger;
  intervalMs?: number;
  /** Per-call limit for the read and the veto; default 3 × `intervalMs`. */
  callTimeoutMs?: number;
}

/** The change was settled by someone else between the read and the veto. */
const SETTLED_CODES: ReadonlySet<ErrorCode> = new Set([
  "ERR_BAD_OP_STATE",
  "ERR_CHANGE_NOT_FOUND",
  "ERR_CLAWED_BACK",
  "ERR_VAULT_NOT_ACTIVE",
]);

/** Why a change stopped being pending without the guard's veto. */
type Settlement = Exclude<PolicyChangeState, "pending"> | "clawback" | "not_found" | ErrorCode;

export class GuardTimeoutError extends Error {
  override readonly name = "GuardTimeoutError";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Rejects with `GuardTimeoutError` when `work` takes longer than `ms`. */
async function within<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GuardTimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the loosening guard's vetoes: each scheduled entry from `veto_at` on, for as long as the
 * change is pending. The contract accepts a veto until someone applies the change, so a watcher
 * that is late past `effective_at` still vetoes. A failed or timed-out read or veto is retried on
 * the next tick; an entry is final only once the change is no longer pending.
 */
export class GuardTicker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly callTimeoutMs: number;
  /** The last tick's failure (an error code or class, no change details), null after a clean tick. */
  lastError: { at: string; error: string } | null = null;

  constructor(private readonly options: GuardTickerOptions) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 3 * this.intervalMs;
  }

  /** Advances every scheduled entry that is due. */
  async tick(): Promise<void> {
    this.lastError = null;
    const now = await this.options.clock.now();
    for (const entry of await this.options.store.entries()) {
      if (entry.status !== "scheduled" || now < BigInt(entry.veto_at)) continue;
      await this.advance(entry);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.lastError = failureSummary(error);
        this.options.log("error", "loosening guard tick failed; will retry", {
          error: message(error),
        });
      }
      if (this.running) this.timer = setTimeout(run, this.intervalMs);
    };
    void run();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The change's state (`vetoed_by_us` for a veto by the guard's Guardian outside a Clawback),
   * `not_found`, or null after a retryable failure (already logged).
   */
  private async read(entry: GuardEntry): Promise<Settlement | "pending" | "vetoed_by_us" | null> {
    try {
      const change = await within(this.callTimeoutMs, "get_policy_change", () =>
        this.options.reader.getPolicyChange(entry.change_id),
      );
      if (change.state !== "vetoed" || change.vetoed_by !== this.options.guardianAccount) {
        return change.state;
      }
      const vault = await within(this.callTimeoutMs, "get_vault", () =>
        this.options.reader.getVault(entry.vault_id),
      );
      return vault.state === "clawed_back" ? "clawback" : "vetoed_by_us";
    } catch (error) {
      if (error instanceof MorrowContractError && error.code === "ERR_CHANGE_NOT_FOUND") {
        return "not_found";
      }
      await this.failed(entry, error, "loosening guard: change read failed; will retry");
      return null;
    }
  }

  private async advance(entry: GuardEntry): Promise<void> {
    const state = await this.read(entry);
    if (state === null) return;
    if (state === "vetoed_by_us") return this.vetoed(entry);
    if (state !== "pending") return this.settle(entry, state);
    try {
      await within(this.callTimeoutMs, "veto_policy_change", () =>
        this.options.signer.vetoPolicyChange(entry.change_id),
      );
    } catch (error) {
      if (error instanceof MorrowContractError && SETTLED_CODES.has(error.code)) {
        // Lost a race: read again to tell an apply from a veto or withdrawal.
        const after = await this.read(entry);
        if (after === null) return;
        if (after === "vetoed_by_us") return this.vetoed(entry);
        // A read that still says pending (a lagging RPC node): the refusal itself settles it.
        return this.settle(entry, after === "pending" ? error.code : after);
      }
      return this.failed(entry, error, "loosening guard: veto failed; will retry while pending");
    }
    return this.vetoed(entry);
  }

  private async vetoed(entry: GuardEntry): Promise<void> {
    const stored = await this.options.store.update(
      { ...entry, status: "vetoed", cause: null, last_error: null },
      "scheduled",
    );
    if (stored) {
      this.options.log("info", "loosening guard: policy change vetoed", {
        vault_id: entry.vault_id,
        change_id: entry.change_id,
      });
    }
  }

  /** The change is no longer pending and the guard did not veto it. */
  private async settle(entry: GuardEntry, state: Settlement): Promise<void> {
    const stored = await this.options.store.update(
      { ...entry, status: "settled", cause: state },
      "scheduled",
    );
    if (!stored) return;
    const fields = { vault_id: entry.vault_id, change_id: entry.change_id, change_state: state };
    if (state === "applied") {
      this.options.log("error", "loosening guard: loosening change applied without a veto", fields);
    } else {
      this.options.log("info", "loosening guard: change already settled; no veto sent", fields);
    }
  }

  private async failed(entry: GuardEntry, error: unknown, msg: string): Promise<void> {
    this.lastError = failureSummary(error);
    await this.options.store.update({ ...entry, last_error: message(error) }, "scheduled");
    this.options.log("error", msg, {
      vault_id: entry.vault_id,
      change_id: entry.change_id,
      error: message(error),
    });
  }
}
