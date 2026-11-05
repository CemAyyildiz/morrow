import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  hexToBytes,
  signLinkRequest,
  type Guardian,
  type LinkRequestRole,
} from "@morrow/core-ts";
import { issueLinkCode, type LinkingOptions } from "../heartbeat.js";
import type { Redeemed } from "./links.js";

/** Test-only secp256k1 key pairs: link codes are signed in tests too, never issued unsigned. */
function keyPair(byte: string) {
  const secret = hexToBytes(byte.repeat(32));
  return { secret, publicKey: bytesToHex(secp256k1.getPublicKey(secret, true)) };
}

export const OWNER_KEYS = keyPair("11");
export const AUTO_KEYS = keyPair("22");
export const CONTACT_KEYS = keyPair("33");
export const THIEF_KEYS = keyPair("44");

export const OWNER = "daniel.testnet";
export const GUARDIAN = "watcher-guardian.testnet";
export const EMMA = "emma.testnet";

export const AUTO: Guardian = {
  guardian_key: AUTO_KEYS.publicKey,
  guardian_account: GUARDIAN,
  kind: "auto_clawback",
};
export const CONTACT: Guardian = {
  guardian_key: CONTACT_KEYS.publicKey,
  guardian_account: EMMA,
  kind: "trusted_contact",
};

export interface LinkAs {
  vault_id: string;
  role: LinkRequestRole;
  account_id: string;
  secret: Uint8Array;
}

/** A signed `POST /link-codes` body. */
export function signedBody(who: LinkAs, ts: bigint): Record<string, string> {
  const request = {
    vault_id: who.vault_id,
    role: who.role,
    account_id: who.account_id,
    ts: ts.toString(),
  };
  return { ...request, signature: signLinkRequest(request, who.secret) };
}

let signings = 0n;

/**
 * Links `chatId` the way a user does: a signed code request, then /start <code>. Each request is
 * signed at a slightly different `ts`, since a signed request is single-use.
 */
export async function linkChat(
  linking: LinkingOptions,
  who: LinkAs,
  chatId: number,
): Promise<Redeemed> {
  const now = await linking.clock.now();
  const issued = await issueLinkCode(signedBody(who, now - ++signings), linking);
  if (issued.status !== 201) throw new Error(`link code refused: ${JSON.stringify(issued)}`);
  const redeemed = await linking.links.redeem((issued.body as { code: string }).code, chatId, now);
  if (!redeemed) throw new Error("code did not redeem");
  return redeemed;
}
