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
  /** `tools/challenge run` base URL: `GET /round` and `GET /attempts`. */
  challengeUrl: string | null;
  /** The Mainnet Bounty page; a link only, set once the bounty is open. */
  bountyUrl: string | null;
  contract: ContractState;
  /** The NEAR account of the co-signer, e.g. `v1.signer`. */
  coSigner: string;
  heartbeat: HeartbeatState;
}

/** The published round as `GET /round` serves it (7.1a `publicRound`): the downloadable keys. */
export interface ChallengeKeys {
  round: number;
  vault_contract: string;
  near_network: string;
  btc_network: string;
  vault_id: string | null;
  owner_account: string;
  owner_key: string;
  owner_key_secret: string;
  near_function_call_key: string;
  vault_address: string | null;
  escape_timelock_blocks: number;
  funding_txid: string | null;
  funding_height: number | null;
  rotation_deadline_height: number | null;
}

/** One link of an Attempt Log row. */
export interface RowLink {
  href: string;
  /** Visible text, e.g. `NEAR`. */
  text: string;
  /** Accessible name, e.g. `NEAR transaction of attempt 3`. */
  label: string;
}

/** One Attempt Log row, newest first. */
export interface AttemptRow {
  /** Unique across rounds, e.g. `7-3`; defaults to `n`. */
  key?: string;
  /** The attempt number in its round. */
  n: number;
  /** Absolute time of the attempt: `03:11` today, otherwise with the date. */
  at: string;
  /** What was tried, e.g. `Withdrawal Request`. */
  action: string;
  /** Set when the row belongs to an earlier round than the one shown. */
  round?: number;
  outcome: { tone: "ok" | "alarm" | "neutral"; text: string };
  links?: { near: RowLink | null; bitcoin: RowLink | null };
  /** Set on a row that just arrived: it flashes once. */
  fresh?: boolean;
}

/**
 * Values the Challenge screen shows. Times are absolute display strings. A part that is null
 * has not answered yet and shows a skeleton.
 */
export interface ChallengeData {
  round: number;
  keysPublished: boolean;
  withdrawal: {
    /** Earliest execution time, e.g. `06:12`. */
    time: string;
    /** The date of `time` when it is not today, e.g. `13 Nov`; empty today. */
    day: string;
    /** When the pending request was made, e.g. `12 Nov 06:12`; null when none is pending. */
    requestedAt: string | null;
    /** Time left in the delay, e.g. `18 h 59 m`; the whole Delay when none is pending. */
    remaining: string;
    /** Share of the delay that has passed, 0 to 1. */
    elapsed: number;
  } | null;
  attempts: {
    /** Attempts in this round. */
    count: number;
    /** Attempts in every round so far (the landing's record line). */
    total: number;
    satsOut: number;
    /** Attempts per hour, oldest first: 24 entries. */
    hourly: readonly number[];
    /** Null before the first attempt. */
    lastAt: string | null;
  } | null;
  vault: {
    /** Null until the Bitcoin backend answers. */
    amount: string | null;
    unit: string;
    /** Null until the Vault's Delay is read. */
    delay: string | null;
  };
  satsTaken: number | null;
  /** `unreadable` when the signer contract's threshold could not be read: the stat hides. */
  coSigner: { threshold: number; total: number } | null | "unreadable";
  /** The rotation deadline; `at` is approximate (10 min per block) and null without a tip. */
  rotation: { height: number; at: string | null } | null;
  /** The coins note, e.g. `Signet test coins · not real bitcoin`. */
  coins: string;
  bountyUrl: string | null;
  /** The published round, for "Download keys"; null on the illustration. */
  keys: ChallengeKeys | null;
  /** Null until `/attempts` answers; the landing illustration keeps its own rows. */
  log: readonly AttemptRow[] | null;
  /** The earliest pending Withdrawal Request of the round, if any. */
  pending: { n: number; executableAt: string } | null;
}

/**
 * Where the challenge feed stands: `none` without `MORROW_CHALLENGE_URL` or after a 404,
 * `loading` before `/round` first answers, `unreachable` when it fails before any round was
 * shown, `round` once one is (it stays on a later failure).
 */
export type ChallengeStatus = "loading" | "none" | "unreachable" | "round";

export interface AppData {
  config: AppConfig;
  challenge: ChallengeData | null;
  challengeStatus: ChallengeStatus;
}

export const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const data = useContext(AppDataContext);
  if (!data) throw new Error("useAppData needs an app data provider");
  return data;
}
