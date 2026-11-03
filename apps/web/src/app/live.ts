// Live deployment data for the shell: `/config.json`, the contract's lock state over NEAR
// JSON-RPC and the watcher heartbeat, plus the polling helper the challenge feed shares.
// Plain `fetch`, no NEAR SDK, so the bundle stays small and pulls in no Node-only modules.
// Every request goes to an origin the CSP allows.
import type { AppConfig, BtcNetwork, ContractState, HeartbeatState, NearNetwork } from "./data";

const NEAR_NETWORKS: readonly NearNetwork[] = ["mainnet", "testnet", "mock"];
const BTC_NETWORKS: readonly BtcNetwork[] = ["bitcoin", "testnet", "signet", "regtest"];

/** How often the system card re-checks the contract and asks the watcher for its heartbeat. */
export const HEARTBEAT_POLL_MS = 30_000;
/** A request that has not answered by then counts as failed. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** A heartbeat older than this turns the Alerts line to alarm. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** The MPC signer account each NEAR network's contract signs with. */
export const CO_SIGNERS: Record<NearNetwork, string> = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
  mock: "mock-signer",
};

/** The config facts before any live check has answered. */
export type BaseConfig = Omit<AppConfig, "contract" | "heartbeat">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `URL.canParse` without needing it: Safari before 17 lacks it. */
function isUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const isUrlOrNull = (value: unknown): value is string | null => value === null || isUrl(value);

/** Only `http:` and `https:` links are followed (a `javascript:` URL parses too). */
function isWebUrl(value: unknown): value is string {
  return isUrl(value) && /^https?:$/.test(new URL(value).protocol);
}

/** Reads the `/config.json` body; null when it does not have the shape the server writes. */
export function parseConfig(body: unknown): BaseConfig | null {
  if (!isRecord(body)) return null;
  const { near_network, vault_contract, near_rpc_url, btc_network, btc_backend_url, watcher_url } =
    body;
  // Older servers did not write the challenge feed or the bounty link: missing reads as unset.
  const challenge_url = body.challenge_url ?? null;
  const bounty_url = body.bounty_url ?? null;
  if (!NEAR_NETWORKS.includes(near_network as NearNetwork)) return null;
  if (!BTC_NETWORKS.includes(btc_network as BtcNetwork)) return null;
  if (typeof vault_contract !== "string" || vault_contract === "") return null;
  if (!isUrl(btc_backend_url)) return null;
  if (!isUrlOrNull(near_rpc_url) || !isUrlOrNull(watcher_url)) return null;
  if (!isUrlOrNull(challenge_url)) return null;
  if (bounty_url !== null && !isWebUrl(bounty_url)) return null;
  const near = near_network as NearNetwork;
  return {
    network: { btc: btc_network as BtcNetwork, near },
    contractId: vault_contract,
    nearRpcUrl: near_rpc_url,
    btcBackendUrl: btc_backend_url,
    watcherUrl: watcher_url,
    challengeUrl: challenge_url,
    bountyUrl: bounty_url,
    coSigner: CO_SIGNERS[near],
  };
}

/**
 * Runs `check` now and every `intervalMs`, handing each answer to `apply`. A tick is skipped
 * while the previous check is still pending (each request times out after 10 s), so checks
 * never stack and an older answer never overwrites a newer one. Returns the cleanup, which
 * aborts the request in flight.
 */
export function poll<T>(
  check: (signal: AbortSignal) => Promise<T>,
  apply: (value: T) => void,
  intervalMs = HEARTBEAT_POLL_MS,
): () => void {
  const abort = new AbortController();
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void check(abort.signal).then((value) => {
      inFlight = false;
      if (!abort.signal.aborted) apply(value);
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
    abort.abort();
  };
}

/**
 * Lock state from a `view_access_key_list` JSON-RPC response: `locked` only when the list
 * holds no full-access key; anything that is not a key list is `unknown`.
 */
export function contractStateFrom(response: unknown): ContractState {
  if (!isRecord(response) || response.error !== undefined || !isRecord(response.result)) {
    return "unknown";
  }
  const keys = response.result.keys;
  if (!Array.isArray(keys)) return "unknown";
  for (const key of keys) {
    if (!isRecord(key) || !isRecord(key.access_key)) return "unknown";
    const permission = key.access_key.permission;
    if (permission === "FullAccess") return "unlocked";
    if (!isRecord(permission) || !isRecord(permission.FunctionCall)) return "unknown";
  }
  return "locked";
}

/** Heartbeat state from a `/heartbeat` body `{ last_seq, last_block_timestamp, updated_at }`. */
export function heartbeatFrom(body: unknown, now: number): HeartbeatState {
  if (!isRecord(body) || typeof body.last_seq !== "string") return { kind: "unreachable" };
  if (body.updated_at === null) return { kind: "silent" };
  if (typeof body.updated_at !== "string") return { kind: "unreachable" };
  const updated = Date.parse(body.updated_at);
  if (Number.isNaN(updated)) return { kind: "unreachable" };
  // A watcher clock slightly ahead of ours reads as "0 min".
  const age = Math.max(0, now - updated);
  return { kind: "seen", minutes: Math.floor(age / 60_000), stale: age > HEARTBEAT_STALE_MS };
}

/** `<watcherUrl>/heartbeat`, keeping any base path. */
export function heartbeatUrl(watcherUrl: string): string {
  return `${watcherUrl.replace(/\/+$/, "")}/heartbeat`;
}

/**
 * The caller's signal, also aborted after `REQUEST_TIMEOUT_MS`. Combined by hand rather than
 * with `AbortSignal.any` / `AbortSignal.timeout`, which need Safari 17.4 / 16.
 */
export function withTimeout(signal: AbortSignal, ms = REQUEST_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return controller.signal;
  }
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
    { once: true },
  );
  return controller.signal;
}

export async function fetchConfig(signal: AbortSignal): Promise<BaseConfig | null> {
  try {
    const response = await fetch("/config.json", {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    if (!response.ok) return null;
    return parseConfig(await response.json());
  } catch {
    return null;
  }
}

export async function fetchContractState(
  rpcUrl: string,
  contractId: string,
  signal: AbortSignal,
): Promise<ContractState> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "morrow-web",
        method: "query",
        params: { request_type: "view_access_key_list", finality: "final", account_id: contractId },
      }),
      signal: withTimeout(signal),
    });
    if (!response.ok) return "unknown";
    return contractStateFrom(await response.json());
  } catch {
    return "unknown";
  }
}

export async function fetchHeartbeat(
  watcherUrl: string,
  signal: AbortSignal,
): Promise<HeartbeatState> {
  try {
    const response = await fetch(heartbeatUrl(watcherUrl), {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    if (!response.ok) return { kind: "unreachable" };
    return heartbeatFrom(await response.json(), Date.now());
  } catch {
    return { kind: "unreachable" };
  }
}
