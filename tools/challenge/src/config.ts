import { dirname, join } from "node:path";
import type { Policy } from "@morrow/core-ts";

/** What `status` and `serve` need: no secrets. */
export interface BaseConfig {
  stateFile: string;
  /** The Attempt Log, next to the state file. */
  attemptsFile: string;
  btcBackendUrl: string;
  port: number;
}

/** What the round Policy and the funding need. The Recovery key is never logged. */
export interface PolicyConfig {
  guardianAccount: string;
  guardianKey: string;
  watcherX25519Pk: string;
  /** 32-byte secp256k1 secret (hex) of the signet Recovery Address. */
  recoveryKey: string;
  fundSats: bigint;
  feeRate: number;
  /** `MORROW_CHALLENGE_POLICY`: a partial Policy (JSON) merged over the default. */
  policyOverrides: Partial<Policy>;
}

/** What `open` needs on NEAR. The parent key is never logged. */
export interface NearConfig {
  nearNetwork: "testnet" | "mainnet";
  rpcUrl: string;
  vaultContract: string;
  ownerParent: string;
  /** Full-access key ("ed25519:…") of the parent account. */
  parentKey: string;
}

/** What `run` needs on top of `open`. The admin token is never logged. */
export interface RunConfig {
  /** `MORROW_WATCHER_URL`: the watcher's API, for `POST /clawbacks`. */
  watcherUrl: string;
  watcherAdminToken: string;
  /** Rotate this many blocks before the rotation deadline (default 144, about a day). */
  rotationMarginBlocks: number;
  /** `MORROW_FASTNEAR_TX_URL`; default: FastNEAR's transactions API for the NEAR network. */
  fastnearTxUrl: string | undefined;
  /** `MORROW_NEAR_ARCHIVAL_RPC_URL` for tx status; default: the NEAR RPC URL. */
  archivalRpcUrl: string | undefined;
}

/** Default rotation margin: 144 signet blocks, about a day. */ export const DEFAULT_ROTATION_MARGIN_BLOCKS = 144;
type Env = NodeJS.ProcessEnv;

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value;
}

export function loadRunConfig(env: Env = process.env): RunConfig {
  const optionalUrl = (name: string) => {
    const value = env[name];
    return value ? httpUrl(name, value) : undefined;
  };
  return {
    watcherUrl: httpUrl("MORROW_WATCHER_URL", required(env, "MORROW_WATCHER_URL")),
    watcherAdminToken: required(env, "MORROW_WATCHER_ADMIN_TOKEN"),
    rotationMarginBlocks: positiveInteger(
      env,
      "MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS",
      DEFAULT_ROTATION_MARGIN_BLOCKS,
    ),
    fastnearTxUrl: optionalUrl("MORROW_FASTNEAR_TX_URL"),
    archivalRpcUrl: optionalUrl("MORROW_NEAR_ARCHIVAL_RPC_URL"),
  };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const ACCOUNT_ID = /^[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/;

/** A NEAR account id (2-64 chars); `subAccount` also requires at least one ".". */
function accountId(env: Env, name: string, subAccount = false): string {
  const value = required(env, name);
  const valid =
    value.length >= 2 &&
    value.length <= 64 &&
    ACCOUNT_ID.test(value) &&
    (!subAccount || value.includes("."));
  if (!valid) {
    throw new Error(
      `${name} must be a NEAR ${subAccount ? "sub-account id (2-64 chars, at least one '.')" : "account id (2-64 chars)"}`,
    );
  }
  return value;
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number, at least 1`);
  }
  return value;
}

export function loadBaseConfig(env: Env = process.env): BaseConfig {
  const stateFile = env.MORROW_CHALLENGE_STATE_FILE ?? ".challenge-state/rounds.json";
  return {
    stateFile,
    attemptsFile: join(dirname(stateFile), "attempts.json"),
    btcBackendUrl: env.MORROW_BTC_BACKEND_URL ?? "https://mempool.space/signet/api",
    port: positiveInteger(env, "MORROW_CHALLENGE_PORT", 8081),
  };
}

export function loadPolicyConfig(env: Env = process.env): PolicyConfig {
  const guardianKey = required(env, "MORROW_CHALLENGE_GUARDIAN_KEY").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(guardianKey)) {
    throw new Error("MORROW_CHALLENGE_GUARDIAN_KEY must be a 33-byte compressed public key (hex)");
  }
  const watcherX25519Pk = required(env, "MORROW_CHALLENGE_WATCHER_X25519_PK").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(watcherX25519Pk)) {
    throw new Error("MORROW_CHALLENGE_WATCHER_X25519_PK must be a 32-byte key (hex)");
  }
  const recoveryKey = required(env, "MORROW_CHALLENGE_RECOVERY_KEY").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recoveryKey)) {
    throw new Error("MORROW_CHALLENGE_RECOVERY_KEY must be a 32-byte secret key (hex)");
  }
  let policyOverrides: Partial<Policy> = {};
  if (env.MORROW_CHALLENGE_POLICY) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.MORROW_CHALLENGE_POLICY);
    } catch (error) {
      throw new Error(
        `MORROW_CHALLENGE_POLICY is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MORROW_CHALLENGE_POLICY must be a JSON object of Policy fields");
    }
    policyOverrides = parsed as Partial<Policy>;
  }
  return {
    guardianAccount: accountId(env, "MORROW_CHALLENGE_GUARDIAN_ACCOUNT"),
    guardianKey,
    watcherX25519Pk,
    recoveryKey,
    fundSats: BigInt(positiveInteger(env, "MORROW_CHALLENGE_FUND_SATS", 100_000)),
    feeRate: positiveInteger(env, "MORROW_CHALLENGE_FEE_RATE", 2),
    policyOverrides,
  };
}

export function loadNearConfig(env: Env = process.env): NearConfig {
  const nearNetwork = env.MORROW_NEAR_NETWORK ?? "testnet";
  if (nearNetwork !== "testnet" && nearNetwork !== "mainnet") {
    throw new Error("MORROW_NEAR_NETWORK must be testnet or mainnet");
  }
  return {
    nearNetwork,
    rpcUrl: env.MORROW_NEAR_RPC_URL ?? `https://rpc.${nearNetwork}.near.org`,
    vaultContract: accountId(env, "MORROW_VAULT_CONTRACT"),
    ownerParent: accountId(env, "MORROW_CHALLENGE_OWNER_PARENT", true),
    parentKey: required(env, "MORROW_CHALLENGE_PARENT_KEY"),
  };
}
