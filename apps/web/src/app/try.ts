// "Try with these keys": real attempts from the browser with the round's published
// function-call key. The session lives in React state only (never storage, never logged) and is
// replaced when `/round` serves a new round or key. Two attempts:
// - "Request the full balance": `request_withdrawal` of every confirmed Vault coin;
// - "Execute early": `begin_execute` on a pending request.
// Each is one `FunctionCall` signed here (core-ts/browser, no NEAR SDK) and sent with `send_tx`
// over the configured NEAR RPC. The X-Ray steps follow the transaction outcome and the Attempt
// Log feed through to the Clawback. Nothing is made up: a result that cannot be read leaves the
// steps pending.
import {
  ERROR_CODES,
  bitcoinTxUrl,
  decodeBlockHash,
  decodeSegwitAddress,
  failureKind,
  nearTxUrl,
  parseContractError,
  sealWatcherEnvelope,
  signFunctionCall,
  txFailure,
  type BtcNetwork as CoreBtcNetwork,
  type ErrorCode,
  type NearKey,
  type Outpoint,
  type RpcTxStatus,
  type SegwitAddressProblem,
} from "@morrow/core-ts/browser";
import type { XRayStep } from "@/components/XRaySteps";
import { copy } from "@/copy";
import { absoluteTime, nsToMs, type FeedEntry, type WithdrawalEntry } from "./challenge";
import type { ChallengeKeys, NearNetwork, RowLink } from "./data";
import { REQUEST_TIMEOUT_MS, withTimeout } from "./live";

/** Gas of both calls: the contract client's default for these methods. */
export const TRY_GAS = 30_000_000_000_000n;
/** Fee rate of the full-balance request. */
export const FEE_RATE_SAT_VB = 2;
/**
 * The full-balance request's amount: the input total minus a fee bound of 2 sat/vB ×
 * (60 + 250 × inputs) vB, above the contract's own vsize for a Vault spend. The request could
 * then really execute after the Delay if nobody clawed it back. Zero or less: no request.
 */
export function requestAmount(outpoints: readonly Outpoint[]): bigint {
  const total = outpoints.reduce((sum, o) => sum + BigInt(o.value_sats), 0n);
  return total - BigInt(FEE_RATE_SAT_VB) * BigInt(60 + 250 * outpoints.length);
}

/** `send_tx` waits for the receipts to execute: allow it longer than a view. */
export const SEND_TIMEOUT_MS = 60_000;

export type TryAction = "request" | "execute";

export const METHODS: Record<TryAction, string> = {
  request: "request_withdrawal",
  execute: "begin_execute",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// NEAR JSON-RPC

export type RpcAnswer =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: unknown }
  /** No answer: the network, a timeout or a body that is not JSON-RPC. */
  | { kind: "unreachable" };

export type NearRpcCall = (method: string, params: unknown) => Promise<RpcAnswer>;

/** JSON-RPC over `fetch` to `url`, each call aborted with `signal` or after its timeout. */
export function rpcOver(url: string, signal: AbortSignal): NearRpcCall {
  return async (method, params) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "morrow-try", method, params }),
        signal: withTimeout(signal, method === "send_tx" ? SEND_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.error !== undefined && body.error !== null) {
        return { kind: "error", error: body.error };
      }
      if (response.ok && isRecord(body) && "result" in body) {
        return { kind: "result", result: body.result };
      }
      return { kind: "unreachable" };
    } catch {
      return { kind: "unreachable" };
    }
  };
}

/** What an RPC error means for an attempt. */
export function rpcErrorKind(error: unknown): "nonce" | "spent" | "timeout" | "other" {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (/InvalidNonce/.test(text)) return "nonce";
  // Access-key errors only: a missing account (`UNKNOWN_ACCOUNT`) is not a spent key.
  if (
    /NotEnoughAllowance|AccessKeyNotFound|UNKNOWN_ACCESS_KEY|access key \S+ does not exist/i.test(
      text,
    )
  ) {
    return "spent";
  }
  if (/TIMEOUT_ERROR/.test(text)) return "timeout";
  return "other";
}

// Outcomes

export type TryOutcome =
  /** The contract took the call: the op id (a request's) and when it may execute. */
  | { kind: "accepted"; opId: string | null; executableAt: string | null }
  /** The contract or NEAR refused it: the `ERR_*` code, else the raw failure kind. */
  | { kind: "refused"; code: ErrorCode | null; failure: string; onChain: boolean }
  /** NEAR did not answer before anything was sent. */
  | { kind: "unreachable" }
  /** Sent, but its result could not be read. */
  | { kind: "unreadable" }
  /** The published key is out of allowance, or gone: a fresh one is being published. */
  | { kind: "spent" }
  /** `InvalidNonce` twice: other visitors kept using the key. */
  | { kind: "nonce" };

function decodeBase64Json(text: string): unknown {
  if (text === "") return null;
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

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
    if (Array.isArray(lines)) logs.push(...lines.filter((l): l is string => typeof l === "string"));
  }
  return logs;
}

/** The `withdrawal_requested` payload of the transaction's `EVENT_JSON` logs, if any. */
export function requestedEvent(
  result: Record<string, unknown>,
): { opId: string; executableAt: string | null } | null {
  for (const line of logsOf(result)) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(line.slice("EVENT_JSON:".length)) as unknown;
      if (!isRecord(event) || event.event !== "withdrawal_requested") continue;
      const data = Array.isArray(event.data) ? (event.data[0] as unknown) : null;
      const payload = isRecord(data) ? data.payload : null;
      if (!isRecord(payload) || typeof payload.op_id !== "string") continue;
      const at = payload.executable_at;
      return {
        opId: payload.op_id,
        executableAt: typeof at === "string" && /^\d{1,30}$/.test(at) ? at : null,
      };
    } catch {
      // Not JSON: not ours.
    }
  }
  return null;
}

/** Reads a `send_tx` result: accepted or refused, else unreadable. Never guesses. */
export function readOutcome(result: unknown, contractId: string, action: TryAction): TryOutcome {
  if (!isRecord(result) || !isRecord(result.status)) return { kind: "unreadable" };
  const status = result.status;
  if (status.Failure !== undefined) {
    if (rpcErrorKind(status.Failure) === "spent") return { kind: "spent" };
    let failure: { code: ErrorCode | null; failure: string } | null;
    try {
      // `send_tx` results carry no `receipts`; the method comes from the call itself.
      const tx = {
        ...result,
        receipts: Array.isArray(result.receipts) ? result.receipts : [],
      } as unknown as RpcTxStatus;
      failure = txFailure(tx, contractId);
    } catch {
      failure = null;
    }
    return {
      kind: "refused",
      code: failure?.code ?? parseContractError(JSON.stringify(status.Failure))?.code ?? null,
      failure: failure?.failure ?? failureKind(status.Failure),
      onChain: true,
    };
  }
  if (typeof status.SuccessValue !== "string") return { kind: "unreadable" };
  const value = decodeBase64Json(status.SuccessValue);
  const event = requestedEvent(result);
  if (action === "request") {
    const opId = typeof value === "string" && /^\d+$/.test(value) ? value : (event?.opId ?? null);
    return { kind: "accepted", opId, executableAt: event?.executableAt ?? null };
  }
  return { kind: "accepted", opId: null, executableAt: null };
}

// Sending

export interface CallPlan {
  signerId: string;
  receiverId: string;
  method: string;
  args: object;
}

export type SendResult =
  { kind: "outcome"; outcome: TryOutcome } | { kind: "sent"; hash: string; result: unknown };

/**
 * Signs and sends one call: nonce from `view_access_key` + 1, block hash from the final block,
 * `send_tx` waiting for `EXECUTED_OPTIMISTIC`. On `InvalidNonce` (visitors share one key) it
 * retries once with a fresh nonce. `onSigned` gets the hash of each transaction sent.
 */
export async function sendCall(
  rpc: NearRpcCall,
  key: NearKey,
  plan: CallPlan,
  onSigned: (hash: string) => void,
): Promise<SendResult> {
  /** The nonce another visitor's transaction already used, from an `InvalidNonce` answer. */
  let taken = -1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: plan.signerId,
      public_key: key.publicKeyString,
    });
    if (access.kind === "unreachable") return { kind: "outcome", outcome: { kind: "unreachable" } };
    if (access.kind === "error") {
      return {
        kind: "outcome",
        outcome: { kind: rpcErrorKind(access.error) === "spent" ? "spent" : "unreachable" },
      };
    }
    const accessKey = access.result;
    // Older nodes answer a missing key with a result that carries an `error` text.
    if (isRecord(accessKey) && typeof accessKey.error === "string") {
      return {
        kind: "outcome",
        outcome: { kind: rpcErrorKind(accessKey.error) === "spent" ? "spent" : "unreachable" },
      };
    }
    const nonce = isRecord(accessKey) ? accessKey.nonce : undefined;
    if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) {
      return { kind: "outcome", outcome: { kind: "unreachable" } };
    }
    const block = await rpc("block", { finality: "final" });
    const header = block.kind === "result" && isRecord(block.result) ? block.result.header : null;
    if (!isRecord(header) || typeof header.hash !== "string") {
      return { kind: "outcome", outcome: { kind: "unreachable" } };
    }
    let blockHash: Uint8Array;
    try {
      blockHash = decodeBlockHash(header.hash);
    } catch {
      return { kind: "outcome", outcome: { kind: "unreachable" } };
    }
    const signed = signFunctionCall(
      {
        signerId: plan.signerId,
        receiverId: plan.receiverId,
        // `final` lags the optimistic nonce a competing transaction used: never go below it.
        nonce: BigInt(Math.max(nonce, taken)) + 1n,
        blockHash,
        methodName: plan.method,
        args: plan.args,
        gas: TRY_GAS,
        deposit: 0n,
      },
      key,
    );
    onSigned(signed.hash);
    const sent = await rpc("send_tx", {
      signed_tx_base64: signed.signedBase64,
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    if (sent.kind === "result") return { kind: "sent", hash: signed.hash, result: sent.result };
    if (sent.kind === "unreachable") return { kind: "outcome", outcome: { kind: "unreadable" } };
    const kind = rpcErrorKind(sent.error);
    if (kind === "nonce") {
      taken = Math.max(taken, akNonceOf(sent.error) ?? -1);
      if (attempt === 0) continue;
      return { kind: "outcome", outcome: { kind: "nonce" } };
    }
    if (kind === "spent") return { kind: "outcome", outcome: { kind: "spent" } };
    const error = sent.error;
    // Only an invalid transaction is known never to have reached the chain. Anything else
    // (a timeout, an internal error after forwarding) may have landed.
    const invalid =
      (isRecord(error) && isRecord(error.cause) && error.cause.name === "INVALID_TRANSACTION") ||
      /InvalidTxError/.test(JSON.stringify(error));
    if (kind === "timeout" || !invalid) {
      return { kind: "outcome", outcome: { kind: "unreadable" } };
    }
    const detail = isRecord(error) && error.data !== undefined ? error.data : error;
    return {
      kind: "outcome",
      outcome: { kind: "refused", code: null, failure: failureKind(detail), onChain: false },
    };
  }
  return { kind: "outcome", outcome: { kind: "nonce" } };
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

// Session state

export interface TryAttempt {
  id: number;
  action: TryAction;
  /** When the button was pressed (ms). */
  startedAt: number;
  /** The hash of the transaction sent; null until it is signed. */
  hash: string | null;
  /** Null while in flight. */
  outcome: TryOutcome | null;
}

export interface TryState {
  /** The round and key this session belongs to. */
  sessionId: string | null;
  /** A fresh P2WPKH address made in this browser; the default destination. */
  randomDestination: string;
  destination: string;
  /** Set when an attempt was refused here because of the destination: nothing was signed. */
  destinationProblem: SegwitAddressProblem | null;
  attempt: TryAttempt | null;
  /** The op id of this session's own accepted request: Early Execute's first target. */
  ownOpId: string | null;
  /** The key is out of allowance: wait for `/round` to publish a fresh one. */
  spent: boolean;
  /** A step that could not run (e.g. the envelope could not be sealed). */
  problem: "seal" | null;
}

export const EMPTY_TRY: TryState = {
  sessionId: null,
  randomDestination: "",
  destination: "",
  destinationProblem: null,
  attempt: null,
  ownOpId: null,
  spent: false,
  problem: null,
};

export type TryEvent =
  | { type: "reset"; sessionId: string; randomDestination: string }
  | { type: "destination"; value: string }
  | { type: "refuse-destination"; problem: SegwitAddressProblem }
  | { type: "problem"; problem: "seal" }
  | { type: "start"; id: number; action: TryAction; at: number }
  | { type: "signed"; id: number; hash: string }
  | { type: "settled"; id: number; outcome: TryOutcome };

export function tryReducer(state: TryState, event: TryEvent): TryState {
  switch (event.type) {
    case "reset":
      return {
        ...EMPTY_TRY,
        sessionId: event.sessionId,
        randomDestination: event.randomDestination,
        destination: event.randomDestination,
      };
    case "destination":
      return { ...state, destination: event.value, destinationProblem: null };
    case "refuse-destination":
      return { ...state, destinationProblem: event.problem };
    case "problem":
      return { ...state, problem: event.problem };
    case "start":
      // One attempt at a time.
      if (state.attempt !== null && state.attempt.outcome === null) return state;
      return {
        ...state,
        destinationProblem: null,
        problem: null,
        attempt: {
          id: event.id,
          action: event.action,
          startedAt: event.at,
          hash: null,
          outcome: null,
        },
      };
    case "signed":
      if (state.attempt?.id !== event.id) return state;
      return { ...state, attempt: { ...state.attempt, hash: event.hash } };
    case "settled": {
      if (state.attempt?.id !== event.id) return state;
      const { outcome } = event;
      const attempt = { ...state.attempt, outcome };
      const ownOpId =
        attempt.action === "request" && outcome.kind === "accepted" && outcome.opId !== null
          ? outcome.opId
          : state.ownOpId;
      return { ...state, attempt, ownOpId, spent: state.spent || outcome.kind === "spent" };
    }
  }
}

// What the panel shows

/** Everything the session needs from the deployment and the feed. */
export interface TryInputs {
  keys: ChallengeKeys;
  /** The parsed published key; null when it cannot be read. */
  key: NearKey | null;
  btc: CoreBtcNetwork;
  near: NearNetwork;
  rpcUrl: string | null;
  /** Confirmed Vault coins; null until the Bitcoin backend answers. */
  outpoints: readonly Outpoint[] | null;
  /** Every coin at the Vault Address, confirmed or not; null until the backend answers. */
  balanceSats: number | null;
  /** `undefined` until `get_vault` answers, null when it has no readable watcher key. */
  watcherPk: string | null | undefined;
  /** The Attempt Log feed, newest first; null until it answers. */
  entries: readonly FeedEntry[] | null;
}

export interface Availability {
  enabled: boolean;
  /** Why the action is disabled; null when enabled or only busy. */
  reason: string | null;
}

export interface TryView {
  destination: string;
  /** The destination is the address made in this browser. */
  isRandom: boolean;
  destinationError: string | null;
  request: Availability;
  execute: Availability & { target: string | null };
  busy: boolean;
  /** One line about the last attempt or the key, when there is something to say. */
  notice: { tone: "neutral" | "alarm"; text: string } | null;
  /** True once an attempt was made in this session. */
  started: boolean;
  /** The latest attempt's id: a new attempt is announced even with the same words. */
  attemptId: number | null;
  steps: readonly XRayStep[];
  links: { near: RowLink | null; bitcoin: RowLink | null };
  /** The latest step that lit (or the notice), for the polite live region. */
  announcement: string;
  /** Step 4 is counting seconds: the page ticks its clock every second. */
  waiting: boolean;
}

const short = (hash: string) => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash);

/** The round's withdrawal with `opId` in the feed. */
function withdrawalOf(
  entries: readonly FeedEntry[] | null,
  vaultId: string | null,
  opId: string | null,
): WithdrawalEntry | null {
  if (opId === null || entries === null) return null;
  for (const entry of entries) {
    if (entry.type === "withdrawal" && entry.op_id === opId && entry.vault_id === vaultId) {
      return entry;
    }
  }
  return null;
}

/**
 * The latest attempt's outcome, reconciled with the feed: a request whose result could not be
 * read is accepted once a feed withdrawal carries its transaction hash.
 */
export function settledOutcome(state: TryState, inputs: TryInputs): TryOutcome | null {
  const attempt = state.attempt;
  const outcome = attempt?.outcome ?? null;
  if (outcome?.kind !== "unreadable" || attempt?.action !== "request" || attempt.hash === null) {
    return outcome;
  }
  for (const entry of inputs.entries ?? []) {
    if (
      entry.type === "withdrawal" &&
      entry.tx_hash === attempt.hash &&
      entry.vault_id === inputs.keys.vault_id
    ) {
      return { kind: "accepted", opId: entry.op_id, executableAt: entry.executable_at };
    }
  }
  return outcome;
}

/** This session's own request's op id, if known (from its result or from the feed). */
function ownOpId(state: TryState, inputs: TryInputs): string | null {
  if (state.ownOpId !== null) return state.ownOpId;
  const outcome = settledOutcome(state, inputs);
  return outcome?.kind === "accepted" && state.attempt?.action === "request" ? outcome.opId : null;
}

/** This session's own request, while it is (as far as the feed knows) still pending. */
function ownPending(state: TryState, inputs: TryInputs): string | null {
  const opId = ownOpId(state, inputs);
  if (opId === null) return null;
  const own = withdrawalOf(inputs.entries, inputs.keys.vault_id, opId);
  return own === null || own.outcome === "pending" ? opId : null;
}

/** Early Execute's target: this session's own pending request, else the newest pending one. */
export function executeTarget(state: TryState, inputs: TryInputs): string | null {
  const vaultId = inputs.keys.vault_id;
  const own = ownPending(state, inputs);
  if (own !== null) return own;
  for (const entry of inputs.entries ?? []) {
    if (
      entry.type === "withdrawal" &&
      entry.round === inputs.keys.round &&
      entry.vault_id === vaultId &&
      entry.outcome === "pending"
    ) {
      return entry.op_id;
    }
  }
  return null;
}

/** A blocker shared by both actions, if any. */
function sessionBlocker(state: TryState, inputs: TryInputs): string | null {
  const t = copy.tryKeys.reasons;
  if (inputs.near === "mock" || inputs.rpcUrl === null) return t.noRpc;
  if (inputs.key === null) return t.badKey;
  if (state.spent) return t.spent;
  if (inputs.keys.vault_id === null) return t.noVault;
  if (inputs.watcherPk === undefined) return t.readingWatcher;
  if (inputs.watcherPk === null) return t.noWatcher;
  return null;
}

function contractStep(
  attempt: TryAttempt,
  outcome: TryOutcome | null,
  executableAt: string | null,
  now: number,
): XRayStep {
  const t = copy.tryKeys.steps;
  if (outcome?.kind === "accepted") {
    return {
      title: t.rule,
      detail:
        attempt.action === "execute"
          ? t.executeAccepted
          : executableAt === null
            ? t.accepted
            : t.acceptedAt(absoluteTime(nsToMs(executableAt), now)),
      state: "done",
    };
  }
  if (outcome?.kind === "refused") {
    return {
      title: t.rule,
      detail:
        outcome.code === null
          ? t.refused(outcome.failure, null)
          : t.refused(outcome.code, ERROR_CODES[outcome.code]),
      state: "refused",
    };
  }
  if (outcome === null) return { title: t.rule, detail: t.ruleWaiting, state: "pending" };
  return { title: t.rule, detail: t.ruleUnknown, state: "pending" };
}

/** What the Try panel and the X-Ray show for `state` and `inputs` at `now`. Pure. */
export function tryView(state: TryState, inputs: TryInputs, now: number): TryView {
  const t = copy.tryKeys;
  const attempt = state.attempt;
  const busy = attempt !== null && attempt.outcome === null;
  const blocker = sessionBlocker(state, inputs);
  const target = executeTarget(state, inputs);

  let requestReason = blocker;
  if (requestReason === null) {
    if (inputs.outpoints === null) requestReason = t.reasons.readingCoins;
    else if (inputs.outpoints.length === 0) {
      requestReason =
        inputs.balanceSats !== null && inputs.balanceSats > 0
          ? t.reasons.unconfirmed
          : t.reasons.noCoins;
    } else if (requestAmount(inputs.outpoints) <= 0n) requestReason = t.reasons.belowFee;
    // A second request would only meet ERR_OUTPOINT_RESERVED and spend the shared allowance.
    else if (ownPending(state, inputs) !== null) requestReason = t.reasons.ownPending;
  }
  const executeReason = blocker ?? (target === null ? t.reasons.noPending : null);

  const destinationError =
    state.destinationProblem === null ? null : t.destinationProblem[state.destinationProblem];

  // X-Ray steps.
  const outcome = settledOutcome(state, inputs);
  const method = attempt ? METHODS[attempt.action] : null;
  const steps: XRayStep[] = [];
  let bitcoinLink: RowLink | null = null;
  let waiting = false;
  if (attempt === null || method === null) {
    steps.push(
      { title: t.steps.request, detail: t.steps.requestIdle, state: "pending" },
      { title: t.steps.rule, detail: t.steps.ruleIdle, state: "pending" },
      { title: t.steps.mpc, detail: t.steps.mpcIdle, state: "pending" },
      { title: t.steps.bitcoin, detail: t.steps.bitcoinIdle, state: "pending" },
    );
  } else {
    const sentNothing =
      outcome?.kind === "unreachable" ||
      outcome?.kind === "spent" ||
      outcome?.kind === "nonce" ||
      (outcome?.kind === "refused" && !outcome.onChain);
    steps.push({
      title: t.steps.request,
      detail:
        attempt.hash === null || sentNothing
          ? `${method} · ${outcome === null ? t.steps.signing : t.steps.notSent}`
          : `${method} · ${short(attempt.hash)}`,
      state: attempt.hash !== null && !sentNothing ? "done" : "pending",
    });
    const own =
      outcome?.kind === "accepted" && attempt.action === "request"
        ? withdrawalOf(inputs.entries, inputs.keys.vault_id, outcome.opId)
        : null;
    if (sentNothing) {
      steps.push(
        { title: t.steps.rule, detail: t.steps.ruleUnknown, state: "pending" },
        { title: t.steps.mpc, detail: "", state: "pending" },
        { title: t.steps.bitcoin, detail: "", state: "pending" },
      );
    } else {
      const executableAt =
        outcome?.kind === "accepted" ? (outcome.executableAt ?? own?.executable_at ?? null) : null;
      steps.push(contractStep(attempt, outcome, executableAt, now));
      if (outcome?.kind === "refused") {
        // A refused attempt stops at the contract rule.
        steps.push(
          { title: t.steps.mpc, detail: "", state: "unreached" },
          { title: t.steps.bitcoin, detail: "", state: "unreached" },
        );
      } else if (outcome?.kind === "accepted" && attempt.action === "execute") {
        // Not expected before the Delay: the contract now asks the MPC network to co-sign.
        steps.push(
          { title: t.steps.mpc, detail: t.steps.mpcAsked, state: "pending" },
          { title: t.steps.bitcoin, detail: "", state: "pending" },
        );
      } else if (outcome?.kind === "accepted") {
        steps.push({ title: t.steps.mpc, detail: t.steps.mpcAfterDelay, state: "unreached" });
        if (outcome.opId === null) {
          // Nothing to follow in the feed: no endless counter.
          steps.push({ title: t.steps.bitcoin, detail: t.steps.noOpId, state: "pending" });
        } else if (
          own !== null &&
          own.outcome === "clawed_back" &&
          own.clawback_broadcast &&
          own.clawback_txid !== null &&
          own.outcome_at !== null
        ) {
          const seconds = Math.max(
            0,
            Math.round(Number(BigInt(own.outcome_at) - BigInt(own.requested_at)) / 1e9),
          );
          steps.push({
            title: t.steps.bitcoin,
            detail: t.steps.clawedBack(seconds, short(own.clawback_txid)),
            state: "ok",
          });
          const href = bitcoinTxUrl(inputs.btc, own.clawback_txid);
          if (href !== null) {
            bitcoinLink = { href, text: t.links.bitcoin, label: t.links.bitcoinLabel };
          }
        } else if (own?.outcome === "signed") {
          steps.push({
            title: t.steps.bitcoin,
            detail: copy.attemptLog.outcome.signed,
            state: "refused",
          });
        } else if (own?.outcome === "cancelled") {
          steps.push({
            title: t.steps.bitcoin,
            detail: copy.attemptLog.outcome.cancelled,
            state: "done",
          });
        } else {
          waiting = true;
          steps.push({
            title: t.steps.bitcoin,
            detail: t.steps.waiting(Math.max(0, Math.floor((now - attempt.startedAt) / 1000))),
            state: "pending",
          });
        }
      } else {
        steps.push(
          { title: t.steps.mpc, detail: "", state: "pending" },
          { title: t.steps.bitcoin, detail: "", state: "pending" },
        );
      }
    }
  }

  // The notice: one line about the last attempt or the key.
  // A spent key says so once, as the buttons' reason.
  let notice: TryView["notice"] = null;
  if (state.spent) notice = null;
  else if (state.problem === "seal") notice = { tone: "alarm", text: t.notice.seal };
  else if (outcome?.kind === "refused" && !outcome.onChain) {
    notice = { tone: "alarm", text: t.notice.invalidTx(outcome.failure) };
  } else if (outcome?.kind === "unreachable")
    notice = { tone: "alarm", text: t.notice.unreachable };
  else if (outcome?.kind === "unreadable") notice = { tone: "neutral", text: t.notice.unreadable };
  else if (outcome?.kind === "nonce") notice = { tone: "alarm", text: t.notice.nonce };

  const nearLink: RowLink | null =
    attempt?.hash != null && inputs.near !== "mock" && steps[0]?.state === "done"
      ? { href: nearTxUrl(inputs.near, attempt.hash), text: t.links.near, label: t.links.nearLabel }
      : null;

  const lit = steps.filter(
    (step) => step.state === "done" || step.state === "refused" || step.state === "ok",
  );
  const last = lit[lit.length - 1];
  const announcement =
    notice?.text ??
    (state.spent
      ? t.reasons.spent
      : attempt !== null && last
        ? t.announce(last.title, last.detail)
        : "");

  return {
    destination: state.destination,
    isRandom: state.destination !== "" && state.destination === state.randomDestination,
    destinationError,
    request: { enabled: !busy && requestReason === null, reason: requestReason },
    execute: { enabled: !busy && executeReason === null, reason: executeReason, target },
    busy,
    notice,
    started: attempt !== null,
    attemptId: attempt?.id ?? null,
    steps,
    links: { near: nearLink, bitcoin: bitcoinLink },
    announcement,
    waiting,
  };
}

/**
 * The call for `action`, or why it cannot be made. Nothing is signed before the destination is
 * valid for the deployment's network and the envelope is sealed.
 */
export function planCall(
  action: TryAction,
  destination: string,
  state: TryState,
  inputs: TryInputs,
):
  | { ok: true; plan: CallPlan }
  | { ok: false; problem: SegwitAddressProblem | "seal" | "unavailable" } {
  const view = tryView(state, inputs, 0);
  const availability = action === "request" ? view.request : view.execute;
  const vaultId = inputs.keys.vault_id;
  if (!availability.enabled || vaultId === null || !inputs.watcherPk) {
    return { ok: false, problem: "unavailable" };
  }
  const base = { signerId: inputs.keys.owner_account, receiverId: inputs.keys.vault_contract };
  if (action === "request") {
    const decoded = decodeSegwitAddress(destination, inputs.btc);
    if (!decoded.ok) return { ok: false, problem: decoded.problem };
    const outpoints = inputs.outpoints ?? [];
    let envelope: string;
    try {
      envelope = sealWatcherEnvelope("normal", inputs.watcherPk);
    } catch {
      return { ok: false, problem: "seal" };
    }
    const amount = requestAmount(outpoints);
    if (amount <= 0n) return { ok: false, problem: "unavailable" };
    return {
      ok: true,
      plan: {
        ...base,
        method: METHODS.request,
        args: {
          vault_id: vaultId,
          amount_sats: amount.toString(),
          destination: destination.trim(),
          fee_rate_sat_vb: FEE_RATE_SAT_VB,
          utxos: outpoints.map((o) => ({ txid: o.txid, vout: o.vout, value_sats: o.value_sats })),
          envelope,
        },
      },
    };
  }
  const target = view.execute.target;
  if (target === null) return { ok: false, problem: "unavailable" };
  let envelope: string;
  try {
    envelope = sealWatcherEnvelope("normal", inputs.watcherPk);
  } catch {
    return { ok: false, problem: "seal" };
  }
  return {
    ok: true,
    plan: { ...base, method: METHODS.execute, args: { op_id: target, envelope } },
  };
}

/** Sends a planned call and reads its outcome. */
export async function runCall(
  rpc: NearRpcCall,
  key: NearKey,
  action: TryAction,
  plan: CallPlan,
  onSigned: (hash: string) => void,
): Promise<TryOutcome> {
  const sent = await sendCall(rpc, key, plan, onSigned);
  if (sent.kind === "outcome") return sent.outcome;
  return readOutcome(sent.result, plan.receiverId, action);
}
