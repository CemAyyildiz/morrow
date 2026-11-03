/**
 * Live ports for the scripted run against a real Challenge Vault: `/round` and `/attempts` over
 * HTTP, the NEAR JSON-RPC client, and a Bitcoin backend. Everything is public. The watcher is a
 * no-op here: the real challenge-mode watcher claws back on its own, and the run reads the
 * Clawback from the chain and the feed.
 */
import { backendFromUrl, type AccountId } from "@morrow/core-ts";
import type { AttackConfig } from "../config.js";
import type { AttemptEntry } from "../attempts.js";
import type { PublicRound } from "../store.js";
import { nearPort, type NearPort } from "./near.js";
import {
  logViews,
  type AttackPorts,
  type BitcoinPort,
  type Clock,
  type RoundSource,
  type Watcher,
} from "./run.js";
import type { ReportNetwork } from "./report.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `GET {base}/round`, returning the published round or null (404 before the funding confirms). */
export function fetchRoundSource(
  base: string,
  fetchFn: typeof fetch = fetch,
): {
  source: RoundSource;
  contract: () => AccountId;
} {
  let contract: AccountId = "";
  const source: RoundSource = {
    async current() {
      let response: Response;
      try {
        response = await fetchFn(`${base}/round`, { signal: AbortSignal.timeout(15_000) });
      } catch {
        return null;
      }
      if (response.status === 404) return null;
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      if (!isRecord(body) || typeof body.vault_contract !== "string") return null;
      contract = body.vault_contract;
      return body as unknown as PublicRound;
    },
  };
  return { source, contract: () => contract };
}

/** `GET {base}/attempts`, converted to matching views. */
export function fetchFeed(base: string, fetchFn: typeof fetch = fetch) {
  return {
    async entries() {
      const response = await fetchFn(`${base}/attempts`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return [];
      const body: unknown = await response.json().catch(() => null);
      const entries = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];
      return logViews(entries as AttemptEntry[]);
    },
  };
}

/** Adapts a core-ts `BitcoinBackend` to the run's `BitcoinPort`. */
export function bitcoinPort(url: string, fetchFn: typeof fetch = fetch): BitcoinPort {
  const backend = backendFromUrl(url, fetchFn);
  return {
    getUtxos: (address) => backend.getUtxos(address),
    getTipHeight: () => backend.getTipHeight(),
    broadcast: (rawHex) => backend.broadcast(rawHex),
  };
}

/** The real wall clock: `sleep` waits, `now` is `Date.now`. */
export function realClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Live: the watcher acts on its own, so the run drives nothing. */
export function noopWatcher(): Watcher {
  return { tick: async () => null };
}

/** The report network for a Bitcoin network. */
export function reportNetwork(btc: string): ReportNetwork {
  return btc === "regtest" || btc === "signet" || btc === "testnet4" || btc === "bitcoin"
    ? btc
    : "signet";
}

/** Builds every live port from the public configuration. */
export function liveAttackPorts(
  config: AttackConfig,
  fetchFn: typeof fetch = fetch,
): AttackPorts & { near: NearPort } {
  const { source, contract } = fetchRoundSource(config.challengeUrl, fetchFn);
  return {
    rounds: source,
    near: nearPort({ rpcUrl: config.rpcUrl, vaultContract: contract, fetchFn }),
    bitcoin: bitcoinPort(config.btcBackendUrl, fetchFn),
    feed: fetchFeed(config.challengeUrl, fetchFn),
    watcher: noopWatcher(),
    clock: realClock(),
  };
}
