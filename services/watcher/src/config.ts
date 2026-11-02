export interface WatcherConfig {
  nearNetwork: "mock" | "testnet" | "mainnet";
  nearRpcUrl: string | null;
  vaultContract: string;
  btcBackendUrl: string;
  port: number;
  pollIntervalMs: number;
  stateFile: string;
}

const NEAR_RPC: Record<"testnet" | "mainnet", string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
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
  return {
    nearNetwork,
    nearRpcUrl: nearNetwork === "mock" ? null : (env.MORROW_NEAR_RPC_URL ?? NEAR_RPC[nearNetwork]),
    vaultContract: required(env, "MORROW_VAULT_CONTRACT"),
    btcBackendUrl: required(env, "MORROW_BTC_BACKEND_URL"),
    port: Number(env.MORROW_WATCHER_PORT ?? 8080),
    pollIntervalMs: Number(env.MORROW_POLL_INTERVAL_MS ?? 5_000),
    stateFile: env.MORROW_WATCHER_STATE_FILE ?? ".watcher-state/state.json",
  };
}
