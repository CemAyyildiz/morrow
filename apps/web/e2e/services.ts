// The deployment the e2e run serves: the web server on 4173 and local stand-ins for the NEAR
// RPC, the Bitcoin backend and the watcher, each on its own origin so the CSP check can tell
// them apart. Shared by playwright.config.ts, the specs and stub-services.ts.

export const WEB_PORT = 4173;
export const RPC_PORT = 4191;
export const BACKEND_PORT = 4192;
export const WATCHER_PORT = 4193;

export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const WATCHER_URL = `http://127.0.0.1:${WATCHER_PORT}`;

/** The env the web server starts with. */
export const WEB_ENV = {
  MORROW_NEAR_NETWORK: "testnet",
  MORROW_VAULT_CONTRACT: "vault.morrow.testnet",
  MORROW_BTC_NETWORK: "signet",
  MORROW_BTC_BACKEND_URL: BACKEND_URL,
  MORROW_NEAR_RPC_URL: RPC_URL,
  MORROW_WATCHER_URL: WATCHER_URL,
  HOST: "127.0.0.1",
  PORT: String(WEB_PORT),
};

/** The stub watcher reports a heartbeat this old. */
export const STUB_HEARTBEAT_AGE_MS = 60_000;
