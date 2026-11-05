import { MorrowContractError, type ContractClient, type ErrorCode } from "@morrow/core-ts";
import type { ChainClock } from "../clock.js";
import type { Logger } from "../log.js";
import type { GuardEntry, GuardStore } from "./store.js";

export interface GuardTickerOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** Client signed by the Guardian account, for `veto_policy_change`. */
  signer: ContractClient;
  store: GuardStore;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  log: Logger;
  intervalMs?: number;
}

/** The change was settled by someone else between the read and the veto. */
const SETTLED_CODES: ReadonlySet<ErrorCode> = new Set([
  "ERR_BAD_OP_STATE",
  "ERR_CHANGE_NOT_FOUND",
  "ERR_CLAWED_BACK",
  "ERR_VAULT_NOT_ACTIVE",
]);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sends the loosening guard's vetoes: each scheduled entry once `now ≥ veto_at`, while the change
 * is still pending and `now < effective_at`. A failed veto is retried on the next tick; a change
 * no longer pending is settled with no call; the guard never vetoes after `effective_at`.
 */
export class GuardTicker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly options: GuardTickerOptions) {
    this.intervalMs = options.intervalMs ?? 10_000;
  }

  /** Advances every scheduled entry that is due. */
  async tick(): Promise<void> {
    const now = await this.options.clock.now();
    for (const entry of await this.options.store.entries()) {
      if (entry.status !== "scheduled" || now < BigInt(entry.veto_at)) continue;
      await this.advance(entry, now);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = async () => {
      try {
        await this.tick();
      } catch (error) {
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

  private async advance(entry: GuardEntry, now: bigint): Promise<void> {
    const { reader, signer, store, log } = this.options;
    const fields = { vault_id: entry.vault_id, change_id: entry.change_id };
    let state: string;
    try {
      state = (await reader.getPolicyChange(entry.change_id)).state;
    } catch (error) {
      if (error instanceof MorrowContractError && error.code === "ERR_CHANGE_NOT_FOUND") {
        state = "not_found";
      } else {
        log("warn", "loosening guard: change read failed; will retry", {
          ...fields,
          error: message(error),
        });
        return;
      }
    }
    if (state !== "pending") {
      entry.status = "settled";
      await store.update(entry);
      log("info", "loosening guard: change already settled; no veto sent", {
        ...fields,
        change_state: state,
      });
      return;
    }
    if (now >= BigInt(entry.effective_at)) {
      entry.status = "settled";
      await store.update(entry);
      log("error", "loosening guard: veto window missed; the change is past effective_at", {
        ...fields,
        effective_at: entry.effective_at,
      });
      return;
    }
    try {
      await signer.vetoPolicyChange(entry.change_id);
    } catch (error) {
      if (error instanceof MorrowContractError && SETTLED_CODES.has(error.code)) {
        entry.status = "settled";
        await store.update(entry);
        log("info", "loosening guard: change settled during the veto", {
          ...fields,
          code: error.code,
        });
        return;
      }
      entry.last_error = message(error);
      await store.update(entry);
      log("error", "loosening guard: veto failed; will retry until effective_at", {
        ...fields,
        effective_at: entry.effective_at,
        error: entry.last_error,
      });
      return;
    }
    entry.status = "vetoed";
    entry.last_error = null;
    await store.update(entry);
    log("info", "loosening guard: policy change vetoed", { ...fields, reasons: entry.reasons });
  }
}
