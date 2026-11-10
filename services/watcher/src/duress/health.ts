import type { DuressHealth, DuressHealthSource } from "../heartbeat.js";
import type { WatcherStore } from "../store.js";

export interface DuressHealthParts {
  /** The duress loop's cursor store. */
  cursor: WatcherStore;
  /** The duress loop, with its last tick's failure. */
  loop: { lastError: DuressHealth["last_error"] };
}

/** The heartbeat's `duress` section: loop progress only, nothing about any Vault. */
export function duressHealth(parts: DuressHealthParts): DuressHealthSource {
  return async (mainCursor) => {
    const { cursor } = await parts.cursor.progress();
    const lag = BigInt(mainCursor) - BigInt(cursor);
    return {
      cursor,
      lag: (lag > 0n ? lag : 0n).toString(),
      last_error: parts.loop.lastError,
    };
  };
}
