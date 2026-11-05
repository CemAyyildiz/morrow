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

export const BOT = "MorrowAlert_Bot";

/** A signed `POST /link-codes` body, for the watcher whose bot is `bot`. */
export function signedBody(who: LinkAs, ts: bigint, bot = BOT): Record<string, string> {
  const fields = {
    vault_id: who.vault_id,
    role: who.role,
    account_id: who.account_id,
    ts: ts.toString(),
  };
  return { ...fields, signature: signLinkRequest({ bot, ...fields }, who.secret) };
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
  /** The Telegram user and chat kind; by default a private chat whose user id is the chat id. */
  from = { userId: chatId, privateChat: true },
): Promise<Redeemed> {
  const now = await linking.clock.now();
  const issued = await issueLinkCode(
    signedBody(who, now - ++signings, linking.botUsername),
    linking,
  );
  if (issued.status !== 201) throw new Error(`link code refused: ${JSON.stringify(issued)}`);
  const redeemed = await linking.links.redeem(
    (issued.body as { code: string }).code,
    chatId,
    now,
    from,
  );
  if (!redeemed || redeemed === "private_chat_required") throw new Error("code did not redeem");
  return redeemed;
}
