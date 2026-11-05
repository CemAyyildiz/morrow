/** Guardian Watcher: event loop, Telegram alerts and Auto-Clawback. */
export const PACKAGE_NAME = "@morrow/watcher";

// The loosening guard, for running in another process (Judge Mode S-6). No Telegram here.
export { NearFinalBlockClock, type ChainClock } from "./clock.js";
export type { LogFields, LogLevel, Logger } from "./log.js";
export { EventLoop, type EventHandler, type EventLoopOptions } from "./loop.js";
export { InMemoryStore, type WatcherProgress, type WatcherStore } from "./store.js";
export { LooseningGuard, VETO_LEAD_NS, type LooseningGuardOptions } from "./guard/handler.js";
export {
  InMemoryGuardStore,
  type GuardEntry,
  type GuardStatus,
  type GuardStore,
} from "./guard/store.js";
export { GuardTicker, type GuardTickerOptions } from "./guard/ticker.js";
