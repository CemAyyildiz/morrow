/**
 * `link-code`: asks a watcher for a Telegram link code, signed with the Vault's own key, so an
 * operator or a judge can link a chat without the Keystore UI.
 *
 *   pnpm --filter @morrow/watcher link-code -- --watcher https://watcher.example --bot MorrowAlert_Bot \
 *     --vault 7 --role owner --account daniel.testnet --key-file ./owner.key
 *
 * `--bot` is the watcher's Telegram bot: it is signed into the request, so the request is good
 * for that watcher only. The watcher URL must be https (plain http only to localhost). The key
 * file holds the 32-byte secp256k1 secret (hex) behind the Vault's `owner_key` (Owner) or the
 * Guardian's `guardian_key` (Guardian) and must be readable by its owner only (0600). The key
 * never leaves this process; only the signature is sent. Prints the code and the t.me deep link
 * to open in the chat to link (for the Owner: a private chat with the bot).
 */
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  hexToBytes,
  linkRequestProblems,
  signLinkRequest,
  type LinkRequest,
  type LinkRequestRole,
} from "@morrow/core-ts";

export interface LinkCodeArgs {
  watcher: string;
  bot: string;
  vault: string;
  role: LinkRequestRole;
  account: string;
  keyFile: string;
}

export const USAGE =
  "usage: link-code --watcher <https url> --bot <bot username> --vault <id> --role owner|guardian --account <account id> --key-file <path>";

/** Parses `--name value` pairs; throws with the usage line on anything missing or unknown. */
export function parseArgs(argv: readonly string[]): LinkCodeArgs {
  const names = {
    "--watcher": "watcher",
    "--bot": "bot",
    "--vault": "vault",
    "--role": "role",
    "--account": "account",
    "--key-file": "keyFile",
  } as const;
  const values: Partial<Record<(typeof names)[keyof typeof names], string>> = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] as keyof typeof names;
    const value = args[i + 1];
    if (!Object.hasOwn(names, name) || value === undefined) throw new Error(USAGE);
    values[names[name]] = value;
  }
  const { watcher, bot, vault, role, account, keyFile } = values;
  if (
    !watcher ||
    !bot ||
    !vault ||
    !account ||
    !keyFile ||
    (role !== "owner" && role !== "guardian")
  ) {
    throw new Error(USAGE);
  }
  return { watcher, bot: bot.replace(/^@/, ""), vault, role, account, keyFile };
}

/** The signed request is a short-lived bearer of a link code: https only, except to localhost. */
export function watcherUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--watcher is not a URL: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("--watcher must be an https URL (plain http only to localhost or 127.0.0.1)");
  }
  return raw.replace(/\/+$/, "");
}

export interface LinkCodeDeps {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  /** The key file's permission bits. */
  fileMode: (path: string) => Promise<number>;
  /** Progress lines for the user; never given key material. */
  say: (line: string) => void;
  /** Nanoseconds since the Unix epoch; the watcher accepts ±10 min of NEAR time. */
  now: () => bigint;
}

export interface LinkCodeResult {
  code: string;
  deep_link: string;
}

/** Signs the request with the key file's secret and calls `POST /link-codes`. */
export async function linkCode(args: LinkCodeArgs, deps: LinkCodeDeps): Promise<LinkCodeResult> {
  const base = watcherUrl(args.watcher);
  const mode = (await deps.fileMode(args.keyFile)) & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `the key file is readable by others (mode ${mode.toString(8).padStart(3, "0")}); run: chmod 600 ${args.keyFile}`,
    );
  }
  const secret = (await deps.readFile(args.keyFile)).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error("the key file must hold a 32-byte secp256k1 secret key as 64 hex characters");
  }
  deps.say("The key is used here to sign the request; it is never sent.");
  const request: LinkRequest = {
    bot: args.bot,
    vault_id: args.vault,
    role: args.role,
    account_id: args.account,
    ts: deps.now().toString(),
  };
  const problems = linkRequestProblems(request);
  if (problems.length) throw new Error(problems.join("; "));
  const signature = signLinkRequest(request, hexToBytes(secret));
  // The watcher signs against its own bot username, so `bot` is not sent.
  const fields = {
    vault_id: request.vault_id,
    role: request.role,
    account_id: request.account_id,
    ts: request.ts,
  };
  const response = await deps.fetch(`${base}/link-codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fields, signature }),
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<LinkCodeResult> & {
        error?: string;
      })
    | null;
  if (
    response.status !== 201 ||
    typeof body?.code !== "string" ||
    typeof body.deep_link !== "string"
  ) {
    throw new Error(`the watcher refused: HTTP ${response.status} ${body?.error ?? ""}`.trim());
  }
  return { code: body.code, deep_link: body.deep_link };
}

/** True when this file is the entry script, also through a symlinked bin. */
function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    const result = await linkCode(parseArgs(process.argv.slice(2)), {
      fetch,
      readFile: (path) => readFile(path, "utf8"),
      fileMode: async (path) => (await stat(path)).mode,
      say: (line) => process.stderr.write(`${line}\n`),
      now: () => BigInt(Date.now()) * 1_000_000n,
    });
    process.stdout.write(
      `Code: ${result.code}\nOpen this link in the Telegram chat to link (valid 10 minutes):\n${result.deep_link}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
