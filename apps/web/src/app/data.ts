import { createContext, useContext } from "react";

export type BtcNetwork = "bitcoin" | "testnet" | "signet" | "regtest";
export type NearNetwork = "mainnet" | "testnet" | "mock";

export interface NetworkPair {
  btc: BtcNetwork;
  near: NearNetwork;
}

/**
 * `locked` only when the contract account has no full-access key; `checking` until the first
 * answer; `unknown` when the check failed or there is no RPC to ask.
 */
export type ContractState = "locked" | "unlocked" | "checking" | "unknown";

/** What the system card knows about the watcher's heartbeat. */
export type HeartbeatState =
  /** `MORROW_WATCHER_URL` is unset. */
  | { kind: "none" }
  /** The first poll has not answered yet. */
  | { kind: "checking" }
  /** The last poll failed or returned something that is not a heartbeat. */
  | { kind: "unreachable" }
  /** The watcher answers but has not recorded progress yet (`updated_at: null`). */
  | { kind: "silent" }
  /** Whole minutes between the heartbeat's `updated_at` and now; stale after 5. */
  | { kind: "seen"; minutes: number; stale: boolean };

/** Deployment facts the shell shows: the banner and the sidebar system card. */
export interface AppConfig {
  network: NetworkPair;
  /** The Morrow vault contract account. */
  contractId: string;
  /** NEAR JSON-RPC endpoint; null for the mock contract without one. */
  nearRpcUrl: string | null;
  btcBackendUrl: string;
  /** Watcher base URL; its heartbeat is `<watcherUrl>/heartbeat`. */
  watcherUrl: string | null;
  contract: ContractState;
  /** The NEAR account of the co-signer, e.g. `v1.signer`. */
  coSigner: string;
  heartbeat: HeartbeatState;
}

/** Values the Challenge screen shows. Times are absolute display strings. */
export interface ChallengeData {
  round: number;
  keysPublished: boolean;
  withdrawal: {
    /** Earliest execution time, e.g. `06:12`. */
    time: string;
    /** The day of `time`, e.g. `tomorrow`. */
    day: string;
    /** When the request was made, e.g. `yesterday, 06:12`. */
    requestedAt: string;
    /** Time left in the delay, e.g. `18 h 59 m`. */
    remaining: string;
    /** Share of the delay that has passed, 0 to 1. */
    elapsed: number;
  };
  attempts: {
    count: number;
    satsOut: number;
    /** Attempts per hour, oldest first: 24 entries. */
    hourly: readonly number[];
    lastAt: string;
  };
  vault: {
    amount: string;
    unit: string;
    delay: string;
  };
  satsTaken: number;
  coSigner: {
    threshold: number;
    total: number;
  };
}

export interface AppData {
  config: AppConfig;
  challenge: ChallengeData | null;
}

export const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const data = useContext(AppDataContext);
  if (!data) throw new Error("useAppData needs an app data provider");
  return data;
}
