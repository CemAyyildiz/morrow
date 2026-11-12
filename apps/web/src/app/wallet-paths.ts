// The wallet pages (story 1.11b): `/vault/new` creates a Vault, `/vault/<vault_id>` operates
// one. The server gives exactly these paths the wallet CSP (server/config.ts `isWalletPath`),
// so the router reaches and leaves them with full page loads: a strict page never inherits the
// wallet CSP, and a wallet page never runs under the strict one.

export const VAULT_NEW_PATH = "/vault/new";

/** The Vault page of `vaultId`. */
export const vaultPath = (vaultId: string) => `/vault/${vaultId}`;

/** True on a wallet page; the same rule as the server's. */
export function isWalletPath(pathname: string): boolean {
  return /^\/vault\/(new|\d+)\/?$/.test(pathname);
}

/** True when going from `from` to `to` crosses into or out of the wallet pages. */
export function crossesWalletBoundary(from: string, to: string): boolean {
  const path = (url: string) => url.replace(/[?#].*$/s, "");
  return isWalletPath(path(from)) !== isWalletPath(path(to));
}
