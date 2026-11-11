// X-Ray's routes (story 6.4): `/xray` (the form), `/xray/<op_id>` and `/xray/tx/<hash>`. Kept
// apart from xray.ts, which loads `buildXRay`, so the router, the Try panel and the Proof Page
// can link to an X-Ray without pulling the X-Ray page into the main bundle.
import { canonicalVaultId } from "./proof";

export const XRAY_PATH = "/xray";

/** What an X-Ray route shows. */
export type XRayTarget =
  { kind: "op"; opId: string } | { kind: "tx"; hash: string; sender: string | null };

/** `/xray/<op_id>`. */
export const xrayOpPath = (opId: string) => `${XRAY_PATH}/${opId}`;

/**
 * `/xray/tx/<hash>`; `?sender=` names the signer when it is known, so the page need not wait for
 * the indexer to learn it. Only for full page loads: the in-app router keeps no query.
 */
export function xrayTxPath(hash: string, sender?: string | null): string {
  const path = `${XRAY_PATH}/tx/${hash}`;
  return sender ? `${path}?sender=${encodeURIComponent(sender)}` : path;
}

/** A NEAR transaction hash: 32 bytes in base58. */
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** NEAR account id rules (nomicon), as the server checks the contract id. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export type XRayRoute =
  | { kind: "form" }
  | { kind: "op"; opId: string }
  | { kind: "tx"; hash: string }
  | { kind: "redirect"; to: string };

/**
 * `/xray` (the form), `/xray/<op_id>` and `/xray/tx/<hash>`; `/xray/007` redirects to `/xray/7`.
 * Null for any other path. `path` is normalized (no trailing `/`).
 */
export function parseXRayPath(path: string): XRayRoute | null {
  if (path === XRAY_PATH) return { kind: "form" };
  const op = /^\/xray\/(\d+)$/.exec(path)?.[1];
  if (op !== undefined) {
    const opId = canonicalVaultId(op);
    if (opId === null) return null;
    return opId === op ? { kind: "op", opId } : { kind: "redirect", to: xrayOpPath(opId) };
  }
  const hash = /^\/xray\/tx\/([^/]+)$/.exec(path)?.[1];
  if (hash !== undefined && NEAR_HASH.test(hash)) return { kind: "tx", hash };
  return null;
}

/** The form's entry as a route: an op id, or a NEAR transaction hash; null otherwise. */
export function parseXRayEntry(text: string): string | null {
  const value = text.trim();
  if (/^\d+$/.test(value)) {
    const opId = canonicalVaultId(value);
    return opId === null ? null : xrayOpPath(opId);
  }
  return NEAR_HASH.test(value) ? xrayTxPath(value) : null;
}

/** The `?sender=` hint of a `/xray/tx/<hash>` page load, when it is a NEAR account id. */
export function senderHint(search: string): string | null {
  const sender = new URLSearchParams(search).get("sender");
  return sender !== null && NEAR_ACCOUNT.test(sender) ? sender : null;
}
