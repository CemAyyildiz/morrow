// X-Ray (story 6.4): one op, or one refused call, through its four stages — Bitcoin script path,
// Vault Contract rule, NEAR MPC signature, Bitcoin transaction — assembled by core-ts
// `buildXRay` in this browser from chain data only, like the Proof Page: no server, no cache.
// Here: the reads `buildXRay` is handed (contract views over the NEAR
// RPC, the archival RPC, the FastNEAR transaction indexer and the Esplora backend) and the pure
// view model the page draws. The view model only formats what `buildXRay` returned: every row
// keeps its value's source ref and explorer link, and no rule is re-derived here.
import {
  FastNearLocator,
  FetchNearRpc,
  XRayInputError,
  buildXRay,
  bytesToHex,
  decodeScript,
  hexToBytes,
  p2wshAddress,
  parseContractError,
  scriptPaths,
  type MorrowEvent,
  type MpcInput,
  type ScriptPath,
  type Sourced,
  type SpendOp,
  type StageStatus,
  type VaultKit,
  type XRay,
  type XRayDeps,
  type XRayInput,
} from "@morrow/core-ts/browser";
import { copy } from "@/copy";
import { absoluteTime, nsToMs } from "./challenge";
import type { AppConfig } from "./data";
import { withTimeout } from "./live";
import { proofRpc, type ProofRpc } from "./proof";
import type { XRayTarget } from "./xray-paths";

const x = copy.xrayPage;

/** How often an X-Ray with a stage still waiting is read again. */
export const XRAY_POLL_MS = 10_000;
/**
 * How often an op still Pending or Frozen, with no stage waiting, is read again: a whole Delay
 * of 10 s rebuilds (30+ RPC calls each) would meet the free RPCs' rate limits.
 */
export const XRAY_SLOW_POLL_MS = 60_000;
/** The pause between two stages lighting up. */
export const REVEAL_STEP_MS = 450;

// Routes: xray-paths.ts, re-exported here.

export * from "./xray-paths";

export function xrayInput(target: XRayTarget): XRayInput {
  if (target.kind === "op") return { opId: target.opId };
  return {
    refusedTx:
      target.sender === null
        ? { hash: target.hash }
        : { hash: target.hash, senderId: target.sender },
  };
}

// Reads

/** What X-Ray reads from, or null where it cannot run (the mock contract, no URLs). */
export interface XRayEndpoints {
  contractId: string;
  near: "testnet" | "mainnet";
  rpcUrl: string;
  archivalUrl: string;
  indexerUrl: string;
  btcBackendUrl: string;
}

export function xrayEndpoints(
  config: Pick<
    AppConfig,
    | "network"
    | "contractId"
    | "nearRpcUrl"
    | "nearArchivalRpcUrl"
    | "nearTxIndexerUrl"
    | "btcBackendUrl"
  >,
): XRayEndpoints | null {
  const near = config.network.near;
  if (near === "mock") return null;
  const archivalUrl = config.nearArchivalRpcUrl;
  const indexerUrl = config.nearTxIndexerUrl;
  if (archivalUrl === null || indexerUrl === null) return null;
  return {
    contractId: config.contractId,
    near,
    rpcUrl: config.nearRpcUrl ?? archivalUrl,
    archivalUrl,
    indexerUrl,
    btcBackendUrl: config.btcBackendUrl,
  };
}

/** The node did not answer, or answered something else: the read failed. */
export class XRayReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XRayReadError";
  }
}

/**
 * A signal aborted when `a` or `b` is, and `release`, which removes its listeners from both.
 * By hand: `AbortSignal.any` needs Safari 17.4.
 */
function eitherSignal(
  a: AbortSignal,
  b: AbortSignal,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  const release = () => {
    a.removeEventListener("abort", abort);
    b.removeEventListener("abort", abort);
  };
  return { signal: controller.signal, release };
}

/**
 * `fetch` that also stops when `signal` aborts (the page left or the op changed). An arrow over
 * the global `fetch`: core-ts calls it as a method, which a bare `fetch` refuses. A request
 * with its own signal leaves no listener on `signal` once it settles: a live X-Ray re-reads for
 * hours.
 */
export function boundFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => {
    if (!init?.signal) return fetch(input, { ...init, signal });
    const both = eitherSignal(init.signal, signal);
    return fetch(input, { ...init, signal: both.signal }).finally(both.release);
  };
}

/** `get_op`, `get_vault_kit` and `events_since` over the NEAR RPC; contract panics throw their `ERR_*`. */
export function contractOver(rpc: ProofRpc): XRayDeps["contract"] {
  const view = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    const answer = await rpc.view(method, args);
    if (answer.kind === "ok") return answer.value;
    if (answer.kind === "error") {
      throw parseContractError(answer.text) ?? new XRayReadError(`${method}: ${answer.text}`);
    }
    throw new XRayReadError(`${method}: no answer`);
  };
  const record = <T>(value: unknown, method: string): T => {
    if (typeof value !== "object" || value === null) {
      throw new XRayReadError(`${method}: not an object`);
    }
    return value as T;
  };
  return {
    getOp: async (opId) => record<SpendOp>(await view("get_op", { op_id: opId }), "get_op"),
    getVaultKit: async (vaultId) =>
      record<VaultKit>(await view("get_vault_kit", { vault_id: vaultId }), "get_vault_kit"),
    eventsSince: async (cursor, limit) => {
      const events = await view("events_since", { cursor, limit });
      if (!Array.isArray(events)) throw new XRayReadError("events_since: not a list");
      return events as MorrowEvent[];
    },
  };
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

/**
 * `getTx` over Esplora: `/tx/<txid>/status`, `/blocks/tip/height` for confirmations, and
 * `/tx/<txid>` to tell an unconfirmed transaction from an unknown one (null).
 */
export function esploraGetTx(btcBackendUrl: string, signal: AbortSignal): XRayDeps["bitcoin"] {
  const get = async (path: string) => {
    const response = await fetch(join(btcBackendUrl, path), {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    return response;
  };
  return {
    async getTx(txid) {
      const response = await get(`/tx/${txid}/status`);
      if (response.status === 404) return null;
      if (!response.ok) throw new XRayReadError(`Bitcoin backend: HTTP ${response.status}`);
      const status = (await response.json()) as { confirmed?: unknown; block_height?: unknown };
      if (status.confirmed === true && typeof status.block_height !== "number") {
        throw new XRayReadError("Bitcoin backend: confirmed without a block height");
      }
      if (status.confirmed !== true || typeof status.block_height !== "number") {
        // mempool.space answers `{confirmed: false}` for a txid it has never seen: only
        // `/tx/<txid>` tells a mempool transaction (200) from an unknown one (404).
        const known = await get(`/tx/${txid}`);
        if (known.status === 404) return null;
        if (!known.ok) throw new XRayReadError(`Bitcoin backend: HTTP ${known.status}`);
        return { txid, confirmations: 0, block_height: null };
      }
      const tip = await get("/blocks/tip/height");
      const text = (await tip.text()).trim();
      if (!tip.ok || !/^\d{1,9}$/.test(text))
        throw new XRayReadError("Bitcoin backend: tip height");
      return {
        txid,
        // A tip node lagging the one that answered `/status` must not unconfirm the tx.
        confirmations: Math.max(1, Number(text) - status.block_height + 1),
        block_height: status.block_height,
      };
    },
  };
}

/** Everything `buildXRay` reads, bound to one deployment and aborted with `signal`. */
export function xrayDeps(endpoints: XRayEndpoints, signal: AbortSignal): XRayDeps {
  const fetchFn = boundFetch(signal);
  return {
    contract: contractOver(proofRpc(endpoints.rpcUrl, endpoints.contractId, signal)),
    contractId: endpoints.contractId,
    nearNetwork: endpoints.near,
    rpc: new FetchNearRpc(endpoints.archivalUrl, fetchFn),
    locator: new FastNearLocator({
      network: endpoints.near,
      baseUrl: endpoints.indexerUrl,
      fetch: fetchFn,
      log: () => undefined,
    }),
    bitcoin: esploraGetTx(endpoints.btcBackendUrl, signal),
    log: () => undefined,
  };
}

/** What one read came to. */
export type XRayAnswer =
  | { kind: "ok"; xray: XRay }
  /** The input names no op of this contract, or no refused call to it (`XRayInputError`). */
  | { kind: "input"; message: string }
  | { kind: "unreachable" };

export async function readXRay(
  target: XRayTarget,
  read: (input: XRayInput) => Promise<XRay>,
): Promise<XRayAnswer> {
  try {
    return { kind: "ok", xray: await read(xrayInput(target)) };
  } catch (error) {
    if (error instanceof XRayInputError) return { kind: "input", message: error.message };
    return { kind: "unreachable" };
  }
}

/** Reads `target` over `endpoints` with `buildXRay`. */
export const fetchXRay = (endpoints: XRayEndpoints, target: XRayTarget, signal: AbortSignal) =>
  readXRay(target, (input) => buildXRay(input, xrayDeps(endpoints, signal)));

// View model

/**
 * `lit` for a stage done, `ok` for a confirmed Bitcoin transaction, `waiting` (dimmed) for one
 * still pending, `alarm` for refused or failed, `unreached` (dimmed) for one not reached.
 */
export type StageTone = "lit" | "ok" | "waiting" | "alarm" | "unreached";

/** One value on screen, with the exact call it came from and its explorer link. */
export interface XRayRow {
  label: string;
  value: string;
  url: string | null;
  /** The source ref: the call and the field the value was taken from. Never empty. */
  ref: string;
  /** An identifier (hash, hex, account): monospace, wrapped. */
  mono: boolean;
}

/** A titled set of rows: one event (stage 2) or one input (stage 3). */
export interface RowGroup {
  title: string;
  rows: XRayRow[];
  tone: StageTone;
  note: string | null;
}

/** One element of the op's script, decoded in this browser. */
export interface ScriptLine {
  offset: number;
  name: string;
  data: string | null;
  path: ScriptPath | null;
  /** On the path the op spends through. */
  onPath: boolean;
}

export interface DecodedScript {
  bytes: number;
  lines: ScriptLine[];
  ref: string;
}

export type StageId = "script" | "rule" | "mpc" | "bitcoin";

export interface StageView {
  id: StageId;
  n: number;
  title: string;
  status: StageStatus;
  tone: StageTone;
  statusText: string;
  headline: string;
  /** A one-line mono summary under the headline (the refused rule), or null. */
  detail: string | null;
  rows: XRayRow[];
  groups: RowGroup[];
  script: DecodedScript | null;
  /** Whether the address recomputed here matches the kit's; null when not recomputed. */
  addressMatch: boolean | null;
  /** The stage's distinct source refs, in order. */
  sources: string[];
}

export interface XRayModel {
  stages: StageView[];
  /** How many stages light up: up to and including the first one still waiting. */
  reveal: number;
  /** When the page reads again (`pollDelay`), in ms; null once nothing can change. */
  pollMs: number | null;
  chips: string[];
}

const toneOf = (status: StageStatus, confirmed = false): StageTone =>
  status === "done"
    ? confirmed
      ? "ok"
      : "lit"
    : status === "pending"
      ? "waiting"
      : status === "not_reached"
        ? "unreached"
        : "alarm";

const statusTextOf = (status: StageStatus, tone: StageTone) =>
  tone === "ok" ? x.status.ok : x.status[status];

/** A ns field as an absolute time. */
const timeOf = (ns: string, now: number) => absoluteTime(nsToMs(ns), now);

const isNs = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,20}$/.test(value);

function row<T>(
  label: string,
  sourced: Sourced<T> | null | undefined,
  format: (value: T) => string = String,
  mono = true,
): XRayRow | null {
  if (!sourced) return null;
  return {
    label,
    value: format(sourced.value),
    url: sourced.source.url,
    ref: sourced.source.ref,
    mono,
  };
}

const rows = (...items: (XRayRow | null)[]): XRayRow[] =>
  items.filter((item): item is XRayRow => item !== null);

function distinctRefs(...lists: XRayRow[][]): string[] {
  return [...new Set(lists.flat().map((r) => r.ref))];
}

const json = (value: unknown) => JSON.stringify(value);

function scriptStage(xray: XRay): StageView {
  const s = xray.script;
  const tone = toneOf(s.status);
  const path = s.path?.value ?? null;
  const pathName = path === null ? "" : x.paths[path];
  const coinName = s.coinSource ? x.coinSources[s.coinSource.value] : "";
  const r = x.script.rows;

  let script: DecodedScript | null = null;
  let recomputed: XRayRow | null = null;
  let addressMatch: boolean | null = null;
  if (s.scriptHex) {
    try {
      const bytes = hexToBytes(s.scriptHex.value);
      const ops = decodeScript(bytes);
      const paths = scriptPaths(ops);
      script = {
        bytes: bytes.length,
        ref: x.script.decodedRef(s.scriptHex.source.ref),
        lines: ops.map((op, index) => ({
          offset: op.offset,
          name: op.name,
          data: op.kind === "push" ? bytesToHex(op.data) : null,
          path: paths[index] ?? null,
          onPath: path !== null && paths[index] === path,
        })),
      };
      const network = xray.btcNetwork?.value;
      if (network !== undefined) {
        const address = p2wshAddress(bytes, network);
        recomputed = {
          label: r.recomputed,
          value: address,
          url: null,
          ref: x.script.recomputedRef(s.scriptHex.source.ref),
          mono: true,
        };
        if (s.address) addressMatch = address === s.address.value;
      }
    } catch {
      script = null;
    }
  }

  const list = rows(
    row(r.path, s.path, (p) => x.paths[p], false),
    row(r.coins, s.coinSource, (c) => x.coinSources[c], false),
    row(r.network, xray.btcNetwork),
    row(r.address, s.address),
    recomputed,
    row(r.template, s.template, (t) =>
      t.slots
        .map((slot) =>
          slot.kind === "signature"
            ? `signature ${slot.signer}`
            : slot.kind === "selector"
              ? `selector ${slot.hex}`
              : slot.kind,
        )
        .join(" · "),
    ),
    row(r.scriptHex, s.scriptHex),
  );
  const headline =
    s.status === "failed"
      ? x.script.failed
      : path !== null && coinName !== ""
        ? x.script.headline(pathName, coinName)
        : x.status.not_reached;
  return {
    id: "script",
    n: 1,
    title: x.stages.script,
    status: s.status,
    tone,
    statusText: statusTextOf(s.status, tone),
    headline,
    detail: null,
    rows: list,
    groups: [],
    script,
    addressMatch,
    sources: [...distinctRefs(list), ...(script ? [script.ref] : [])],
  };
}

function ruleStage(xray: XRay, now: number): StageView {
  const s = xray.rule;
  const tone = toneOf(s.status);
  const r = x.rule.rows;
  const time = (ns: string) => timeOf(ns, now);

  let headline: string;
  let detail: string | null = null;
  let list: XRayRow[];
  if (s.refusal) {
    const f = s.refusal;
    headline = x.rule.refused(f.code.value, f.gloss.value);
    const facts = [
      f.facts.executableAt ? `executable_at ${time(f.facts.executableAt.value)}` : null,
      f.facts.blockTimestamp ? `block ${time(f.facts.blockTimestamp.value)}` : null,
    ].filter((part): part is string => part !== null);
    detail = facts.length === 0 ? null : x.rule.judged(facts.join(" · "), f.code.value);
    list = rows(
      row(r.code, f.code),
      row(r.gloss, f.gloss, String, false),
      row(r.method, f.method),
      row(r.args, f.args, json),
      row(r.executableAtBlock, f.facts.executableAt, time, false),
      row(r.blockTime, f.facts.blockTimestamp, time, false),
      row(r.stateAtBlock, f.facts.opState),
      row(r.tx, f.txHash),
      row(r.receipt, f.receiptId),
    );
  } else {
    const state = s.opState?.value ?? "";
    headline =
      s.voidedBy !== null
        ? x.rule.voided(s.voidedBy.value)
        : s.executableAt !== null
          ? x.rule.acceptedAt(state, time(s.executableAt.value))
          : x.rule.accepted(state);
    list = rows(
      row(r.state, s.opState),
      row(r.executableAt, s.executableAt, time, false),
      row(r.fee, s.feeSats, (sats) => `${sats} sats`),
      row(r.voidedBy, s.voidedBy, (op) => `op ${op}`),
    );
  }
  if (s.status === "not_reached") headline = x.status.not_reached;

  const groups: RowGroup[] = s.events.map((event) => ({
    title: x.rule.event(event.kind.value, event.seq.value),
    tone: "lit",
    note: null,
    rows: rows(
      row(r.blockTime, event.blockTimestamp, time, false),
      ...Object.entries(event.facts).map(([key, fact]) =>
        row(key, fact, (value) =>
          key.endsWith("_at") && isNs(value)
            ? time(value)
            : value === null
              ? "null"
              : String(value),
        ),
      ),
    ),
  }));
  return {
    id: "rule",
    n: 2,
    title: x.stages.rule,
    status: s.status,
    tone,
    statusText: statusTextOf(s.status, tone),
    headline,
    detail,
    rows: list,
    groups,
    script: null,
    addressMatch: null,
    sources: distinctRefs(list, ...groups.map((g) => g.rows)),
  };
}

function inputGroup(input: MpcInput): RowGroup {
  const r = x.mpc.rows;
  return {
    title: x.mpc.input(input.index.value),
    tone: toneOf(input.status),
    note: input.note,
    rows: rows(
      row(r.sighash, input.sighash),
      row(r.payload, input.payload),
      row(r.domain, input.domainId),
      row(r.path, input.path),
      row(r.signer, input.signer),
      row(r.participants, input.participants),
      row(r.threshold, input.threshold),
      row(r.protocol, input.protocol),
      row(r.tx, input.txHash),
      row(r.signReceipt, input.signReceiptId),
      row(r.responseReceipt, input.responseReceiptId),
      row(r.response, input.response, json),
      row(r.callbackReceipt, input.callbackReceiptId),
      row(r.callbackValue, input.callbackValue),
      row(r.signature, input.signature),
    ),
  };
}

function mpcStage(xray: XRay): StageView {
  const s = xray.mpc;
  const tone = toneOf(s.status);
  let headline: string;
  if (s.status === "done") {
    // T of N, read from the signer's `state`; without both numbers no parenthesis.
    const read = s.inputs.find((i) => i.threshold !== null && i.participants !== null);
    headline =
      read?.threshold && read.participants
        ? x.mpc.signedBy(read.threshold.value, read.participants.value)
        : x.mpc.signed;
  } else if (s.status === "pending") headline = x.mpc.waiting;
  else if (s.status === "failed") headline = x.mpc.failed;
  else headline = x.status.not_reached;
  const groups = s.inputs.map(inputGroup);
  return {
    id: "mpc",
    n: 3,
    title: x.stages.mpc,
    status: s.status,
    tone,
    statusText: statusTextOf(s.status, tone),
    headline,
    detail: null,
    rows: [],
    groups,
    script: null,
    addressMatch: null,
    sources: distinctRefs(...groups.map((g) => g.rows)),
  };
}

function bitcoinStage(xray: XRay): StageView {
  const s = xray.bitcoin;
  const confirmations = s.confirmations?.value ?? null;
  const tone = toneOf(s.status, confirmations !== null && confirmations >= 1);
  const r = x.bitcoin.rows;
  let headline: string;
  if (s.status === "done" && confirmations !== null) headline = x.bitcoin.confirmed(confirmations);
  else if (s.status === "pending") {
    headline =
      confirmations !== null
        ? x.bitcoin.mempool
        : xray.rule.opState?.value === "signed"
          ? x.bitcoin.unseen
          : x.bitcoin.built;
  } else if (s.status === "failed") headline = x.bitcoin.unreadable;
  else headline = x.status.not_reached;
  const list = rows(
    row(r.txid, s.txid),
    row(r.confirmations, s.confirmations),
    row(r.height, s.blockHeight, (h) => (h === null ? "null" : String(h))),
  );
  return {
    id: "bitcoin",
    n: 4,
    title: x.stages.bitcoin,
    status: s.status,
    tone,
    statusText: statusTextOf(s.status, tone),
    headline,
    detail: null,
    rows: list,
    groups: [],
    script: null,
    addressMatch: null,
    sources: distinctRefs(list),
  };
}

/**
 * When a later read can show something else, in ms: 10 s while a stage is still waiting, 60 s
 * while only the op is still Pending or Frozen (its MPC and Bitcoin stages are ahead of it, at
 * the end of its Delay), null once nothing can change. Pure.
 */
export function pollDelay(xray: XRay): number | null {
  const statuses = [xray.script.status, xray.rule.status, xray.mpc.status, xray.bitcoin.status];
  if (statuses.includes("pending")) return XRAY_POLL_MS;
  const state = xray.rule.opState?.value;
  return state === "pending" || state === "frozen" ? XRAY_SLOW_POLL_MS : null;
}

/** What the page draws for `xray`, times formatted against `now`. Pure. */
export function xrayModel(xray: XRay, now: number): XRayModel {
  const stages = [scriptStage(xray), ruleStage(xray, now), mpcStage(xray), bitcoinStage(xray)];
  const waiting = stages.findIndex((stage) => stage.status === "pending");
  const chips: string[] = [];
  if (xray.rule.refusal) chips.push(x.refusedChip);
  if (xray.opId) chips.push(x.opChip(xray.opId.value));
  if (xray.vaultId) chips.push(x.vaultChip(xray.vaultId.value));
  return {
    stages,
    reveal: waiting === -1 ? stages.length : waiting + 1,
    pollMs: pollDelay(xray),
    chips,
  };
}

/** Every row of a view, stage rows and group rows. */
export const allRows = (view: XRayModel): XRayRow[] =>
  view.stages.flatMap((stage) => [...stage.rows, ...stage.groups.flatMap((g) => g.rows)]);
