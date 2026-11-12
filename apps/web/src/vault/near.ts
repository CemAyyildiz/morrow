// NEAR for the wallet pages. Contract calls are signed by the user's own wallet, connected
// through @hot-labs/near-connect, which is loaded with a dynamic import from these pages only.
// Views are raw JSON-RPC `fetch`es, so the bundle carries no NEAR SDK. Nothing here sees a key:
// the wallet signs, and the Bitcoin keys stay in the page.
import {
  ERROR_CODES,
  isErrorCode,
  parseContractError,
  type ErrorCode,
} from "@morrow/core-ts/browser";
import type { NearConnectorOptions } from "@hot-labs/near-connect";
import { withTimeout } from "@/app/live";
import { WALLET_MANIFEST } from "./wallets";

export const TGAS = 1_000_000_000_000n;
/** `create_vault` waits for two MPC derivations and a callback. */
export const CREATE_GAS = 100n * TGAS;
/** `sign_input` waits for one MPC signature and a callback. */
export const SIGN_GAS = 100n * TGAS;
export const DEFAULT_GAS = 30n * TGAS;
/** `create_vault`'s storage deposit: 0.5 NEAR. */
export const CREATE_DEPOSIT = 500_000_000_000_000_000_000_000n;

/** Gas per method: the contract client's own choices. */
export function gasFor(method: string): bigint {
  if (method === "create_vault") return CREATE_GAS;
  if (method === "sign_input") return SIGN_GAS;
  return DEFAULT_GAS;
}

// The wallet

/** The part of a near-connect wallet the pages use. */
export interface Wallet {
  manifest: { id: string; name: string };
  getAccounts(): Promise<{ accountId: string }[]>;
  signAndSendTransaction(params: {
    receiverId: string;
    actions: {
      type: "FunctionCall";
      params: { methodName: string; args: object; gas: string; deposit: string };
    }[];
  }): Promise<unknown>;
}

/** The part of near-connect's `NearConnector` the pages use. */
export interface Connector {
  connect(): Promise<Wallet>;
  disconnect(wallet?: Wallet): Promise<void>;
  getConnectedWallet(): Promise<{ wallet: Wallet; accounts: { accountId: string }[] }>;
}

export interface Connected {
  wallet: Wallet;
  accountId: string;
}

/** The page's CSP nonce, from `<meta name="csp-nonce">` (the server writes it on wallet pages). */
export function readCspNonce(doc: Pick<Document, "querySelector"> = document): string | null {
  const content = doc.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? "";
  return /^[A-Za-z0-9+/]{22}==$/.test(content) ? content : null;
}

/**
 * Loads near-connect (its own chunk) and builds the connector: NEAR testnet, the local manifest
 * of pinned wallets, the page's nonce for the executor iframe, and no third-party footer.
 */
export async function loadConnector(cspNonce: string): Promise<Connector> {
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network: "testnet",
    // The repository manifest's `platform` is a map of links; near-connect's type says a list.
    manifest: WALLET_MANIFEST as unknown as NonNullable<NearConnectorOptions["manifest"]>,
    cspNonce,
    footerBranding: null,
  });
  return connector as unknown as Connector;
}

let connectorPromise: Promise<Connector> | null = null;

/** The page's one connector, built on first use; a failed load is retried on the next use. */
export function sharedConnector(cspNonce: string): Promise<Connector> {
  connectorPromise ??= loadConnector(cspNonce).catch((error: unknown) => {
    connectorPromise = null;
    throw error;
  });
  return connectorPromise;
}

async function accountOf(wallet: Wallet, accounts?: { accountId: string }[]): Promise<string> {
  const list = accounts ?? (await wallet.getAccounts());
  const accountId = list[0]?.accountId;
  if (typeof accountId !== "string" || accountId === "") throw new Error("No account");
  return accountId;
}

/** Opens the wallet picker and signs in; resolves with the wallet and its account. */
export async function connectWallet(cspNonce: string): Promise<Connected> {
  const connector = await sharedConnector(cspNonce);
  const wallet = await connector.connect();
  return { wallet, accountId: await accountOf(wallet) };
}

/** The wallet a previous visit connected, if near-connect remembers one; never opens a picker. */
export async function restoreWallet(cspNonce: string): Promise<Connected | null> {
  try {
    if (localStorage.getItem("selected-wallet") === null) return null;
  } catch {
    return null;
  }
  try {
    const connector = await sharedConnector(cspNonce);
    const { wallet, accounts } = await connector.getConnectedWallet();
    return { wallet, accountId: await accountOf(wallet, accounts) };
  } catch {
    return null;
  }
}

export async function disconnectWallet(cspNonce: string, wallet: Wallet): Promise<void> {
  const connector = await sharedConnector(cspNonce);
  await connector.disconnect(wallet).catch(() => undefined);
}

// Calls

export type CallOutcome =
  /** The contract took the call; `value` is its JSON return value (null when none). */
  | { kind: "ok"; value: unknown; hash: string | null; logs: string[] }
  /** The contract or NEAR refused it: the `ERR_*` code when there is one. */
  | { kind: "refused"; code: ErrorCode | null; message: string; hash: string | null }
  /** The wallet did not send it: the user closed or declined it. */
  | { kind: "rejected"; message: string }
  /** Maybe sent: the wallet's answer cannot be read, or it failed in a way that is no cancel. */
  | { kind: "unreadable"; hash: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeBase64Json(text: string): unknown {
  if (text === "") return null;
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Every log line of a final execution outcome. */
function logsOf(result: Record<string, unknown>): string[] {
  const outcomes = [
    result.transaction_outcome,
    ...(Array.isArray(result.receipts_outcome) ? result.receipts_outcome : []),
  ];
  const logs: string[] = [];
  for (const outcome of outcomes) {
    if (!isRecord(outcome) || !isRecord(outcome.outcome)) continue;
    const lines = outcome.outcome.logs;
    if (Array.isArray(lines)) logs.push(...lines.filter((l): l is string => typeof l === "string"));
  }
  return logs;
}

function hashOf(result: Record<string, unknown>): string | null {
  const tx = result.transaction;
  if (isRecord(tx) && typeof tx.hash === "string") return tx.hash;
  const outcome = result.transaction_outcome;
  if (isRecord(outcome) && typeof outcome.id === "string") return outcome.id;
  return null;
}

/** The `ERR_*` code in an error's text, else null. */
export function errorCodeIn(error: unknown): ErrorCode | null {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? null);
  return parseContractError(text)?.code ?? null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Reads a wallet's `signAndSendTransaction` answer (a NEAR final execution outcome). */
export function readCallOutcome(result: unknown): CallOutcome {
  if (!isRecord(result) || !isRecord(result.status)) {
    return { kind: "unreadable", hash: isRecord(result) ? hashOf(result) : null };
  }
  const hash = hashOf(result);
  const status = result.status;
  if (status.Failure !== undefined) {
    const message = messageOf(status.Failure);
    return { kind: "refused", code: errorCodeIn(message), message, hash };
  }
  if (typeof status.SuccessValue !== "string") return { kind: "unreadable", hash };
  try {
    return { kind: "ok", value: decodeBase64Json(status.SuccessValue), hash, logs: logsOf(result) };
  } catch {
    return { kind: "unreadable", hash };
  }
}

/** What wallets throw when the user closes or declines them: nothing was sent. */
export const USER_CANCEL = /user rejected|rejected by user|cancel|closed|failed to sign in/i;

/**
 * Signs and sends one `FunctionCall` to the contract through the wallet and reads the outcome.
 * A wallet that throws on a contract failure still yields `refused` with its `ERR_*` code.
 */
export async function callContract(
  wallet: Wallet,
  contractId: string,
  method: string,
  args: object,
  options: { deposit?: bigint; gas?: bigint } = {},
): Promise<CallOutcome> {
  let result: unknown;
  try {
    result = await wallet.signAndSendTransaction({
      receiverId: contractId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: method,
            args,
            gas: (options.gas ?? gasFor(method)).toString(),
            deposit: (options.deposit ?? 0n).toString(),
          },
        },
      ],
    });
  } catch (error) {
    const code = errorCodeIn(error);
    const message = messageOf(error);
    if (code !== null) return { kind: "refused", code, message, hash: null };
    // Only a clear cancel means nothing was sent; any other throw may come after sending.
    if (USER_CANCEL.test(message)) return { kind: "rejected", message };
    return { kind: "unreadable", hash: null };
  }
  return readCallOutcome(result);
}

// Views

export type ViewAnswer =
  | { kind: "ok"; value: unknown }
  /** The contract refused the view: its `ERR_*` code when it has one. */
  | { kind: "error"; code: ErrorCode | null }
  /** No answer: the network, a timeout or a body that is not JSON-RPC. */
  | { kind: "unreachable" };

/** A contract view over NEAR JSON-RPC (`query` / `call_function`, `final`). */
export async function viewContract(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ViewAnswer> {
  let body: unknown;
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "morrow-vault",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
      signal: withTimeout(signal),
    });
    body = await response.json();
  } catch {
    return { kind: "unreachable" };
  }
  if (!isRecord(body)) return { kind: "unreachable" };
  if (body.error !== undefined && body.error !== null) {
    return { kind: "error", code: errorCodeIn(body.error) };
  }
  const result = body.result;
  if (!isRecord(result)) return { kind: "unreachable" };
  // Older nodes answer a panicking view with a result that carries an `error` text.
  if (typeof result.error === "string") return { kind: "error", code: errorCodeIn(result.error) };
  const bytes = result.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    return { kind: "unreachable" };
  }
  try {
    return {
      kind: "ok",
      value: JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))),
    };
  } catch {
    return { kind: "unreachable" };
  }
}

/** `ERR_X` and what it means, for a refusal line. */
export function errorGloss(code: string): string | null {
  return isErrorCode(code) ? ERROR_CODES[code] : null;
}
