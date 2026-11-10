export interface WatcherConfig {
  nearNetwork: "mock" | "testnet" | "mainnet";
  nearRpcUrl: string | null;
  vaultContract: string;
  btcBackendUrl: string;
  port: number;
  pollIntervalMs: number;
  stateFile: string;
  linksFile: string;
  /** Fixed app domain for alert buttons; alerts carry no links without it. */
  appUrl: string | null;
  telegramToken: string | null;
  jobsFile: string;
  /** Auto-Clawback Guardian material; Auto-Clawback is off without it. Never log it. */
  guardian: GuardianConfig | null;
  /** Clawback rate when nothing competes for the coins. */
  clawbackFeeRate: number;
  /** Bearer token for `POST /clawbacks`; the endpoint is off without it. */
  adminToken: string | null;
  /**
   * Challenge mode: Vaults whose Owner Account is a sub-account of this account are clawed back
   * on every Withdrawal Request and have every Policy Change vetoed. Off when null.
   */
  challengeOwnerParent: string | null;
  /**
   * `MORROW_WATCHER_X25519_SK`: 32-byte X25519 secret (hex) the Watcher Envelopes are sealed to,
   * so the loosening guard can read the duress flag. Never log it. Without it the flag is unknown.
   */
  watcherEnvelopeSecretKey: string | null;
}

export interface GuardianConfig {
  accountId: string;
  /** NEAR function-call key ("ed25519:…") of the Guardian account. */
  nearKey: string;
  /** 32-byte secp256k1 secret (hex) behind the Vault's guardian_key. */
  btcKey: string;
}

const GUARDIAN_ENV = [
  "MORROW_GUARDIAN_ACCOUNT",
  "MORROW_GUARDIAN_NEAR_KEY",
  "MORROW_GUARDIAN_BTC_KEY",
] as const;

function loadGuardian(env: NodeJS.ProcessEnv): GuardianConfig | null {
  const [accountId, nearKey, btcKey] = GUARDIAN_ENV.map((name) => env[name]);
  if (!accountId && !nearKey && !btcKey) return null;
  if (!accountId || !nearKey || !btcKey) {
    throw new Error(`Auto-Clawback needs all of ${GUARDIAN_ENV.join(", ")}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(btcKey)) {
    throw new Error("MORROW_GUARDIAN_BTC_KEY must be a 32-byte hex secret key");
  }
  return { accountId, nearKey, btcKey: btcKey.toLowerCase() };
}

const NEAR_RPC: Record<"testnet" | "mainnet", string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const nearNetwork = required(env, "MORROW_NEAR_NETWORK");
  if (nearNetwork !== "mock" && nearNetwork !== "testnet" && nearNetwork !== "mainnet") {
    throw new Error("MORROW_NEAR_NETWORK must be mock, testnet or mainnet");
  }
  const appUrl = env.MORROW_APP_URL ?? null;
  if (appUrl !== null && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(appUrl)) {
    throw new Error("MORROW_APP_URL must be an https origin, e.g. https://app.example");
  }
  const clawbackFeeRate = Number(env.MORROW_CLAWBACK_FEE_RATE ?? 2);
  if (!Number.isInteger(clawbackFeeRate) || clawbackFeeRate < 1) {
    throw new Error("MORROW_CLAWBACK_FEE_RATE must be a whole number of sat/vB, at least 1");
  }
  const guardian = loadGuardian(env);
  const challengeOwnerParent = env.MORROW_CHALLENGE_OWNER_PARENT || null;
  if (challengeOwnerParent !== null) {
    // A top-level account ("testnet") would put every user's Vault into challenge mode.
    if (
      challengeOwnerParent.length < 2 ||
      challengeOwnerParent.length > 64 ||
      !/^[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)+$/.test(challengeOwnerParent)
    ) {
      throw new Error(
        "MORROW_CHALLENGE_OWNER_PARENT must be a NEAR sub-account id (2-64 chars, at least one '.')",
      );
    }
    if (!guardian) {
      throw new Error(
        `MORROW_CHALLENGE_OWNER_PARENT needs the Auto-Clawback Guardian (${GUARDIAN_ENV.join(", ")})`,
      );
    }
  }
  const watcherEnvelopeSecretKey = env.MORROW_WATCHER_X25519_SK || null;
  if (watcherEnvelopeSecretKey !== null && !/^[0-9a-f]{64}$/i.test(watcherEnvelopeSecretKey)) {
    throw new Error("MORROW_WATCHER_X25519_SK must be a 32-byte hex secret key");
  }
  return {
    nearNetwork,
    nearRpcUrl: nearNetwork === "mock" ? null : (env.MORROW_NEAR_RPC_URL ?? NEAR_RPC[nearNetwork]),
    vaultContract: required(env, "MORROW_VAULT_CONTRACT"),
    btcBackendUrl: required(env, "MORROW_BTC_BACKEND_URL"),
    port: Number(env.MORROW_WATCHER_PORT ?? 8080),
    pollIntervalMs: Number(env.MORROW_POLL_INTERVAL_MS ?? 5_000),
    stateFile: env.MORROW_WATCHER_STATE_FILE ?? ".watcher-state/state.json",
    linksFile: env.MORROW_WATCHER_LINKS_FILE ?? ".watcher-state/links.json",
    appUrl,
    telegramToken: env.MORROW_TELEGRAM_BOT_TOKEN ?? null,
    jobsFile: env.MORROW_WATCHER_JOBS_FILE ?? ".watcher-state/clawbacks.json",
    guardian,
    clawbackFeeRate,
    adminToken: env.MORROW_WATCHER_ADMIN_TOKEN || null,
    challengeOwnerParent,
    watcherEnvelopeSecretKey: watcherEnvelopeSecretKey?.toLowerCase() ?? null,
  };
}
