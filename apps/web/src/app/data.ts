import { createContext, useContext } from "react";

export type BtcNetwork = "bitcoin" | "testnet" | "signet" | "regtest";
export type NearNetwork = "mainnet" | "testnet" | "mock";

export interface NetworkPair {
  btc: BtcNetwork;
  near: NearNetwork;
}

/** Deployment facts the shell shows: the banner and the sidebar system card. */
export interface AppConfig {
  network: NetworkPair;
  contract: "locked" | "unlocked";
  /** The NEAR account of the co-signer, e.g. `v1.signer`. */
  coSigner: string;
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
