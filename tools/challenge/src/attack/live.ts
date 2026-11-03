/**
 * Live ports for the scripted run against a real Challenge Vault: `/round` and `/attempts` over
 * HTTP, the NEAR JSON-RPC client, and a Bitcoin backend. Everything is public. The watcher is a
 * no-op here: the real challenge-mode watcher claws back on its own, and the run reads the
 * Clawback from `get_vault` and the feed.
 */
import { backendFromUrl, type AccountId } from "@morrow/core-ts";
import type { AttemptEntry } from "../attempts.js";
import type { AttackConfig } from "../config.js";
import type { PublicRound } from "../store.js";
import { nearPort, type NearPort } from "./near.js";
import {
  logViews,
  type AttackPorts,
  type AttemptsFeed,
  type BitcoinPort,
  type Clock,
  type RoundSource,
  type Watcher,
} from "./run.js";

const TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `GET {base}{path}` as JSON; any failure throws with the HTTP status and the server's error. */
async function getJson(fetchFn: typeof fetch, base: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`GET ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === "string" ? ` ${body.error}` : "";
    throw new Error(`GET ${path}: HTTP ${response.status}${detail}`);
  }
  return body;
}

/**
 * `GET {base}/round`. It throws on every non-200 (a 404 before the funding confirms included),
 * so the run can name the last error in `stopped_reason`. `contract()` is the Vault Contract
 * of the latest round served.
 */
export function fetchRoundSource(
  base: string,
  fetchFn: typeof fetch = fetch,
): { source: RoundSource; contract: () => AccountId } {
  let contract: AccountId = "";
  const source: RoundSource = {
    async current() {
      const body = await getJson(fetchFn, base, "/round");
      if (!isRecord(body) || typeof body.vault_contract !== "string") {
        throw new Error("GET /round: not a round");
      }
      contract = body.vault_contract;
      return body as unknown as PublicRound;
    },
  };
  return { source, contract: () => contract };
}

/** `GET {base}/attempts` as matching views; throws on failure (the run retries until its wait ends). */
export function fetchFeed(base: string, fetchFn: typeof fetch = fetch): AttemptsFeed {
  return {
    async entries() {
      const body = await getJson(fetchFn, base, "/attempts");
      if (!isRecord(body) || !Array.isArray(body.entries)) {
        throw new Error("GET /attempts: no entries");
      }
      return logViews(body.entries as AttemptEntry[]);
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

/** The real wall clock. */
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
