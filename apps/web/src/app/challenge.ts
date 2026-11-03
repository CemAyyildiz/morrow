// The challenge feed: `GET /round` and `GET /attempts` from `tools/challenge run`
// (`MORROW_CHALLENGE_URL`), the Vault's balance and the tip height from the Bitcoin backend,
// the Vault's Delay from the contract and the MPC threshold from the signer contract. Plain
// `fetch` against origins the CSP allows; the pure mapping below turns the answers into the
// `ChallengeData` the Challenge screen and the landing show. Nothing here invents a number:
// a part that has not answered stays null and its card shows a skeleton.
import {
  bitcoinTxUrl,
  nearAccountUrl,
  nearTxUrl,
  type BtcNetwork as CoreBtcNetwork,
  type Outpoint,
} from "@morrow/core-ts/browser";
import { copy } from "@/copy";
import type {
  AttemptRow,
  BtcNetwork,
  ChallengeData,
  ChallengeKeys,
  NearNetwork,
  RowLink,
} from "./data";
import { withTimeout, type BaseConfig } from "./live";

export const ROUND_POLL_MS = 30_000;
export const ATTEMPTS_POLL_MS = 10_000;
export const BITCOIN_POLL_MS = 30_000;
/** The approximate Bitcoin block interval the rotation time is estimated with. */
export const BLOCK_MS = 10 * 60_000;
/** Rows the product's Attempt Log shows. */
export const LOG_LIMIT = 50;

const HOUR_MS = 3_600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCountOrNull = (value: unknown): value is number | null => value === null || isCount(value);
const isNs = (value: unknown): value is string => isString(value) && /^\d{1,30}$/.test(value);

/** Milliseconds of a decimal ns timestamp. */
export const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

/** The web's `testnet` is testnet4 in core-ts. */
export function coreBtcNetwork(network: BtcNetwork): CoreBtcNetwork {
  return network === "testnet" ? "testnet4" : network;
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

// /round

/** The `GET /round` body as the download whitelist; null when it is not a published round. */
export function parseRound(body: unknown): ChallengeKeys | null {
  if (!isRecord(body)) return null;
  const b = body;
  if (!isCount(b.round) || b.round < 1) return null;
  for (const field of [
    "vault_contract",
    "near_network",
    "btc_network",
    "owner_account",
    "owner_key",
    "owner_key_secret",
    "near_function_call_key",
  ]) {
    if (!isString(b[field]) || b[field] === "") return null;
  }
  if (!isStringOrNull(b.vault_id) || !isStringOrNull(b.vault_address)) return null;
  if (!isStringOrNull(b.funding_txid)) return null;
  if (!isCount(b.escape_timelock_blocks)) return null;
  if (!isCountOrNull(b.funding_height) || !isCountOrNull(b.rotation_deadline_height)) return null;
  // Field by field, so nothing beyond the published round is ever kept or downloaded.
  return {
    round: b.round,
    vault_contract: b.vault_contract as string,
    near_network: b.near_network as string,
    btc_network: b.btc_network as string,
    vault_id: b.vault_id,
    owner_account: b.owner_account as string,
    owner_key: b.owner_key as string,
    owner_key_secret: b.owner_key_secret as string,
    near_function_call_key: b.near_function_call_key as string,
    vault_address: b.vault_address,
    escape_timelock_blocks: b.escape_timelock_blocks,
    funding_txid: b.funding_txid,
    funding_height: b.funding_height,
    rotation_deadline_height: b.rotation_deadline_height,
  };
}

export type RoundAnswer =
  | { kind: "round"; round: ChallengeKeys }
  /** 404: no round is open (or its funding has not confirmed). */
  | { kind: "none" }
  /** Unreachable or unreadable: the last answer stands. */
  | { kind: "error" };

export async function fetchRound(challengeUrl: string, signal: AbortSignal): Promise<RoundAnswer> {
  try {
    const response = await fetch(join(challengeUrl, "/round"), {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    if (response.status === 404) return { kind: "none" };
    if (!response.ok) return { kind: "error" };
    const round = parseRound(await response.json());
    return round ? { kind: "round", round } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Same published round: same number and the same keys (a rotated key is a new answer). */
export function sameRound(a: ChallengeKeys | null, b: ChallengeKeys | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

// /attempts

export interface WithdrawalEntry {
  type: "withdrawal";
  round: number;
  n: number;
  seq: string;
  vault_id: string;
  op_id: string;
  amount_sats: string;
  requested_at: string;
  executable_at: string;
  outcome: "pending" | "clawed_back" | "cancelled" | "signed";
  outcome_at: string | null;
  clawback_txid: string | null;
  clawback_broadcast: boolean;
  tx_hash: string | null;
}

export interface PolicyChangeEntry {
  type: "policy_change";
  round: number;
  n: number;
  seq: string;
  vault_id: string;
  change_id: string;
  proposed_at: string;
  outcome: "pending" | "vetoed" | "withdrawn" | "applied";
  tx_hash: string | null;
}

export interface RejectedEntry {
  type: "rejected";
  round: number;
  n: number;
  tx_hash: string;
  block_timestamp: string;
  method: string | null;
  code: string | null;
  failure: string;
}

export type FeedEntry = WithdrawalEntry | PolicyChangeEntry | RejectedEntry;

export interface AttemptsSummary {
  round: number | null;
  attempts_round: number;
  attempts_total: number;
  sats_taken_total: number;
  last_attempt_at: string | null;
}

export interface AttemptsFeed {
  /** Attempts only, newest first (key rotations and unreadable entries are dropped). */
  entries: FeedEntry[];
  summary: AttemptsSummary;
}

const WITHDRAWAL_OUTCOMES = ["pending", "clawed_back", "cancelled", "signed"];
const POLICY_OUTCOMES = ["pending", "vetoed", "withdrawn", "applied"];

function parseEntry(value: unknown): FeedEntry | null {
  if (!isRecord(value) || !isCount(value.round) || !isCount(value.n)) return null;
  const { round, n } = value;
  if (value.type === "withdrawal") {
    const v = value;
    if (!isString(v.seq) || !isString(v.vault_id) || !isString(v.op_id)) return null;
    if (!isString(v.amount_sats) || !/^\d+$/.test(v.amount_sats)) return null;
    if (!isNs(v.requested_at) || !isNs(v.executable_at)) return null;
    if (!WITHDRAWAL_OUTCOMES.includes(v.outcome as string)) return null;
    if (v.outcome_at !== null && !isNs(v.outcome_at)) return null;
    if (!isStringOrNull(v.clawback_txid) || !isStringOrNull(v.tx_hash)) return null;
    return {
      type: "withdrawal",
      round,
      n,
      seq: v.seq,
      vault_id: v.vault_id,
      op_id: v.op_id,
      amount_sats: v.amount_sats,
      requested_at: v.requested_at,
      executable_at: v.executable_at,
      outcome: v.outcome as WithdrawalEntry["outcome"],
      outcome_at: v.outcome_at,
      clawback_txid: v.clawback_txid,
      clawback_broadcast: v.clawback_broadcast === true,
      tx_hash: v.tx_hash,
    };
  }
  if (value.type === "policy_change") {
    const v = value;
    if (!isString(v.seq) || !isString(v.vault_id) || !isString(v.change_id)) return null;
    if (!isNs(v.proposed_at) || !POLICY_OUTCOMES.includes(v.outcome as string)) return null;
    if (!isStringOrNull(v.tx_hash)) return null;
    return {
      type: "policy_change",
      round,
      n,
      seq: v.seq,
      vault_id: v.vault_id,
      change_id: v.change_id,
      proposed_at: v.proposed_at,
      outcome: v.outcome as PolicyChangeEntry["outcome"],
      tx_hash: v.tx_hash,
    };
  }
  if (value.type === "rejected") {
    const v = value;
    if (!isString(v.tx_hash) || !isNs(v.block_timestamp) || !isString(v.failure)) return null;
    if (!isStringOrNull(v.method) || !isStringOrNull(v.code)) return null;
    return {
      type: "rejected",
      round,
      n,
      tx_hash: v.tx_hash,
      block_timestamp: v.block_timestamp,
      method: v.method,
      code: v.code,
      failure: v.failure,
    };
  }
  return null;
}

/** The `GET /attempts` body; null when it has no readable summary. */
export function parseAttempts(body: unknown): AttemptsFeed | null {
  if (!isRecord(body) || !Array.isArray(body.entries) || !isRecord(body.summary)) return null;
  const s = body.summary;
  if (s.round !== null && !isCount(s.round)) return null;
  if (!isCount(s.attempts_round) || !isCount(s.attempts_total)) return null;
  if (!isCount(s.sats_taken_total) || !isStringOrNull(s.last_attempt_at)) return null;
  const entries = (body.entries as unknown[])
    .map(parseEntry)
    .filter((entry): entry is FeedEntry => entry !== null);
  return {
    entries,
    summary: {
      round: s.round,
      attempts_round: s.attempts_round,
      attempts_total: s.attempts_total,
      sats_taken_total: s.sats_taken_total,
      last_attempt_at: s.last_attempt_at,
    },
  };
}

export async function fetchAttempts(
  challengeUrl: string,
  signal: AbortSignal,
): Promise<AttemptsFeed | null> {
  try {
    const response = await fetch(join(challengeUrl, "/attempts"), {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    if (!response.ok) return null;
    return parseAttempts(await response.json());
  } catch {
    return null;
  }
}

/** A row's identity across polls and rounds. */
export const entryKey = (entry: FeedEntry) => `${entry.round}-${entry.n}`;

// Bitcoin backend (Esplora)

/** Sum of an Esplora `/address/<a>/utxo` answer, in sats; null when it is not one. */
export function utxoSats(body: unknown): number | null {
  if (!Array.isArray(body)) return null;
  let total = 0;
  for (const utxo of body as unknown[]) {
    if (!isRecord(utxo) || !isCount(utxo.value)) return null;
    total += utxo.value;
  }
  return total;
}

/**
 * The confirmed coins of an Esplora `/address/<a>/utxo` answer (`{txid, vout, value,
 * status.confirmed}`), as the contract's `Outpoint`s; null when it is not one.
 */
export function confirmedOutpoints(body: unknown): Outpoint[] | null {
  if (!Array.isArray(body)) return null;
  const outpoints: Outpoint[] = [];
  for (const utxo of body as unknown[]) {
    if (!isRecord(utxo) || !isCount(utxo.value)) return null;
    if (!isString(utxo.txid) || !/^[0-9a-f]{64}$/.test(utxo.txid) || !isCount(utxo.vout)) {
      return null;
    }
    if (!isRecord(utxo.status) || utxo.status.confirmed !== true) continue;
    outpoints.push({ txid: utxo.txid, vout: utxo.vout, value_sats: String(utxo.value) });
  }
  return outpoints;
}

/** The Vault Address's coins: the total (confirmed or not) and the confirmed outpoints. */
export interface VaultUtxos {
  sats: number;
  outpoints: Outpoint[];
}

export async function fetchVaultUtxos(
  btcBackendUrl: string,
  address: string,
  signal: AbortSignal,
): Promise<VaultUtxos | null> {
  try {
    const response = await fetch(
      join(btcBackendUrl, `/address/${encodeURIComponent(address)}/utxo`),
      {
        cache: "no-store",
        signal: withTimeout(signal),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const sats = utxoSats(body);
    const outpoints = confirmedOutpoints(body);
    // Coins that cannot be read as outpoints still count in the balance: none can be spent here.
    return sats === null ? null : { sats, outpoints: outpoints ?? [] };
  } catch {
    return null;
  }
}

export async function fetchTipHeight(
  btcBackendUrl: string,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetch(join(btcBackendUrl, "/blocks/tip/height"), {
      cache: "no-store",
      signal: withTimeout(signal),
    });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return /^\d{1,9}$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

// NEAR views

/** The JSON value of a `call_function` answer; null on an error or another shape. */
export function viewResult(response: unknown): unknown {
  if (!isRecord(response) || response.error !== undefined || !isRecord(response.result)) {
    return null;
  }
  const bytes = response.result.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => isCount(b) && b < 256)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[])));
  } catch {
    return null;
  }
}

/** A view call over NEAR JSON-RPC (`query` / `call_function`, final). */
export async function viewCall(
  rpcUrl: string,
  accountId: string,
  method: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "morrow-web",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: accountId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
      signal: withTimeout(signal),
    });
    if (!response.ok) return null;
    return viewResult(await response.json());
  } catch {
    return null;
  }
}

/** What the page reads from `get_vault`. */
export interface VaultFacts {
  delayNs: string;
  ownerAccount: string;
  /** The watcher's X25519 key Watcher Envelopes are sealed to; null when unreadable. */
  watcherPk: string | null;
}

export function vaultFacts(vault: unknown): VaultFacts | null {
  if (!isRecord(vault) || !isString(vault.owner_account) || !isRecord(vault.policy)) return null;
  const { delay_ns: delayNs, watcher_x25519_pk: watcherPk } = vault.policy;
  if (!isNs(delayNs)) return null;
  return {
    delayNs,
    ownerAccount: vault.owner_account,
    watcherPk: isString(watcherPk) && /^[0-9a-f]{64}$/.test(watcherPk) ? watcherPk : null,
  };
}

export async function fetchVaultFacts(
  rpcUrl: string,
  contractId: string,
  vaultId: string,
  signal: AbortSignal,
): Promise<VaultFacts | null> {
  return vaultFacts(await viewCall(rpcUrl, contractId, "get_vault", { vault_id: vaultId }, signal));
}

export interface CoSigner {
  threshold: number;
  total: number;
}

/**
 * The threshold and participant count from the MPC signer contract's `state` view (checked on
 * `v1.signer-prod.testnet` and `v1.signer`, 2026-11-03): `{ Running: { parameters: { threshold,
 * participants: { participants: [...] } } } }`. During a resharing the previous running state
 * is read. Null for any other shape: the stat hides.
 */
export function signerFrom(state: unknown): CoSigner | null {
  if (!isRecord(state)) return null;
  let running = state.Running;
  if (!isRecord(running) && isRecord(state.Resharing))
    running = state.Resharing.previous_running_state;
  if (!isRecord(running) || !isRecord(running.parameters)) return null;
  const { threshold, participants } = running.parameters;
  if (!isCount(threshold) || !isRecord(participants) || !Array.isArray(participants.participants)) {
    return null;
  }
  const total = participants.participants.length;
  return threshold >= 1 && threshold <= total ? { threshold, total } : null;
}

export async function fetchCoSigner(
  rpcUrl: string,
  signerAccount: string,
  signal: AbortSignal,
): Promise<CoSigner | null> {
  return signerFrom(await viewCall(rpcUrl, signerAccount, "state", {}, signal));
}

// Display

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` local time. */
export function clockOf(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The local date of `ms` (`13 Nov`, with the year when not this year); empty on `now`'s day. */
export function dateOf(ms: number, now: number): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return "";
  const day = `${date.getDate()} ${MONTHS[date.getMonth()] ?? ""}`;
  return date.getFullYear() === today.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** `HH:MM` on `now`'s day, otherwise `13 Nov HH:MM`. */
export function absoluteTime(ms: number, now: number): string {
  const day = dateOf(ms, now);
  return day === "" ? clockOf(ms) : `${day} ${clockOf(ms)}`;
}

/** `24 h`, `18 h 59 m`, `45 m`, `30 s`, `7 d`, `3 d 4 h`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms);
  if (total < 60_000) return `${Math.floor(total / 1000)} s`;
  const minutes = Math.floor(total / 60_000);
  const days = Math.floor(minutes / 1440);
  if (days >= 3) {
    const hours = Math.floor((minutes % 1440) / 60);
    return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** Sats as a decimal BTC amount with 8 places, without floating point. */
export function formatBtc(sats: number): string {
  return `${Math.floor(sats / 1e8)}.${String(sats % 1e8).padStart(8, "0")}`;
}

const UNITS: Record<BtcNetwork, string> = {
  bitcoin: "BTC",
  signet: "sBTC",
  testnet: "tBTC",
  regtest: "rBTC",
};

const entryMs = (entry: FeedEntry) =>
  nsToMs(
    entry.type === "withdrawal"
      ? entry.requested_at
      : entry.type === "policy_change"
        ? entry.proposed_at
        : entry.block_timestamp,
  );

function action(entry: FeedEntry): string {
  if (entry.type === "withdrawal") return copy.attemptLog.withdrawal;
  if (entry.type === "policy_change") return copy.attemptLog.policyChange;
  if (entry.method === "begin_execute") return copy.attemptLog.earlyExecute;
  return entry.method ?? copy.attemptLog.unknownCall;
}

function outcome(entry: FeedEntry): AttemptRow["outcome"] {
  const t = copy.attemptLog.outcome;
  if (entry.type === "rejected") {
    return { tone: "alarm", text: t.rejected(entry.code ?? entry.failure) };
  }
  if (entry.type === "policy_change") {
    if (entry.outcome === "vetoed") return { tone: "ok", text: t.vetoed };
    if (entry.outcome === "applied") return { tone: "alarm", text: t.applied };
    if (entry.outcome === "withdrawn") return { tone: "neutral", text: t.withdrawn };
    return { tone: "neutral", text: t.pending };
  }
  if (entry.outcome === "clawed_back" && entry.outcome_at !== null) {
    const seconds = Math.max(
      0,
      Math.round(Number(BigInt(entry.outcome_at) - BigInt(entry.requested_at)) / 1e9),
    );
    return { tone: "ok", text: t.clawedBack(seconds) };
  }
  if (entry.outcome === "signed") return { tone: "alarm", text: t.signed };
  if (entry.outcome === "cancelled") return { tone: "neutral", text: t.cancelled };
  return { tone: "neutral", text: t.pending };
}

export interface RowContext {
  /** The round shown; rows of other rounds are marked with theirs. */
  round: number;
  now: number;
  network: { btc: BtcNetwork; near: NearNetwork };
  /** The Owner Account of a Vault, for the link shown until a row's tx hash is known. */
  ownerOf: (vaultId: string) => string | null;
  fresh: ReadonlySet<string>;
}

function links(entry: FeedEntry, ctx: RowContext): NonNullable<AttemptRow["links"]> {
  const { near, btc } = ctx.network;
  let nearLink: RowLink | null = null;
  if (near !== "mock") {
    if (entry.tx_hash !== null) {
      nearLink = {
        href: nearTxUrl(near, entry.tx_hash),
        text: copy.attemptLog.nearLink,
        label: copy.attemptLog.nearTxLabel(entry.n),
      };
    } else {
      const owner = entry.type === "rejected" ? null : ctx.ownerOf(entry.vault_id);
      if (owner !== null) {
        nearLink = {
          href: nearAccountUrl(near, owner),
          text: copy.attemptLog.nearLink,
          label: copy.attemptLog.nearAccountLabel(entry.n),
        };
      }
    }
  }
  let bitcoinLink: RowLink | null = null;
  if (entry.type === "withdrawal" && entry.clawback_broadcast && entry.clawback_txid !== null) {
    const href = bitcoinTxUrl(coreBtcNetwork(btc), entry.clawback_txid);
    if (href !== null) {
      bitcoinLink = {
        href,
        text: copy.attemptLog.bitcoinLink,
        label: copy.attemptLog.bitcoinTxLabel(entry.n),
      };
    }
  }
  return { near: nearLink, bitcoin: bitcoinLink };
}

/** Attempt Log rows, newest first, at most `limit`. */
export function attemptRows(
  entries: readonly FeedEntry[],
  ctx: RowContext,
  limit = LOG_LIMIT,
): AttemptRow[] {
  return entries.slice(0, limit).map((entry) => {
    const key = entryKey(entry);
    return {
      key,
      n: entry.n,
      at: absoluteTime(entryMs(entry), ctx.now),
      action: action(entry),
      ...(entry.round === ctx.round ? {} : { round: entry.round }),
      outcome: outcome(entry),
      links: links(entry, ctx),
      fresh: ctx.fresh.has(key),
    };
  });
}

/** Attempts of `round` per hour over the 24 h before `now`, oldest first. */
export function hourly(entries: readonly FeedEntry[], round: number, now: number): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const entry of entries) {
    if (entry.round !== round) continue;
    const age = now - entryMs(entry);
    if (age < 0 || age >= 24 * HOUR_MS) continue;
    const index = 23 - Math.floor(age / HOUR_MS);
    hours[index] = (hours[index] ?? 0) + 1;
  }
  return hours;
}

/** The earliest pending Withdrawal Request of `round`. */
export function earliestPending(
  entries: readonly FeedEntry[],
  round: number,
): WithdrawalEntry | null {
  let earliest: WithdrawalEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== "withdrawal" || entry.round !== round || entry.outcome !== "pending") {
      continue;
    }
    if (earliest === null || BigInt(entry.executable_at) < BigInt(earliest.executable_at)) {
      earliest = entry;
    }
  }
  return earliest;
}

export interface FeedInputs {
  round: ChallengeKeys;
  /** Null until `/attempts` answers. */
  attempts: AttemptsFeed | null;
  /** Row keys that arrived with the latest `/attempts` answer. */
  fresh: ReadonlySet<string>;
  /** Sats at the round's Vault Address; null until the backend answers. */
  balanceSats: number | null;
  tip: number | null;
  /** `get_vault` per vault id. */
  vaults: Readonly<Record<string, VaultFacts>>;
  coSigner: CoSigner | null | "unreadable";
}

/** What the Challenge screen shows for the inputs at `now`. Pure. */
export function challengeData(
  inputs: FeedInputs,
  config: Pick<BaseConfig, "network" | "bountyUrl">,
  now: number,
): ChallengeData {
  const { round, attempts } = inputs;
  const { btc } = config.network;
  const facts = round.vault_id === null ? undefined : inputs.vaults[round.vault_id];
  const entries = attempts?.entries ?? [];
  const pending = attempts ? earliestPending(entries, round.round) : null;

  let withdrawal: ChallengeData["withdrawal"] = null;
  if (attempts && pending) {
    const requested = nsToMs(pending.requested_at);
    const executable = nsToMs(pending.executable_at);
    const span = Math.max(1, executable - requested);
    withdrawal = {
      time: clockOf(executable),
      day: dateOf(executable, now),
      requestedAt: absoluteTime(requested, now),
      remaining: formatDuration(executable - now),
      elapsed: Math.min(1, Math.max(0, (now - requested) / span)),
    };
  } else if (attempts && facts) {
    const delayMs = nsToMs(facts.delayNs);
    withdrawal = {
      time: clockOf(now + delayMs),
      day: dateOf(now + delayMs, now),
      requestedAt: null,
      remaining: formatDuration(delayMs),
      elapsed: 0,
    };
  }

  const deadline = round.rotation_deadline_height;
  return {
    round: round.round,
    keysPublished: true,
    withdrawal,
    attempts: attempts
      ? {
          count: attempts.summary.attempts_round,
          total: attempts.summary.attempts_total,
          satsOut: attempts.summary.sats_taken_total,
          hourly: hourly(entries, round.round, now),
          lastAt:
            attempts.summary.last_attempt_at === null ||
            Number.isNaN(Date.parse(attempts.summary.last_attempt_at))
              ? null
              : absoluteTime(Date.parse(attempts.summary.last_attempt_at), now),
        }
      : null,
    vault: {
      amount: inputs.balanceSats === null ? null : formatBtc(inputs.balanceSats),
      unit: UNITS[btc],
      delay: facts ? formatDuration(nsToMs(facts.delayNs)) : null,
    },
    satsTaken: attempts ? attempts.summary.sats_taken_total : null,
    coSigner: inputs.coSigner,
    rotation:
      deadline === null
        ? null
        : {
            height: deadline,
            at:
              inputs.tip === null
                ? null
                : absoluteTime(now + Math.max(0, deadline - inputs.tip) * BLOCK_MS, now),
          },
    coins: copy.challenge.coins(btc),
    bountyUrl: config.bountyUrl,
    keys: round,
    log: attempts
      ? attemptRows(entries, {
          round: round.round,
          now,
          network: config.network,
          ownerOf: (vaultId) =>
            inputs.vaults[vaultId]?.ownerAccount ??
            (vaultId === round.vault_id ? round.owner_account : null),
          fresh: inputs.fresh,
        })
      : null,
    pending: pending
      ? {
          n: pending.n,
          opId: pending.op_id,
          executableAt: absoluteTime(nsToMs(pending.executable_at), now),
        }
      : null,
  };
}

/** Vault ids whose `get_vault` the page needs: the round's, and those of rows without a hash. */
export function neededVaults(round: ChallengeKeys | null, feed: AttemptsFeed | null): string[] {
  const ids = new Set<string>();
  if (round?.vault_id) ids.add(round.vault_id);
  for (const entry of feed?.entries ?? []) {
    if (entry.type !== "rejected" && entry.tx_hash === null) ids.add(entry.vault_id);
  }
  return [...ids].sort();
}

// Download keys

/** `morrow-challenge-round-<n>.json`: the published round plus a short how-to. */
export function keysFile(keys: ChallengeKeys): { filename: string; text: string } {
  return {
    filename: `morrow-challenge-round-${keys.round}.json`,
    text: `${JSON.stringify({ ...keys, how_to: copy.challenge.howTo }, null, 2)}\n`,
  };
}

/** How long the keys file's object URL lives after the click. */
export const REVOKE_AFTER_MS = 60_000;

/** Saves the keys file from a Blob object URL, revoked a minute after the click. */
export function downloadKeys(keys: ChallengeKeys): void {
  const { filename, text } = keysFile(keys);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers cancel a download whose URL is revoked right after the click.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
