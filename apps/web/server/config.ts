// The deployment's public config: parsed once from whitelisted `MORROW_*` env vars, then used
// for both `/config.json` and the CSP `connect-src`, so the page can reach exactly the origins
// it is told about. Error messages name the variable, never its value.

export const NEAR_NETWORKS = ["mainnet", "testnet", "mock"] as const;
export const BTC_NETWORKS = ["bitcoin", "testnet", "signet", "regtest"] as const;

export type NearNetwork = (typeof NEAR_NETWORKS)[number];
export type BtcNetwork = (typeof BTC_NETWORKS)[number];

/** The body of `/config.json`. snake_case like every Morrow JSON. */
export interface PublicConfig {
  near_network: NearNetwork;
  vault_contract: string;
  near_rpc_url: string | null;
  btc_network: BtcNetwork;
  btc_backend_url: string;
  watcher_url: string | null;
}

/** NEAR RPC used when `MORROW_NEAR_RPC_URL` is unset (FastNEAR: the deprecated rpc.*.near.org endpoints rate-limit with 429). The mock contract has none. */
export const DEFAULT_NEAR_RPC: Record<NearNetwork, string | null> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
  mock: null,
};

/** Hosts where plain `http:` is allowed (local runs and the e2e stubs). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** NEAR account id rules (nomicon): 2 to 64 chars, lowercase parts joined by `.`, `-`, `_`. */
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string) {
    super(`${variable} ${reason}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(name, "is missing");
  return value;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[]): T {
  const value = required(env, name);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(name, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * An `https:` URL (or `http:` on localhost) without credentials, query or fragment.
 * Returned without a trailing `/` when the path is empty.
 */
export function parseServiceUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(name, "is not a valid URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError(name, "must use https (http only on localhost)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(name, "must not carry credentials");
  }
  // `new URL` drops an empty `?` or `#`, so check the raw text as well.
  if (url.search !== "" || value.includes("?"))
    throw new ConfigError(name, "must not carry a query");
  if (url.hash !== "" || value.includes("#"))
    throw new ConfigError(name, "must not carry a fragment");
  return url.pathname === "/" ? url.origin : url.href.replace(/\/+$/, "");
}

function optionalUrl(env: Env, name: string): string | null {
  const value = read(env, name);
  return value === undefined ? null : parseServiceUrl(name, value);
}

/** Parses and validates the whitelisted env vars; throws `ConfigError` on the first bad one. */
export function loadConfig(env: Env): PublicConfig {
  const near_network = oneOf(env, "MORROW_NEAR_NETWORK", NEAR_NETWORKS);
  const vault_contract = required(env, "MORROW_VAULT_CONTRACT");
  if (!NEAR_ACCOUNT_ID.test(vault_contract)) {
    throw new ConfigError("MORROW_VAULT_CONTRACT", "is not a valid NEAR account id");
  }
  const btc_network = oneOf(env, "MORROW_BTC_NETWORK", BTC_NETWORKS);
  const btc_backend_url = parseServiceUrl(
    "MORROW_BTC_BACKEND_URL",
    required(env, "MORROW_BTC_BACKEND_URL"),
  );
  const near_rpc_url = optionalUrl(env, "MORROW_NEAR_RPC_URL") ?? DEFAULT_NEAR_RPC[near_network];
  const watcher_url = optionalUrl(env, "MORROW_WATCHER_URL");
  return { near_network, vault_contract, near_rpc_url, btc_network, btc_backend_url, watcher_url };
}

/** `'self'` plus the origins of the NEAR RPC, the Bitcoin backend and the watcher. */
export function connectSources(config: PublicConfig): string[] {
  const origins = [config.near_rpc_url, config.btc_backend_url, config.watcher_url]
    .filter((url): url is string => url !== null)
    .map((url) => new URL(url).origin);
  return ["'self'", ...new Set(origins)];
}

export function contentSecurityPolicy(config: PublicConfig): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    `connect-src ${connectSources(config).join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The NFR-10 headers sent on every response. */
export function securityHeaders(config: PublicConfig): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(config),
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}
