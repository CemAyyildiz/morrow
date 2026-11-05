import type { ContractClient, MorrowEvent } from "@morrow/core-ts";
import type { ChainClock } from "./clock.js";
import type { Logger } from "./log.js";
import type { WatcherStore } from "./store.js";

export interface HandlerContext {
  clock: ChainClock;
  log: Logger;
}

/** Handlers must finish their side effect before returning; a throw retries the event later. */
export interface EventHandler {
  /** Stable name, used for the persisted "handled" marks. */
  readonly name: string;
  handle(event: MorrowEvent, ctx: HandlerContext): Promise<void>;
}

export interface EventLoopOptions {
  client: ContractClient;
  store: WatcherStore;
  handlers: EventHandler[];
  clock: ChainClock;
  log: Logger;
  intervalMs?: number;
  batchSize?: number;
}

/** An error reduced to its code (contract errors) or class name, for health reports. */
export function failureSummary(error: unknown): { at: string; error: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const label =
    typeof code === "string" && code.startsWith("ERR_")
      ? code
      : error instanceof Error
        ? error.name
        : "Error";
  return { at: new Date().toISOString(), error: label };
}

export class EventLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  /** The last tick's failure (an error code or class, no event details), null after a clean tick. */
  lastError: { at: string; error: string } | null = null;

  constructor(private readonly options: EventLoopOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * Handles every event after the persisted cursor, in seq order. Stops at the first failure so a
   * later event is never handled before an earlier one. Returns the number of events committed.
   */
  async tick(): Promise<number> {
    const { client, store, handlers, clock, log } = this.options;
    let committed = 0;
    this.lastError = null;
    for (;;) {
      const { cursor } = await store.progress();
      const events = await client.eventsSince(cursor, this.batchSize);
      if (events.length === 0) return committed;
      for (const event of events) {
        for (const handler of handlers) {
          if (await store.isHandled(event.seq, handler.name)) continue;
          try {
            await handler.handle(event, { clock, log });
          } catch (error) {
            log("error", `handler ${handler.name} failed; will retry`, {
              seq: event.seq,
              vault_id: event.vault_id,
              kind: event.kind,
              error: error instanceof Error ? error.message : String(error),
            });
            this.lastError = failureSummary(error);
            return committed;
          }
          await store.markHandled(event.seq, handler.name);
        }
        await store.commit(event.seq, event.block_timestamp);
        committed++;
      }
      if (events.length < this.batchSize) return committed;
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
        this.options.log("error", "poll failed; will retry", {
          error: error instanceof Error ? error.message : String(error),
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
}
