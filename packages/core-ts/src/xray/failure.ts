import type { ErrorCode } from "../contract/errors.js";
import { parseContractError } from "../contract/errors.js";
import type { AccountId } from "../contract/types.js";
import type { RpcFunctionCall, RpcOutcome, RpcReceipt, RpcTxStatus } from "./ports.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first `FunctionCall` action of an action receipt, if any. */
export function functionCall(receipt: RpcReceipt | undefined): RpcFunctionCall | null {
  for (const action of receipt?.receipt.Action?.actions ?? []) {
    if (typeof action !== "string" && action.FunctionCall) return action.FunctionCall;
  }
  return null;
}

/** `Failure.ActionError.kind.FunctionCallError` of an outcome, or undefined. */
export function functionCallError(outcome: RpcOutcome): unknown {
  const failure = outcome.outcome.status.Failure;
  if (!isRecord(failure) || !isRecord(failure.ActionError)) return undefined;
  const kind = failure.ActionError.kind;
  return isRecord(kind) ? kind.FunctionCallError : undefined;
}

/**
 * The error kind of a NEAR `Failure` as a dotted path, e.g.
 * `ActionError.FunctionCallError.ExecutionError` or `ActionError.FunctionCallError.HostError.GasExceeded`.
 * `kind` wrappers are skipped; error variants are the capitalised keys.
 */
export function failureKind(failure: unknown): string {
  const path: string[] = [];
  let node = failure;
  while (isRecord(node)) {
    if (isRecord(node.kind)) {
      node = node.kind;
      continue;
    }
    const variant = Object.keys(node).find((key) => /^[A-Z]/.test(key));
    if (variant === undefined) break;
    path.push(variant);
    node = node[variant];
  }
  if (path.length === 0 && typeof failure === "string") return failure;
  return path.join(".") || "Unknown";
}

/** Why a transaction failed: the contract's `ERR_*` code when it raised one, else null. */
export interface TxFailure {
  code: ErrorCode | null;
  /** The NEAR failure kind, e.g. `ActionError.FunctionCallError.ExecutionError`. */
  failure: string;
  /** The called method: from the failing receipt, else the transaction's first FunctionCall. */
  method: string | null;
}

/**
 * Null unless the transaction's final status is a Failure. Otherwise the failing receipt executed by `contractId` (the one
 * X-Ray's refused-call view reads), its `ERR_*` code, failure kind and method; a failure outside
 * the contract (gas, allowance, …) gives `code: null` and that failure's kind.
 */
export function txFailure(tx: RpcTxStatus, contractId: AccountId): TxFailure | null {
  const topLevel = tx.status.Failure;
  // A failed but handled intermediate receipt leaves the transaction successful.
  if (topLevel === undefined) return null;
  const contractFailure = tx.receipts_outcome.find(
    (o) => o.outcome.executor_id === contractId && functionCallError(o) !== undefined,
  );
  const anyFailure =
    contractFailure ??
    tx.receipts_outcome.find((o) => o.outcome.status.Failure !== undefined) ??
    (tx.transaction_outcome?.outcome.status.Failure !== undefined
      ? tx.transaction_outcome
      : undefined);

  const code = contractFailure
    ? (parseContractError(JSON.stringify(functionCallError(contractFailure)))?.code ?? null)
    : null;
  const failure = failureKind(anyFailure ? anyFailure.outcome.status.Failure : topLevel);
  const receipt = anyFailure ? tx.receipts.find((r) => r.receipt_id === anyFailure.id) : undefined;
  let method = functionCall(receipt)?.method_name ?? null;
  if (method === null) {
    for (const action of tx.transaction.actions) {
      if (typeof action !== "string" && action.FunctionCall) {
        method = action.FunctionCall.method_name;
        break;
      }
    }
  }
  return { code, failure, method };
}
