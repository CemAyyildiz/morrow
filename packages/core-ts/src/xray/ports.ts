import type { AccountId, U64 } from "../contract/types.js";
import type { NearNetwork } from "./links.js";
import type { NearTxRef } from "./types.js";

type Fetch = typeof fetch;

// NEAR RPC shapes (only the fields X-Ray reads)

export interface RpcFunctionCall {
  method_name: string;
  /** Base64 JSON. */
  args: string;
  gas?: number | string;
  deposit?: string;
}

/** `"CreateAccount"` or `{ FunctionCall: {...} }`, `{ Transfer: {...} }`, ... */
export type RpcAction = string | { FunctionCall?: RpcFunctionCall; [kind: string]: unknown };

export interface RpcExecutionStatus {
  SuccessValue?: string;
  SuccessReceiptId?: string;
  Failure?: unknown;
  [other: string]: unknown;
}

export interface RpcOutcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: AccountId;
    logs: string[];
    receipt_ids: string[];
    status: RpcExecutionStatus;
  };
}

export interface RpcReceipt {
  receipt_id: string;
  predecessor_id: AccountId;
  receiver_id: AccountId;
  receipt: { Action?: { actions: RpcAction[] }; [other: string]: unknown };
}

/** `EXPERIMENTAL_tx_status` result. */
export interface RpcTxStatus {
  status: RpcExecutionStatus;
  transaction: {
    hash: string;
    signer_id: AccountId;
    receiver_id: AccountId;
    actions: RpcAction[];
  };
  transaction_outcome: RpcOutcome;
  receipts: RpcReceipt[];
  receipts_outcome: RpcOutcome[];
}

export interface RpcBlockHeader {
  hash: string;
  height: number;
  /** Block timestamp in nanoseconds, as a decimal string. */
  timestampNs: U64;
  /** The parent block's hash. */
  prevHash: string;
}

/** Read-only NEAR RPC. Must be an archival node: X-Ray reads old transactions and old state. */
export interface NearRpc {
  /** `EXPERIMENTAL_tx_status`: the transaction with every receipt and outcome. */
  txStatus(hash: string, senderId: AccountId): Promise<RpcTxStatus>;
  /** `query call_function`, at `blockHash` when given, else at final. Returns the parsed JSON. */
  viewAt(accountId: AccountId, method: string, args: object, blockHash?: string): Promise<unknown>;
  /** `block`: the header of one block. */
  blockHeader(blockHash: string): Promise<RpcBlockHeader>;
}

const TX_STATUS_WAIT_UNTIL = "EXECUTED_OPTIMISTIC";

/** Default per-request timeout for the fetch adapters. */
const DEFAULT_TIMEOUT_MS = 15_000;

// Source refs: the exact call each value came from.

export function txStatusRef(hash: string, senderId: AccountId): string {
  return `EXPERIMENTAL_tx_status ${JSON.stringify({
    tx_hash: hash,
    sender_account_id: senderId,
    wait_until: TX_STATUS_WAIT_UNTIL,
  })}`;
}

export function viewRef(
  accountId: AccountId,
  method: string,
  args: object,
  blockHash?: string,
): string {
  const at = blockHash === undefined ? "finality=final" : `block_id=${blockHash}`;
  return `query call_function ${accountId} ${method} ${JSON.stringify(args)} ${at}`;
}

export function blockRef(blockHash: string): string {
  return `block ${JSON.stringify({ block_id: blockHash })}`;
}

export class NearRpcError extends Error {
  constructor(
    message: string,
    /** RPC error cause, e.g. `UNKNOWN_TRANSACTION`, or `HTTP_<status>`. */
    readonly causeName: string | null,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(text: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { name?: string; message?: string; cause?: { name?: string }; data?: unknown };
}

/** `NearRpc` over JSON-RPC with `fetch`. Pass the archival URL (`MORROW_NEAR_ARCHIVAL_RPC_URL`). */
export class FetchNearRpc implements NearRpc {
  private readonly url: string;

  constructor(
    archivalUrl: string,
    private readonly fetchFn: Fetch = fetch,
    /** Per-request timeout. */
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    if (!archivalUrl) throw new Error("X-Ray needs an archival NEAR RPC URL");
    this.url = archivalUrl;
  }

  private async call<T>(method: string, params: object): Promise<T> {
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "morrow-xray", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as JsonRpcResponse<T> | null;
    if (body?.error) {
      const name = body.error.cause?.name ?? body.error.name ?? null;
      const detail = typeof body.error.data === "string" ? body.error.data : body.error.message;
      throw new NearRpcError(`${method}: ${name ?? "error"} ${detail ?? ""}`.trim(), name);
    }
    if (!response.ok || body?.result == null) {
      throw new NearRpcError(`${method}: HTTP ${response.status}`, `HTTP_${response.status}`);
    }
    return body.result;
  }

  txStatus(hash: string, senderId: AccountId): Promise<RpcTxStatus> {
    return this.call("EXPERIMENTAL_tx_status", {
      tx_hash: hash,
      sender_account_id: senderId,
      wait_until: TX_STATUS_WAIT_UNTIL,
    });
  }

  async viewAt(
    accountId: AccountId,
    method: string,
    args: object,
    blockHash?: string,
  ): Promise<unknown> {
    const result = await this.call<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      account_id: accountId,
      method_name: method,
      args_base64: encodeBase64Json(args),
      ...(blockHash === undefined ? { finality: "final" } : { block_id: blockHash }),
    });
    if (result.error !== undefined || result.result === undefined) {
      throw new NearRpcError(`query ${method}: ${result.error ?? "no result"}`, null);
    }
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  }

  async blockHeader(blockHash: string): Promise<RpcBlockHeader> {
    const block = await this.call<{
      header: { hash: string; height: number; timestamp_nanosec: string; prev_hash: string };
    }>("block", { block_id: blockHash });
    return {
      hash: block.header.hash,
      height: block.header.height,
      timestampNs: block.header.timestamp_nanosec,
      prevHash: block.header.prev_hash,
    };
  }
}

// Transaction locators: they find hashes only; every value shown is re-read over RPC.

export interface TxQuery {
  /** Contract method the transaction calls, e.g. `sign_input`. */
  method: string;
  /** Only transactions whose `op_id` argument is this op. */
  opId?: U64;
  /** Only transactions in blocks at or after this time (ns), e.g. the op's `created_at`. */
  sinceNs?: U64;
}

export interface TxLocator {
  find(contractId: AccountId, query: TxQuery): Promise<NearTxRef[]>;
  /** The signer of a known transaction, for RPC lookups that need it. */
  senderOf?(hash: string): Promise<AccountId | null>;
}

export interface TxHint {
  hash: string;
  senderId?: AccountId;
}

/**
 * Caller-supplied hashes (e.g. `/xray/<op_id>?tx=…`). Returned for every query; X-Ray reads each
 * one and ignores those that do not match.
 */
export function hintLocator(hints: readonly TxHint[]): TxLocator {
  return {
    async find() {
      return hints.map((h) => ({ hash: h.hash, senderId: h.senderId ?? null }));
    },
    async senderOf(hash) {
      return hints.find((h) => h.hash === hash)?.senderId ?? null;
    },
  };
}

/** The first locator with any result wins; later ones are not called. */
export function chainLocators(...locators: TxLocator[]): TxLocator {
  return {
    async find(contractId, query) {
      for (const locator of locators) {
        const found = await locator.find(contractId, query);
        if (found.length > 0) return found;
      }
      return [];
    },
    async senderOf(hash) {
      for (const locator of locators) {
        const sender = (await locator.senderOf?.(hash)) ?? null;
        if (sender !== null) return sender;
      }
      return null;
    },
  };
}

interface FastNearAccountTx {
  transaction_hash: string;
  tx_block_timestamp: string;
}

interface FastNearTx {
  transaction: {
    hash: string;
    signer_id: AccountId;
    receiver_id: AccountId;
    actions: RpcAction[];
  };
}

const FASTNEAR_TX_URLS: Record<NearNetwork, string> = {
  testnet: "https://tx.test.fastnear.com",
  mainnet: "https://tx.main.fastnear.com",
};

/** FastNEAR's `/v0/transactions` accepts at most 20 hashes per request. */
const FASTNEAR_BATCH = 20;
const FASTNEAR_PAGE = 200;

export interface FastNearLocatorOptions {
  network: NearNetwork;
  /** Overrides the FastNEAR transactions API base URL. */
  baseUrl?: string;
  fetch?: Fetch;
  /** Pages of 200 account transactions to scan, newest first. Default 10. */
  maxPages?: number;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Told when the scan stops at `maxPages` before reaching `sinceNs`. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Finds transaction hashes with the FastNEAR indexer (`/v0/account`, `/v0/transactions`). */
export class FastNearLocator implements TxLocator {
  private readonly base: string;
  private readonly fetchFn: Fetch;
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(options: FastNearLocatorOptions) {
    this.base = (options.baseUrl ?? FASTNEAR_TX_URLS[options.network]).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.maxPages = options.maxPages ?? 10;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const response = await this.fetchFn(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`FastNEAR ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private async transactions(hashes: string[]): Promise<FastNearTx[]> {
    const out: FastNearTx[] = [];
    for (let i = 0; i < hashes.length; i += FASTNEAR_BATCH) {
      const page = await this.post<{ transactions: (FastNearTx | null)[] }>("/v0/transactions", {
        tx_hashes: hashes.slice(i, i + FASTNEAR_BATCH),
      });
      for (const tx of page.transactions) if (tx) out.push(tx);
    }
    return out;
  }

  async find(contractId: AccountId, query: TxQuery): Promise<NearTxRef[]> {
    const since = query.sinceNs === undefined ? null : BigInt(query.sinceNs);
    const hashes: string[] = [];
    let resumeToken: string | undefined;
    let complete = false;
    for (let page = 0; page < this.maxPages; page++) {
      const result = await this.post<{ account_txs: FastNearAccountTx[]; resume_token?: string }>(
        "/v0/account",
        {
          account_id: contractId,
          is_real_receiver: true,
          is_function_call: true,
          limit: FASTNEAR_PAGE,
          ...(resumeToken === undefined ? {} : { resume_token: resumeToken }),
        },
      );
      let passedSince = false;
      for (const tx of result.account_txs) {
        if (since !== null && BigInt(tx.tx_block_timestamp) < since) passedSince = true;
        else hashes.push(tx.transaction_hash);
      }
      resumeToken = result.resume_token;
      if (passedSince || !resumeToken || result.account_txs.length === 0) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      this.log(
        `FastNEAR: stopped after ${this.maxPages} pages of ${contractId} transactions` +
          (since === null ? "" : ` before reaching ${query.sinceNs}`),
      );
    }

    const found: NearTxRef[] = [];
    for (const tx of await this.transactions(hashes)) {
      const t = tx.transaction;
      if (t.receiver_id !== contractId) continue;
      const matches = t.actions.some((action) => {
        if (typeof action === "string" || !action.FunctionCall) return false;
        if (action.FunctionCall.method_name !== query.method) return false;
        if (query.opId === undefined) return true;
        try {
          const args = JSON.parse(decodeBase64(action.FunctionCall.args)) as { op_id?: unknown };
          return args.op_id === query.opId;
        } catch {
          return false;
        }
      });
      if (matches) found.push({ hash: t.hash, senderId: t.signer_id });
    }
    return found;
  }

  async senderOf(hash: string): Promise<AccountId | null> {
    const [tx] = await this.transactions([hash]);
    return tx?.transaction.signer_id ?? null;
  }

  /**
   * Transactions signed by `accountId`, newest first, successful or not. Pages of 200 are read
   * until a page holds a hash `isKnown` accepts (everything older was read before), the history
   * ends, or `maxPages` is reached.
   */
  async signedBy(
    accountId: AccountId,
    isKnown: (hash: string) => boolean = () => false,
  ): Promise<SignedTx[]> {
    const out: SignedTx[] = [];
    let resumeToken: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const result = await this.post<{ account_txs: FastNearAccountTx[]; resume_token?: string }>(
        "/v0/account",
        {
          account_id: accountId,
          is_signer: true,
          limit: FASTNEAR_PAGE,
          ...(resumeToken === undefined ? {} : { resume_token: resumeToken }),
        },
      );
      let reachedKnown = false;
      for (const tx of result.account_txs) {
        if (isKnown(tx.transaction_hash)) reachedKnown = true;
        out.push({ hash: tx.transaction_hash, blockTimestampNs: tx.tx_block_timestamp });
      }
      resumeToken = result.resume_token;
      if (reachedKnown || !resumeToken || result.account_txs.length === 0) return out;
    }
    this.log(`FastNEAR: stopped after ${this.maxPages} pages of ${accountId} signed transactions`);
    return out;
  }
}

/** A transaction hash and its block time (ns), as the indexer lists it. */
export interface SignedTx {
  hash: string;
  blockTimestampNs: U64;
}
