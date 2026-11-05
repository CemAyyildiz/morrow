import type { GuardHealth, GuardHealthSource } from "../heartbeat.js";
import type { WatcherStore } from "../store.js";
import type { GuardStore } from "./store.js";

export interface GuardHealthParts {
  /** The guard loop's cursor store. */
  cursor: WatcherStore;
  store: GuardStore;
  /** The guard loop and the ticker, each with its last tick's failure. */
  loop: { lastError: GuardHealth["last_error"] };
  ticker: { lastError: GuardHealth["last_error"] };
}

/** The heartbeat's `guard` section. */
export function guardHealth(parts: GuardHealthParts): GuardHealthSource {
  return async (mainCursor) => {
    const { cursor } = await parts.cursor.progress();
    const lag = BigInt(mainCursor) - BigInt(cursor);
    const errors = [parts.loop.lastError, parts.ticker.lastError].filter((e) => e !== null);
    return {
      cursor,
      lag: (lag > 0n ? lag : 0n).toString(),
      scheduled: (await parts.store.entries()).filter((e) => e.status === "scheduled").length,
      last_error: errors.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null,
    };
  };
}
