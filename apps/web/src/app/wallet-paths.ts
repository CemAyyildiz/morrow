// The wallet pages (story 1.11b): `/vault/new` creates a Vault, `/vault/<vault_id>` operates
// one. The server gives exactly these paths the wallet CSP (server/config.ts `isWalletPath`),
// so the router reaches and leaves them with full page loads: a strict page never inherits the
// wallet CSP, and a wallet page never runs under the strict one.

export const VAULT_NEW_PATH = "/vault/new";

/** The Vault page of `vaultId`. */
export const vaultPath = (vaultId: string) => `/vault/${vaultId}`;

/**
 * The live example: a signet Vault created on the hosted app with a Meteor testnet wallet on
 * 2026-11-14 (Owner Account morrow.testnet, Delay 1 hour). The landing and the Challenge page
 * point visitors at it while no Challenge round is open.
 */
export const LIVE_VAULT_ID = "176";
export const LIVE_VAULT_PATH = vaultPath(LIVE_VAULT_ID);

/** True on a wallet page; the same rule as the server's. */
export function isWalletPath(pathname: string): boolean {
  return /^\/vault\/(new|\d+)\/?$/.test(pathname);
}

/** True when going from `from` to `to` crosses into or out of the wallet pages. */
export function crossesWalletBoundary(from: string, to: string): boolean {
  const path = (url: string) => url.replace(/[?#].*$/s, "");
  return isWalletPath(path(from)) !== isWalletPath(path(to));
}
