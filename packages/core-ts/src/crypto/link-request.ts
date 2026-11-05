import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { AccountId, Hex, U64 } from "../contract/types.js";
import { CryptoError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/** Who a Telegram chat link speaks for: the Vault's Owner, or one of its Guardians. */
export type LinkRequestRole = "owner" | "guardian";

/**
 * A request for a Telegram link code (`POST /link-codes`), signed by the Vault's own key: the
 * Owner Key for the Owner role, the Guardian's `guardian_key` for a Guardian. The watcher's bot
 * username is part of the signed message, so a request seen in transit cannot be replayed to
 * another watcher.
 */
export interface LinkRequest {
  /** The watcher's Telegram bot username (without `@`); compared case-insensitively. */
  bot: string;
  vault_id: U64;
  role: LinkRequestRole;
  account_id: AccountId;
  /** Signing time, nanoseconds since the Unix epoch; also the request's single-use nonce. */
  ts: U64;
}

const U64_PATTERN = /^(0|[1-9]\d*)$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Field problems, or an empty list when `request` can be signed and checked. */
export function linkRequestProblems(
  request: Partial<Record<keyof LinkRequest, unknown>>,
): string[] {
  const problems: string[] = [];
  if (typeof request.bot !== "string" || !BOT_USERNAME.test(request.bot)) {
    problems.push("bot must be the watcher's Telegram bot username");
  }
  const u64 = (value: unknown) =>
    typeof value === "string" && U64_PATTERN.test(value) && BigInt(value) < 2n ** 64n;
  if (!u64(request.vault_id)) problems.push("vault_id must be a u64 decimal string");
  if (request.role !== "owner" && request.role !== "guardian") {
    problems.push("role must be owner or guardian");
  }
  if (typeof request.account_id !== "string" || !NEAR_ACCOUNT.test(request.account_id)) {
    problems.push("account_id must be a NEAR account id");
  }
  if (!u64(request.ts)) problems.push("ts must be a u64 decimal string (nanoseconds)");
  return problems;
}

/** `morrow-link:v1:<bot>:<vault_id>:<role>:<account_id>:<ts>` (bot lowercased); no field can hold a `:`. */
export function linkRequestMessage(request: LinkRequest): string {
  const problems = linkRequestProblems(request);
  if (problems.length) throw new CryptoError(`Invalid link request: ${problems.join("; ")}`);
  const { bot, vault_id, role, account_id, ts } = request;
  return `morrow-link:v1:${bot.toLowerCase()}:${vault_id}:${role}:${account_id}:${ts}`;
}

/** The 32-byte digest that is signed: sha256 of the UTF-8 message. */
export function linkRequestDigest(request: LinkRequest): Uint8Array {
  return sha256(utf8ToBytes(linkRequestMessage(request)));
}

/** Signs a link request: secp256k1 ECDSA, low-S, as 64-byte compact `r ‖ s` hex. */
export function signLinkRequest(request: LinkRequest, secretKey: Uint8Array): Hex {
  return bytesToHex(
    secp256k1.sign(linkRequestDigest(request), secretKey, { prehash: false, lowS: true }),
  );
}

/**
 * True when `signature` (64-byte compact hex, low-S) signs `request` under `publicKey` (33-byte
 * compressed hex). Malformed input of any kind is false, never an exception.
 */
export function verifyLinkRequest(request: LinkRequest, signature: Hex, publicKey: Hex): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) return false;
  if (typeof publicKey !== "string" || !/^0[23][0-9a-f]{64}$/.test(publicKey)) return false;
  if (linkRequestProblems(request).length) return false;
  try {
    return secp256k1.verify(
      hexToBytes(signature),
      linkRequestDigest(request),
      hexToBytes(publicKey),
      {
        prehash: false,
        lowS: true,
        format: "compact",
      },
    );
  } catch {
    return false;
  }
}
