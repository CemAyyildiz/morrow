/**
 * `link-code`: asks a watcher for a Telegram link code, signed with the Vault's own key, so an
 * operator or a judge can link a chat without the Keystore UI.
 *
 *   pnpm --filter @morrow/watcher link-code -- --watcher http://localhost:8080 --vault 7 \
 *     --role owner --account daniel.testnet --key-file ./owner.key
 *
 * The key file holds the 32-byte secp256k1 secret (hex) behind the Vault's `owner_key` (Owner)
 * or the Guardian's `guardian_key` (Guardian). The key never leaves this process; only the
 * signature is sent. Prints the code and the t.me deep link to open in the chat to link.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  hexToBytes,
  linkRequestProblems,
  signLinkRequest,
  type LinkRequest,
  type LinkRequestRole,
} from "@morrow/core-ts";

export interface LinkCodeArgs {
  watcher: string;
  vault: string;
  role: LinkRequestRole;
  account: string;
  keyFile: string;
}

export const USAGE =
  "usage: link-code --watcher <url> --vault <id> --role owner|guardian --account <account id> --key-file <path>";

/** Parses `--name value` pairs; throws with the usage line on anything missing or unknown. */
export function parseArgs(argv: readonly string[]): LinkCodeArgs {
  const names = {
    "--watcher": "watcher",
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
  const { watcher, vault, role, account, keyFile } = values;
  if (!watcher || !vault || !account || !keyFile || (role !== "owner" && role !== "guardian")) {
    throw new Error(USAGE);
  }
  return { watcher, vault, role, account, keyFile };
}

export interface LinkCodeDeps {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  /** Nanoseconds since the Unix epoch; the watcher accepts ±10 min of NEAR time. */
  now: () => bigint;
}

export interface LinkCodeResult {
  code: string;
  deep_link: string;
}

/** Signs the request with the key file's secret and calls `POST /link-codes`. */
export async function linkCode(args: LinkCodeArgs, deps: LinkCodeDeps): Promise<LinkCodeResult> {
  const secret = (await deps.readFile(args.keyFile)).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error("the key file must hold a 32-byte secp256k1 secret key as 64 hex characters");
  }
  const request: LinkRequest = {
    vault_id: args.vault,
    role: args.role,
    account_id: args.account,
    ts: deps.now().toString(),
  };
  const problems = linkRequestProblems(request);
  if (problems.length) throw new Error(problems.join("; "));
  const signature = signLinkRequest(request, hexToBytes(secret));
  const response = await deps.fetch(`${args.watcher.replace(/\/+$/, "")}/link-codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, signature }),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await linkCode(parseArgs(process.argv.slice(2)), {
      fetch,
      readFile: (path) => readFile(path, "utf8"),
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
