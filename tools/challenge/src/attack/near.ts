/**
 * The tool's NEAR client: JSON-RPC over `fetch`, signed with core-ts `parseNearKey` /
 * `signFunctionCall` (the same signer "Try with these keys" uses in the browser). It reads only
 * public data: access keys, blocks, accounts and contract views. Calls are strictly sequential.
 */
import {
  decodeBlockHash,
  failureKind,
  parseContractError,
  signFunctionCall,
  txFailure,
  type AccountId,
  type ErrorCode,
  type NearKey,
  type RpcTxStatus,
  type Vault,
  type VaultKit,
} from "@morrow/core-ts";

export const DEFAULT_GAS = 30_000_000_000_000n;
/** `sign_input` asks the MPC network: the contract client's gas for it. */
export const SIGN_GAS = 100_000_000_000_000n;
/** `send_tx` waits for the receipts to execute: allow it longer than a view. */
export const SEND_TIMEOUT_MS = 60_000;
export const VIEW_TIMEOUT_MS = 15_000;

export function gasFor(method: string): bigint {
  return method === "sign_input" ? SIGN_GAS : DEFAULT_GAS;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export type RpcAnswer =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: unknown }
  /** No answer: the network, a timeout or a body that is not JSON-RPC. */
  | { kind: "unreachable"; detail: string };

export type NearRpcCall = (method: string, params: unknown) => Promise<RpcAnswer>;

/** JSON-RPC over `fetch` to `url`, each call aborted after its timeout. */
export function rpcOver(url: string, fetchFn: typeof fetch = fetch): NearRpcCall {
  let id = 0;
  return async (method, params) => {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `morrow-attack-${++id}`, method, params }),
        signal: AbortSignal.timeout(method === "send_tx" ? SEND_TIMEOUT_MS : VIEW_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.error !== undefined && body.error !== null) {
        return { kind: "error", error: body.error };
      }
      if (response.ok && isRecord(body) && "result" in body) {
        return { kind: "result", result: body.result };
      }
      return { kind: "unreachable", detail: `HTTP ${response.status}` };
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/** What an RPC error means for an attempt. */
export function rpcErrorKind(
  error: unknown,
): "nonce" | "allowance" | "key_missing" | "timeout" | "other" {
  const body = asText(error);
  if (/InvalidNonce/.test(body)) return "nonce";
  if (/NotEnoughAllowance/.test(body)) return "allowance";
  // Access-key errors only: a missing account (`UNKNOWN_ACCOUNT`) is not a missing key.
  if (/AccessKeyNotFound|UNKNOWN_ACCESS_KEY|access key \S+ does not exist/i.test(body)) {
    return "key_missing";
  }
  if (/TIMEOUT_ERROR/.test(body)) return "timeout";
  return "other";
}

/** `ak_nonce` of an `InvalidNonce` error, wherever the node put it. */
export function akNonceOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const nonce = isRecord(error.InvalidNonce) ? error.InvalidNonce.ak_nonce : undefined;
  if (typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0) return nonce;
  for (const value of Object.values(error)) {
    const found = akNonceOf(value);
    if (found !== null) return found;
  }
  return null;
}

/** One Vault Contract call. */
export interface CallPlan {
  signerId: AccountId;
  receiverId: AccountId;
  method: string;
  args: object;
}

export type CallResult =
  /** Included and successful: the decoded return value and every log line. */
  | { kind: "accepted"; hash: string; value: unknown; logs: string[] }
  /** Included and failed: the contract's `ERR_*` code, else the raw NEAR failure kind. */
  | { kind: "refused"; hash: string; code: ErrorCode | null; failure: string }
  /** Refused by NEAR before inclusion (it can never be in the Attempt Log): the RPC error. */
  | {
      kind: "not_included";
      hash: string;
      reason: "nonce" | "allowance" | "key_missing" | "invalid";
      error: string;
    }
  /** Sent (or maybe sent) but no readable answer; `hash` is null when nothing was signed. */
  | { kind: "unreadable"; hash: string | null; error: string };

export type AccessKeyState =
  | { exists: false }
  /** `allowanceYocto` null: a key with no allowance limit. */
  | { exists: true; nonce: number; allowanceYocto: bigint | null };

/** Every log line of a transaction result. */
function logsOf(result: Record<string, unknown>): string[] {
  const outcomes = [
    result.transaction_outcome,
    ...(Array.isArray(result.receipts_outcome) ? result.receipts_outcome : []),
  ];
  const logs: string[] = [];
  for (const outcome of outcomes) {
    if (!isRecord(outcome) || !isRecord(outcome.outcome)) continue;
    const lines = outcome.outcome.logs;
    if (Array.isArray(lines)) {
      logs.push(...lines.filter((l): l is string => typeof l === "string"));
    }
  }
  return logs;
}

function decodeBase64Json(value: string): unknown {
  if (value === "") return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The RPC client the run drives; the real one is `fetchNear`, the tests pass a fake. */
export interface NearPort {
  accessKey(accountId: AccountId, publicKey: string): Promise<AccessKeyState | "unreachable">;
  getVault(vaultId: string): Promise<Vault>;
  getVaultKit(vaultId: string): Promise<VaultKit>;
  /** `view_account` for the contract's `code_hash`. */
  codeHash(accountId: AccountId): Promise<string>;
  /** NEAR tip height (`block` final). */
  tipHeight(): Promise<number>;
  /** Signs and sends one call; see `sendCall`. */
  call(key: NearKey, plan: CallPlan): Promise<CallResult>;
}

/**
 * Signs and sends one call: nonce from `view_access_key` + 1, block hash from the final block,
 * `send_tx` waiting for `EXECUTED_OPTIMISTIC`. On `InvalidNonce` it retries once with
 * `max(view nonce, ak_nonce) + 1`.
 */
export async function sendCall(
  rpc: NearRpcCall,
  key: NearKey,
  plan: CallPlan,
): Promise<CallResult> {
  let taken = -1;
  let hash: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: plan.signerId,
      public_key: key.publicKeyString,
    });
    if (access.kind === "unreachable") {
      return { kind: "unreadable", hash: null, error: access.detail };
    }
    if (access.kind === "error") {
      const reason = rpcErrorKind(access.error);
      if (reason === "allowance" || reason === "key_missing") {
        return { kind: "not_included", hash: hash ?? "", reason, error: asText(access.error) };
      }
      return { kind: "unreadable", hash: null, error: asText(access.error) };
    }
    const accessKey = access.result;
    if (isRecord(accessKey) && typeof accessKey.error === "string") {
      return { kind: "unreadable", hash: null, error: accessKey.error };
    }
    const nonce = isRecord(accessKey) ? accessKey.nonce : undefined;
    if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) {
      return { kind: "unreadable", hash: null, error: "no nonce in view_access_key" };
    }
    const block = await rpc("block", { finality: "final" });
    const header = block.kind === "result" && isRecord(block.result) ? block.result.header : null;
    if (!isRecord(header) || typeof header.hash !== "string") {
      return { kind: "unreadable", hash: null, error: "no final block" };
    }
    let blockHash: Uint8Array;
    try {
      blockHash = decodeBlockHash(header.hash);
    } catch {
      return { kind: "unreadable", hash: null, error: "bad block hash" };
    }
    const signed = signFunctionCall(
      {
        signerId: plan.signerId,
        receiverId: plan.receiverId,
        nonce: BigInt(Math.max(nonce, taken)) + 1n,
        blockHash,
        methodName: plan.method,
        args: plan.args,
        gas: gasFor(plan.method),
        deposit: 0n,
      },
      key,
    );
    hash = signed.hash;
    const sent = await rpc("send_tx", {
      signed_tx_base64: signed.signedBase64,
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    if (sent.kind === "result") return readResult(sent.result, plan, signed.hash);
    if (sent.kind === "unreachable") {
      return { kind: "unreadable", hash: signed.hash, error: sent.detail };
    }
    const reason = rpcErrorKind(sent.error);
    if (reason === "nonce") {
      taken = Math.max(taken, akNonceOf(sent.error) ?? -1);
      if (attempt === 0) continue;
      return {
        kind: "not_included",
        hash: signed.hash,
        reason: "nonce",
        error: asText(sent.error),
      };
    }
    if (reason === "allowance" || reason === "key_missing") {
      return { kind: "not_included", hash: signed.hash, reason, error: asText(sent.error) };
    }
    const error = sent.error;
    // Only an invalid transaction is known never to have reached the chain. Anything else
    // (a timeout, an internal error after forwarding) may have landed.
    const invalid =
      (isRecord(error) && isRecord(error.cause) && error.cause.name === "INVALID_TRANSACTION") ||
      /InvalidTxError/.test(asText(error));
    if (reason === "timeout" || !invalid) {
      return { kind: "unreadable", hash: signed.hash, error: asText(error) };
    }
    const detail = isRecord(error) && error.data !== undefined ? error.data : error;
    return {
      kind: "not_included",
      hash: signed.hash,
      reason: "invalid",
      error: failureKind(detail),
    };
  }
  return { kind: "not_included", hash: hash ?? "", reason: "nonce", error: "InvalidNonce twice" };
}

/** Reads a `send_tx` result: accepted or refused, else unreadable. Never guesses. */
export function readResult(result: unknown, plan: CallPlan, hash: string): CallResult {
  if (!isRecord(result) || !isRecord(result.status)) {
    return { kind: "unreadable", hash, error: "no status in result" };
  }
  const status = result.status;
  if (status.Failure !== undefined) {
    let failure: { code: ErrorCode | null; failure: string } | null;
    try {
      // `send_tx` results carry no `receipts`; the method comes from the call itself.
      const tx = {
        ...result,
        receipts: Array.isArray(result.receipts) ? result.receipts : [],
      } as unknown as RpcTxStatus;
      failure = txFailure(tx, plan.receiverId);
    } catch {
      failure = null;
    }
    return {
      kind: "refused",
      hash,
      code: failure?.code ?? parseContractError(JSON.stringify(status.Failure))?.code ?? null,
      failure: failure?.failure ?? failureKind(status.Failure),
    };
  }
  if (typeof status.SuccessValue !== "string") {
    return { kind: "unreadable", hash, error: "no SuccessValue" };
  }
  return {
    kind: "accepted",
    hash,
    value: decodeBase64Json(status.SuccessValue),
    logs: logsOf(result),
  };
}

export interface FetchNearOptions {
  rpcUrl: string;
  /** The Vault Contract id, or a getter (the live run learns it from `/round`). */
  vaultContract: AccountId | (() => AccountId);
  fetchFn?: typeof fetch;
}

/** A `NearPort` over NEAR JSON-RPC, bound to one Vault Contract. */
export function nearPort(options: FetchNearOptions): NearPort {
  const contractOf = () =>
    typeof options.vaultContract === "function" ? options.vaultContract() : options.vaultContract;
  const rpc = rpcOver(options.rpcUrl, options.fetchFn ?? fetch);
  const view = async <T>(contractId: AccountId, method: string, args: object): Promise<T> => {
    const answer = await rpc("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (
      answer.kind !== "result" ||
      !isRecord(answer.result) ||
      !Array.isArray(answer.result.result)
    ) {
      const detail = answer.kind === "error" ? asText(answer.error) : "unreachable";
      throw new Error(`${method} view failed: ${detail}`);
    }
    return JSON.parse(Buffer.from(answer.result.result as number[]).toString("utf8")) as T;
  };
  return {
    async accessKey(accountId, publicKey) {
      const answer = await rpc("query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: accountId,
        public_key: publicKey,
      });
      if (answer.kind === "unreachable") return "unreachable";
      if (answer.kind === "error") {
        return rpcErrorKind(answer.error) === "key_missing" ? { exists: false } : "unreachable";
      }
      const result = answer.result;
      if (isRecord(result) && typeof result.error === "string") {
        return rpcErrorKind(result.error) === "key_missing" ? { exists: false } : "unreachable";
      }
      const nonce = isRecord(result) ? result.nonce : undefined;
      const permission = isRecord(result) ? result.permission : undefined;
      if (typeof nonce !== "number") return "unreachable";
      const allowance =
        isRecord(permission) && isRecord(permission.FunctionCall)
          ? permission.FunctionCall.allowance
          : undefined;
      return {
        exists: true,
        nonce,
        allowanceYocto:
          allowance === null || allowance === undefined ? null : BigInt(String(allowance)),
      };
    },
    getVault: (vaultId) => view<Vault>(contractOf(), "get_vault", { vault_id: vaultId }),
    getVaultKit: (vaultId) => view<VaultKit>(contractOf(), "get_vault_kit", { vault_id: vaultId }),
    async codeHash(accountId) {
      const answer = await rpc("query", {
        request_type: "view_account",
        finality: "optimistic",
        account_id: accountId,
      });
      if (answer.kind !== "result" || !isRecord(answer.result)) {
        throw new Error("view_account failed");
      }
      return String(answer.result.code_hash);
    },
    async tipHeight() {
      const answer = await rpc("block", { finality: "final" });
      const header =
        answer.kind === "result" && isRecord(answer.result) ? answer.result.header : null;
      if (!isRecord(header) || typeof header.height !== "number") {
        throw new Error("block height unreadable");
      }
      return header.height;
    },
    call: (key, plan) => sendCall(rpc, key, plan),
  };
}
