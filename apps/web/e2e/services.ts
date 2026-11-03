// The deployment the e2e run serves: the web server on 4173 and local stand-ins for the NEAR
// RPC, the Bitcoin backend and the watcher, each on its own origin so the CSP check can tell
// them apart. Shared by playwright.config.ts, the specs and stub-services.ts.

// MORROW_E2E_PORT_OFFSET shifts all four ports, so a run can sit beside a server already
// holding them (a preview, another worktree's run). Default 0.
function portOffset(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const offset = Number(raw.trim());
  // The highest port, 4193 + offset, must stay a valid TCP port.
  if (!/^\d+$/.test(raw.trim()) || 4193 + offset > 65535) {
    throw new Error(
      `MORROW_E2E_PORT_OFFSET must be a non-negative integer up to ${65535 - 4193}, got "${raw}"`,
    );
  }
  return offset;
}
const OFFSET = portOffset(process.env.MORROW_E2E_PORT_OFFSET);

export const WEB_PORT = 4173 + OFFSET;
export const RPC_PORT = 4191 + OFFSET;
export const BACKEND_PORT = 4192 + OFFSET;
export const WATCHER_PORT = 4193 + OFFSET;

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
