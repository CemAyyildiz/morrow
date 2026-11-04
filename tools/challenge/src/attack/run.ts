/**
 * Runs the scripted rounds through ports, waits for the next round and the Attempt Log, and
 * assembles the report and its pass/fail. Everything the run touches is a port, so the dry run
 * (mock contract, fake backend, simulated watcher, fake feed) and the tests share one code path
 * with the live signet run.
 */
import { createHash } from "node:crypto";
import {
  BitcoinBackendError,
  bitcoinTxUrl,
  nearTxUrl,
  parseNearKey,
  sealWatcherEnvelope,
  type BtcNetwork,
  type NearKey,
  type NearNetwork,
  type Outpoint,
  type Utxo,
  type Vault,
  type VaultKit,
} from "@morrow/core-ts";
import { boxSeal } from "@morrow/core-ts/envelope";
import type { AttemptEntry, PolicyChangeOutcome } from "../attempts.js";
import type { PublicRound } from "../store.js";
import { buildOwnerSpend, p2wpkhAddress, type OwnerSpendPath } from "./bitcoin.js";
import type { CallPlan, CallResult, NearPort } from "./near.js";
import {
  CATEGORIES,
  allCategories,
  buildPlan,
  liveCategories,
  notDeployed,
  notDeployedNote,
  seededRandom,
  type Move,
  type PlannedAttempt,
  type PlannedRound,
} from "./plan.js";
import {
  reportNetwork,
  type AttackReport,
  type AttemptRecord,
  type AttackerAddress,
  type HeaderNetwork,
  type RedirectOutcome,
  type RoundReport,
} from "./report.js";

export const ROUND_POLL_MS = 30_000;
export const LOG_POLL_MS = 15_000;
export const CLAWBACK_POLL_MS = 15_000;
export const DEFAULT_ROUND_WAIT_MS = 60 * 60_000;
export const DEFAULT_LOG_WAIT_MS = 10 * 60_000;
export const DEFAULT_CLAWBACK_WAIT_MS = 5 * 60_000;
/** The run stops cleanly below this remaining key allowance (unless `/round` serves a new key). */
export const MIN_ALLOWANCE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
/** Fee rate of every request; the full-balance amount keeps a fee bound back (see below). */
export const FEE_RATE_SAT_VB = 2;
/** A fee rate far above any Fee Cap, for the Policy-level Refresh refusal. */
const OVER_CAP_FEE_RATE = 1_000_000;

export interface RoundSource {
  /** The published round, or null (or a throw carrying the HTTP error) when none is served. */
  current(): Promise<PublicRound | null>;
}

export interface BitcoinPort {
  getUtxos(address: string): Promise<Utxo[]>;
  getTipHeight(): Promise<number>;
  /** Broadcasts a raw transaction; returns the txid, or throws with the node's rejection text. */
  broadcast(rawHex: string): Promise<string>;
}

/** A matching view of one Attempt Log entry, independent of the feed's wire shape. */
export interface LogEntryView {
  n: number;
  type: "rejected" | "withdrawal" | "policy_change";
  tx_hash: string | null;
  /** A withdrawal's op id. */
  op_id: string | null;
  /** A Policy Change's change id (a separate counter from op ids). */
  change_id: string | null;
  vault_id: string | null;
  /** A rejected entry's `ERR_*` code, else its raw failure kind. */
  code: string | null;
  clawback_op_id: string | null;
  clawback_txid: string | null;
  clawback_broadcast: boolean | null;
  /** A Policy Change's outcome; null for other entries. */
  outcome: PolicyChangeOutcome | null;
}

export interface AttemptsFeed {
  entries(): Promise<LogEntryView[]>;
}

/** Converts the public `GET /attempts` entries to matching views (key rotations are dropped). */
export function logViews(entries: readonly AttemptEntry[]): LogEntryView[] {
  const views: LogEntryView[] = [];
  const none = { clawback_op_id: null, clawback_txid: null, clawback_broadcast: null };
  for (const entry of entries) {
    if (entry.type === "rejected") {
      views.push({
        n: entry.n,
        type: "rejected",
        tx_hash: entry.tx_hash,
        op_id: null,
        change_id: null,
        vault_id: null,
        code: entry.code ?? entry.failure,
        ...none,
        outcome: null,
      });
    } else if (entry.type === "withdrawal") {
      views.push({
        n: entry.n,
        type: "withdrawal",
        tx_hash: entry.tx_hash,
        op_id: entry.op_id,
        change_id: null,
        vault_id: entry.vault_id,
        code: null,
        clawback_op_id: entry.clawback_op_id,
        clawback_txid: entry.clawback_txid,
        clawback_broadcast: entry.clawback_broadcast,
        outcome: null,
      });
    } else if (entry.type === "policy_change") {
      views.push({
        n: entry.n,
        type: "policy_change",
        tx_hash: entry.tx_hash,
        op_id: null,
        change_id: entry.change_id,
        vault_id: entry.vault_id,
        code: null,
        ...none,
        outcome: entry.outcome,
      });
    }
  }
  return views;
}

export interface ClawbackInfo {
  op_id: string;
  txid: string | null;
}

/**
 * The Auto-Clawback actor. Live: a no-op returning null (the real watcher acts on its own; the
 * run reads the Clawback and the veto from `get_vault` and the feed). Dry run: vetoes a pending
 * Policy Change and claws back a live request.
 */
export interface Watcher {
  tick(vaultId: string): Promise<ClawbackInfo | null>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AttackPorts {
  rounds: RoundSource;
  near: NearPort;
  bitcoin: BitcoinPort;
  feed: AttemptsFeed;
  watcher: Watcher;
  clock: Clock;
}

export interface AttackParams {
  seed: number;
  n: number;
  rounds: number;
  /** `MORROW_NEAR_NETWORK`: a round served for another NEAR network stops the run. */
  nearNetwork: NearNetwork;
  /** Dry run: every category and network `mock`; live: only `liveMethods`. */
  dryRun: boolean;
  toolCommit: string | null;
  toolDirty?: boolean;
  liveMethods?: readonly string[];
  roundWaitMs?: number;
  logWaitMs?: number;
  clawbackWaitMs?: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const satsNum = (value: string | number) => Number(BigInt(value));
const utxoSats = (utxos: readonly { value_sats: string }[]) =>
  utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** JSON with object keys sorted at every depth, so equal args always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The full-balance amount: the input total minus 2 sat/vB × (60 + 250 × inputs) vB. */
export function requestAmount(coins: readonly Outpoint[]): bigint {
  const total = coins.reduce((sum, c) => sum + BigInt(c.value_sats), 0n);
  return total - BigInt(FEE_RATE_SAT_VB) * BigInt(60 + 250 * coins.length);
}

const BAD_ENVELOPE = "ab".repeat(79);
const HEX64 = /^[0-9a-f]{64}$/i;

/** Why a `/round` body cannot be attacked, or null when every field the run uses is sound. */
export function roundProblem(round: PublicRound): string | null {
  if (typeof round.round !== "number" || !Number.isSafeInteger(round.round))
    return "no round number";
  if (typeof round.vault_id !== "string" || !/^\d+$/.test(round.vault_id)) return "no vault_id";
  if (typeof round.owner_key_secret !== "string" || !HEX64.test(round.owner_key_secret)) {
    return "owner_key_secret is not 64 hex characters";
  }
  if (round.funding_height !== null && !Number.isSafeInteger(round.funding_height)) {
    return "funding_height is not a number";
  }
  if (typeof round.owner_account !== "string" || typeof round.vault_contract !== "string") {
    return "no owner_account or vault_contract";
  }
  if (reportNetwork(String(round.btc_network)) === null) return "unknown btc_network";
  try {
    parseNearKey(String(round.near_function_call_key));
  } catch {
    return "near_function_call_key is not an ed25519 key";
  }
  return null;
}

/** Only a node's answer counts as a rejection: HTTP 400 (Esplora) or an RPC error (Core). */
function nodeRejection(error: unknown): string | null {
  if (!(error instanceof BitcoinBackendError)) return null;
  if (error.status === 400 || !/HTTP \d{3}\b/.test(error.message)) return error.message;
  return null;
}

/** The rejection text each Owner-Key-only path must meet to count as the expected refusal. */
const REJECTION: Record<OwnerSpendPath, RegExp> = {
  escape: /non-BIP68-final|BIP68|sequence/i,
  no_cosigner: /script|signature|SCRIPT_ERR|mandatory-script-verify/i,
};

/** State carried through one round's attempts. */
interface RoundContext {
  report: RoundReport;
  key: NearKey;
  ownerSecret: Uint8Array;
  ownerAccount: string;
  vaultContract: string;
  vaultId: string;
  btc: BtcNetwork;
  kit: VaultKit;
  watcherPk: string;
  /** Confirmed Vault coins with their heights; null when the backend could not be read. */
  utxos: Utxo[] | null;
  coins: Outpoint[];
  vaultAddress: string;
  /** This run's own accepted request, if any. */
  ownOpId: string | null;
  /** The full-balance request's actual outcome, once sent. */
  requestOutcome: string | null;
  /** The Recovery Address this run's accepted redirect proposed. */
  redirectedTo: string | null;
  /** An accepted redirect whose veto has not been awaited yet. */
  vetoDue: boolean;
}

type StopKind = "allowance" | "other";

export class AttackRun {
  private readonly attempts: AttemptRecord[] = [];
  private readonly rounds: RoundReport[] = [];
  private readonly publicKeys = new Set<string>();
  private readonly attackerAddresses = new Set<string>();
  private readonly attacked = new Set<number>();
  /** Attempt ids of the Recovery Address redirects. */
  private readonly redirectIds = new Set<number>();
  private readonly challengeRounds: number[] = [];
  private readonly destinationRandom: () => number;
  private nextId = 1;
  private stoppedReason: string | null = null;
  private stopKind: StopKind | null = null;
  private completedRounds = 0;
  private network: HeaderNetwork = "unknown";
  private nearNetworkSeen: string | null = null;

  constructor(
    private readonly ports: AttackPorts,
    private readonly params: AttackParams,
  ) {
    // A stream of its own, so drawing destinations never changes the plan.
    this.destinationRandom = seededRandom((params.seed ^ 0x5bd1e995) >>> 0);
    if (params.dryRun) this.network = "mock";
  }

  private get roundWaitMs() {
    return this.params.roundWaitMs ?? DEFAULT_ROUND_WAIT_MS;
  }
  private get logWaitMs() {
    return this.params.logWaitMs ?? DEFAULT_LOG_WAIT_MS;
  }
  private get clawbackWaitMs() {
    return this.params.clawbackWaitMs ?? DEFAULT_CLAWBACK_WAIT_MS;
  }

  private sealedEnvelopes = 0;

  /**
   * A normal Watcher Envelope. The dry run seals deterministically from the seed (ephemeral key
   * and plaintext), so the same seed gives the same args and `args_sha256`; live runs seal fresh.
   */
  private envelope(watcherPk: string): string {
    if (!this.params.dryRun) return sealWatcherEnvelope("normal", watcherPk);
    const n = this.sealedEnvelopes++;
    const draw = (label: string) =>
      new Uint8Array(
        createHash("sha256").update(`dry-run envelope ${this.params.seed} ${n} ${label}`).digest(),
      );
    const plaintext = draw("plaintext");
    plaintext[0] = 0x00; // the "normal" flag
    const publicKey = Uint8Array.from(Buffer.from(watcherPk, "hex"));
    return Buffer.from(boxSeal(plaintext, publicKey, draw("ephemeral"))).toString("hex");
  }

  private stop(reason: string, kind: StopKind = "other"): void {
    if (this.stoppedReason !== null) return;
    this.stoppedReason = reason;
    this.stopKind = kind;
  }

  async execute(): Promise<AttackReport> {
    const startedAt = new Date(this.ports.clock.now()).toISOString();
    const nearTipStart = await this.safe(() => this.ports.near.tipHeight());
    const btcTipStart = await this.safe(() => this.ports.bitcoin.getTipHeight());

    const categories = this.params.dryRun
      ? allCategories()
      : liveCategories(this.params.liveMethods);
    const plan = buildPlan({
      seed: this.params.seed,
      n: this.params.n,
      rounds: this.params.rounds,
      categories,
    });

    let contractId = "";
    let codeHash: string | null = null;
    for (const planned of plan) {
      if (this.stoppedReason !== null) break;
      const round = await this.awaitRound();
      if (!round) break;
      if (this.network === "unknown") this.network = reportNetwork(round.btc_network) ?? "unknown";
      this.nearNetworkSeen ??= round.near_network;
      contractId = round.vault_contract;
      codeHash ??= await this.safe(() => this.ports.near.codeHash(round.vault_contract));
      this.attacked.add(round.round);
      this.challengeRounds.push(round.round);
      if (await this.runRound(planned, round)) this.completedRounds += 1;
    }

    await this.matchLog();
    const attackers = await this.readAttackerBalances();
    const endedAt = new Date(this.ports.clock.now()).toISOString();
    const nearTipEnd = await this.safe(() => this.ports.near.tipHeight());
    const btcTipEnd = await this.safe(() => this.ports.bitcoin.getTipHeight());

    const satsToAttackers = attackers.reduce((sum, a) => sum + (a.final_balance_sats ?? 0), 0);
    const unreadableBalances = attackers
      .filter((a) => a.final_balance_sats === null)
      .map((a) => a.address);
    const onLogTotal = this.attempts.filter(needsLog).length;
    const onLogMatched = this.attempts.filter((a) => needsLog(a) && a.log_entry !== null).length;
    const missing = this.attempts
      .filter((a) => needsLog(a) && a.log_entry === null)
      .map((a) => a.tx_hash ?? `attempt ${a.id}`);
    const ids = (pick: (a: AttemptRecord) => boolean) =>
      this.attempts.filter(pick).map((a) => a.id);
    const unreadable = ids((a) => a.actual_class === "unreadable");
    const violation = this.attempts.some(
      (a) => a.actual_class !== "unreadable" && a.actual_class !== "skipped" && !a.expected_match,
    );
    const clawbackMissing = this.rounds
      .filter((r) => r.clawback_seen === false)
      .map((r) => r.challenge_round);
    const vetoMissing = this.rounds
      .filter((r) => r.policy_change_outcome !== null && !VETO_ENDS.has(r.policy_change_outcome))
      .map((r) => r.challenge_round);
    const redirectsVetoed = this.rounds.filter((r) => r.policy_change_outcome === "vetoed").length;
    // A clean stop: the key ran out of allowance after at least one whole round.
    const stopOk =
      this.stoppedReason === null || (this.stopKind === "allowance" && this.completedRounds >= 1);
    const passed =
      this.attempts.length >= 1 &&
      !violation &&
      unreadable.length === 0 &&
      stopOk &&
      satsToAttackers === 0 &&
      unreadableBalances.length === 0 &&
      missing.length === 0 &&
      clawbackMissing.length === 0 &&
      vetoMissing.length === 0 &&
      redirectsVetoed >= 1;

    return {
      header: {
        tool_commit: this.params.toolCommit,
        tool_dirty: this.params.toolDirty ?? false,
        seed: this.params.seed,
        network: this.network,
        near_network: this.nearNetworkSeen ?? this.params.nearNetwork,
        contract_id: contractId,
        code_hash: codeHash,
        started_at: startedAt,
        ended_at: endedAt,
        near_tip_start: nearTipStart,
        near_tip_end: nearTipEnd,
        btc_tip_start: btcTipStart,
        btc_tip_end: btcTipEnd,
        challenge_rounds: this.challengeRounds,
        public_keys: [...this.publicKeys],
      },
      rounds: this.rounds,
      attempts: this.attempts,
      summary: {
        attacker_addresses: attackers,
        sats_to_attackers: satsToAttackers,
        unreadable_balances: unreadableBalances,
        on_log: `${onLogMatched}/${onLogTotal}`,
        on_log_matched: onLogMatched,
        on_log_total: onLogTotal,
        missing_hashes: missing,
        off_log: this.attempts.filter((a) => a.actual_class === "off_log").length,
        allowed_harmless: this.attempts.filter((a) => a.actual_class === "allowed_harmless").length,
        skipped: ids((a) => a.actual_class === "skipped"),
        unreadable,
        unexpected: ids((a) => a.unexpected),
        clawback_missing: clawbackMissing,
        veto_missing: vetoMissing,
        redirects_vetoed: redirectsVetoed,
        not_deployed: notDeployed(categories),
        not_deployed_note: notDeployedNote(categories),
        stopped_reason: this.stoppedReason,
        passed,
      },
    };
  }

  /**
   * Waits for a round worth attacking: served by `/round`, its fields sound, funding confirmed,
   * not attacked yet, and its Vault `active`. Polls every 30 s up to `roundWaitMs`; the last
   * problem (an HTTP error, an unconfirmed funding, a closed Vault) goes into `stopped_reason`.
   */
  private async awaitRound(): Promise<PublicRound | null> {
    const deadline = this.ports.clock.now() + this.roundWaitMs;
    let last = "no answer yet";
    for (;;) {
      let round: PublicRound | null = null;
      try {
        round = await this.ports.rounds.current();
        if (!round) last = "GET /round served no round (404)";
      } catch (error) {
        last = message(error);
      }
      if (round) {
        const problem = roundProblem(round);
        if (problem) {
          this.stop(`round ${String(round.round)} cannot be attacked: ${problem}`);
          return null;
        }
        if (round.near_network !== this.params.nearNetwork) {
          this.stop(
            `NEAR network mismatch: MORROW_NEAR_NETWORK is ${this.params.nearNetwork} but /round serves ${round.near_network}`,
          );
          this.nearNetworkSeen = round.near_network;
          return null;
        }
        if (this.attacked.has(round.round)) {
          last = `round ${round.round} was already attacked; waiting for the next one`;
        } else if (round.funding_height === null) {
          last = `round ${round.round} funding is not confirmed yet`;
        } else {
          const state = await this.ports.near
            .getVault(round.vault_id as string)
            .then((v) => v.state)
            .catch((error: unknown) => `unreadable (${message(error)})`);
          if (state === "active") return round;
          last = `round ${round.round} Vault is ${state}`;
        }
      }
      if (this.ports.clock.now() >= deadline) {
        this.stop(
          `no attackable round within ${Math.round(this.roundWaitMs / 60_000)} min; last: ${last}`,
        );
        return null;
      }
      await this.ports.clock.sleep(ROUND_POLL_MS);
    }
  }

  /** Runs one round's script; true when it completed without the run stopping. */
  private async runRound(planned: PlannedRound, round: PublicRound): Promise<boolean> {
    const ctx = await this.openRoundContext(planned.index, round);
    if (!ctx) return false;

    let done = 0;
    const scripted = planned.scripted;
    let i = 0;
    while (i < scripted.length && this.stoppedReason === null && done < planned.budget) {
      const attempt = scripted[i] as PlannedAttempt;
      if (attempt.phase === "window") {
        const batch: PlannedAttempt[] = [];
        while (
          i < scripted.length &&
          (scripted[i] as PlannedAttempt).phase === "window" &&
          done + batch.length < planned.budget
        ) {
          batch.push(scripted[i] as PlannedAttempt);
          i += 1;
        }
        done += await this.runWindow(batch, ctx, round);
      } else {
        if (await this.runAttempt(attempt, ctx, round)) done += 1;
        i += 1;
      }
      // An accepted redirect must be vetoed before the round goes on; the apply attempt that
      // races the veto goes first.
      if (ctx.vetoDue && scripted[i]?.move !== "policy_change_apply_redirect") {
        await this.awaitVeto(ctx);
      }
    }
    if (ctx.vetoDue) await this.awaitVeto(ctx);

    // A request that went in (ours, or a stranger's holding the coin) must be clawed back. The
    // check needs no key, so it runs even after an allowance stop.
    const awaitsClawback =
      ctx.requestOutcome === "accepted" ||
      ctx.requestOutcome === "ERR_OUTPOINT_RESERVED" ||
      ctx.requestOutcome === "ERR_CLAWED_BACK";
    if (awaitsClawback) await this.awaitClawback(ctx);

    if (ctx.report.clawback_seen === true) {
      for (const attempt of planned.fill) {
        if (this.stoppedReason !== null || done >= planned.budget) break;
        if (await this.runAttempt(attempt, ctx, round)) done += 1;
      }
    }

    ctx.report.balance_after_sats = await this.balance(ctx.vaultAddress);
    this.rounds.push(ctx.report);
    return this.stoppedReason === null && ctx.report.clawback_seen !== false;
  }

  private async openRoundContext(index: number, round: PublicRound): Promise<RoundContext | null> {
    const key = parseNearKey(round.near_function_call_key); // validated by roundProblem
    this.publicKeys.add(key.publicKeyString);
    const vaultId = round.vault_id as string;
    let vault: Vault;
    let kit: VaultKit;
    try {
      vault = await this.ports.near.getVault(vaultId);
      kit = await this.ports.near.getVaultKit(vaultId);
    } catch (error) {
      this.stop(`round ${round.round} views failed: ${message(error)}`);
      return null;
    }
    const watcherPk = String(vault.policy?.watcher_x25519_pk ?? "");
    try {
      sealWatcherEnvelope("normal", watcherPk);
    } catch {
      this.stop(`round ${round.round} Vault has no usable watcher_x25519_pk`);
      return null;
    }
    // The Challenge Vault must refuse every Allowance spend: with any other limit an attack
    // would spend from the Allowance for real.
    const allowanceLimit = String(vault.policy?.allowance_limit_sats ?? "unset");
    if (allowanceLimit !== "0") {
      this.stop(
        `round ${round.round} Vault has allowance_limit_sats ${allowanceLimit}, not 0: the Challenge Vault must refuse every Allowance spend`,
      );
      return null;
    }
    const vaultAddress = vault.addresses?.vault ?? round.vault_address ?? "";
    const utxos = await this.confirmedUtxos(vaultAddress);
    const coins = (utxos ?? []).map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value_sats: u.value_sats,
    }));
    return {
      report: {
        round: index,
        challenge_round: round.round,
        vault_id: vaultId,
        vault_address: vaultAddress,
        funding_txid: round.funding_txid,
        balance_before_sats: utxos === null ? null : satsNum(String(utxoSats(utxos))),
        balance_after_sats: null,
        request_tx_hash: null,
        request_op_id: null,
        clawback_seen: null,
        clawback_op_id: null,
        clawback_txid: null,
        clawback_broadcast: null,
        policy_change_id: null,
        policy_change_outcome: null,
      },
      key,
      ownerSecret: hexToBytes(round.owner_key_secret),
      ownerAccount: round.owner_account,
      vaultContract: round.vault_contract,
      vaultId,
      btc: round.btc_network,
      kit,
      watcherPk,
      utxos,
      coins,
      vaultAddress,
      ownOpId: null,
      requestOutcome: null,
      redirectedTo: null,
      vetoDue: false,
    };
  }

  private async confirmedUtxos(address: string): Promise<Utxo[] | null> {
    if (!address) return [];
    try {
      return (await this.ports.bitcoin.getUtxos(address)).filter((u) => u.height !== null);
    } catch {
      return null;
    }
  }

  /** Runs one planned attempt and records it; false when it was skipped for lack of a target. */
  private async runAttempt(
    attempt: PlannedAttempt,
    ctx: RoundContext,
    round: PublicRound,
  ): Promise<boolean> {
    if (CATEGORIES[attempt.category].method === null) {
      await this.runBitcoin(attempt, ctx);
      return true;
    }
    if (!(await this.allowanceOk(ctx, round))) return false;
    const planned = this.planMove(attempt.move, ctx);
    if (!planned) return false; // no target (e.g. Execute with no request of ours)
    const result = await this.ports.near.call(ctx.key, planned.plan);
    this.recordCall(attempt, planned.plan, result, ctx, planned.harmless);
    return true;
  }

  /** The window attempts, sent at once (consecutive nonces, concurrent `send_tx`). */
  private async runWindow(
    batch: PlannedAttempt[],
    ctx: RoundContext,
    round: PublicRound,
  ): Promise<number> {
    if (!(await this.allowanceOk(ctx, round))) return 0;
    const planned = batch.flatMap((attempt) => {
      const move = this.planMove(attempt.move, ctx);
      return move ? [{ attempt, ...move }] : [];
    });
    if (planned.length === 0) return 0;
    const results = await this.ports.near.callBatch(
      ctx.key,
      planned.map((p) => p.plan),
    );
    planned.forEach((p, i) =>
      this.recordCall(p.attempt, p.plan, results[i] as CallResult, ctx, p.harmless),
    );
    return planned.length;
  }

  private planMove(move: Move, ctx: RoundContext): { plan: CallPlan; harmless: boolean } | null {
    const base = { signerId: ctx.ownerAccount, receiverId: ctx.vaultContract };
    const envelope = () => this.envelope(ctx.watcherPk);
    const coins = ctx.coins.length > 0 ? ctx.coins : [DECOY_COIN];
    const destination = () => this.attackerAddress(ctx.btc);
    const call = (method: string, args: object, harmless = false) => ({
      plan: { ...base, method, args },
      harmless,
    });
    const smallSpend = () => ({
      vault_id: ctx.vaultId,
      amount_sats: "1000",
      destination: destination(),
      fee_rate_sat_vb: FEE_RATE_SAT_VB,
      utxos: coins,
      envelope: envelope(),
    });
    switch (move) {
      case "clawback_as_owner":
        return call("begin_clawback", {
          vault_id: ctx.vaultId,
          utxos: coins,
          fee_rate_sat_vb: FEE_RATE_SAT_VB,
        });
      case "bad_envelope":
        return call("request_withdrawal", { ...smallSpend(), envelope: BAD_ENVELOPE });
      case "allowance_over_limit":
      case "allowance_after_clawback":
        return call("spend_allowance", smallSpend());
      case "refresh_over_fee_cap":
        // A decoy outpoint: even a Refresh the Fee Cap let through would never hold the real coin.
        return call("refresh", {
          vault_id: ctx.vaultId,
          fee_rate_sat_vb: OVER_CAP_FEE_RATE,
          utxos: [DECOY_COIN],
          envelope: envelope(),
        });
      case "policy_change_script_bound":
        // The Escape Timelock is Script-bound: no Policy Change may shorten it.
        return call("propose_policy_change", {
          vault_id: ctx.vaultId,
          changes: { escape_timelock_blocks: 1 },
          envelope: envelope(),
        });
      case "full_request":
      case "same_coins_request":
      case "request_after_clawback": {
        if (ctx.coins.length === 0) return null;
        const amount = requestAmount(ctx.coins);
        if (amount <= 0n) return null;
        return call("request_withdrawal", {
          vault_id: ctx.vaultId,
          amount_sats: amount.toString(),
          destination: destination(),
          fee_rate_sat_vb: FEE_RATE_SAT_VB,
          utxos: ctx.coins,
          envelope: envelope(),
        });
      }
      case "execute_early":
      case "execute_after_clawback":
        if (ctx.ownOpId === null) return null;
        return call("begin_execute", { op_id: ctx.ownOpId, envelope: envelope() });
      case "sign_before_freeze":
      case "sign_after_clawback":
        if (ctx.ownOpId === null) return null;
        return call("sign_input", { op_id: ctx.ownOpId, input_index: 0 });
      case "refresh_after_clawback":
        return call("refresh", {
          vault_id: ctx.vaultId,
          fee_rate_sat_vb: FEE_RATE_SAT_VB,
          utxos: coins,
          envelope: envelope(),
        });
      case "policy_change_redirect_recovery":
        // TH-12: the thief points the Recovery Address at an attacker address and waits.
        return call("propose_policy_change", {
          vault_id: ctx.vaultId,
          changes: { recovery_address: destination() },
          envelope: envelope(),
        });
      case "policy_change_apply_redirect":
        if (ctx.report.policy_change_id === null) return null;
        return call("apply_policy_change", { change_id: ctx.report.policy_change_id });
      case "policy_change_after_clawback":
        return call("propose_policy_change", {
          vault_id: ctx.vaultId,
          changes: { fee_cap_sats: "20000" },
          envelope: envelope(),
        });
      case "storage_no_deposit":
        return call("top_up_storage", { vault_id: ctx.vaultId }, true);
      default:
        return null;
    }
  }

  private newRecord(attempt: PlannedAttempt, ctx: RoundContext): AttemptRecord {
    return {
      id: this.nextId++,
      round: ctx.report.round,
      category: attempt.category,
      method: CATEGORIES[attempt.category].method,
      args: null,
      args_sha256: null,
      expected: attempt.expected,
      actual: "",
      actual_class: "unreadable",
      expected_match: false,
      unexpected: false,
      window_result: null,
      tx_hash: null,
      explorer: null,
      op_id: null,
      change_id: null,
      vault_id: null,
      log_entry: null,
      off_log: null,
      note: null,
    };
  }

  private recordCall(
    attempt: PlannedAttempt,
    plan: CallPlan,
    result: CallResult,
    ctx: RoundContext,
    harmless: boolean,
  ): void {
    const record = this.newRecord(attempt, ctx);
    record.method = plan.method;
    record.args = plan.args;
    record.args_sha256 = sha256(canonicalJson(plan.args));

    if (result.kind === "accepted") {
      record.tx_hash = result.hash;
      record.explorer = this.nearLink(result.hash);
      if (harmless) {
        record.actual = "allowed_harmless";
        record.actual_class = "allowed_harmless";
        record.expected_match = attempt.expected.includes("harmless");
      } else {
        record.actual = "accepted";
        record.actual_class = "accepted";
        record.expected_match = attempt.expected.includes("accepted");
        if (typeof result.value === "string") {
          if (attempt.category === "withdrawal_request") record.op_id = result.value;
          if (attempt.category === "policy_change") record.change_id = result.value;
          if (record.op_id !== null || record.change_id !== null) record.vault_id = ctx.vaultId;
        }
      }
      // Accepted where a refusal was expected.
      record.unexpected = !record.expected_match;
    } else if (result.kind === "refused") {
      record.tx_hash = result.hash;
      record.explorer = this.nearLink(result.hash);
      record.actual = result.code ?? result.failure;
      record.actual_class = "refused";
      // Each move lists its own codes: ERR_CLAWED_BACK only where the Clawback may come first
      // (window attempts) or must have come (the fill).
      record.expected_match = attempt.expected.includes(record.actual);
    } else if (result.kind === "not_included") {
      record.tx_hash = result.hash;
      record.actual = `not_included:${result.reason}`;
      record.actual_class = "off_log";
      record.off_log = { kind: "pre_inclusion", reason: result.reason, error: result.error };
      // Refused before inclusion: nothing happened on chain, so it is no violation.
      record.expected_match = true;
      if (result.reason === "allowance") {
        this.stop(
          `published key out of gas allowance (NotEnoughAllowance): ${result.error}`,
          "allowance",
        );
      } else if (result.reason === "key_missing") {
        this.stop(`published key gone (AccessKeyNotFound): ${result.error}`, "allowance");
      }
    } else {
      record.tx_hash = result.hash;
      record.actual = "unreadable";
      record.actual_class = "unreadable";
      record.note = result.error;
    }
    if (attempt.phase === "window" && record.actual_class === "refused") {
      record.window_result = record.actual === "ERR_CLAWED_BACK" ? "clawed_back" : "own_code";
    }
    if (attempt.move === "full_request") {
      ctx.requestOutcome = record.actual;
      if (record.actual_class === "accepted") {
        ctx.ownOpId = record.op_id;
        ctx.report.request_tx_hash = record.tx_hash;
        ctx.report.request_op_id = record.op_id;
      }
    }
    if (attempt.move === "policy_change_redirect_recovery") {
      this.redirectIds.add(record.id);
      if (record.actual_class === "accepted") {
        const changes = (plan.args as { changes?: { recovery_address?: string } }).changes;
        ctx.redirectedTo = changes?.recovery_address ?? null;
        ctx.report.policy_change_id = record.change_id;
        // Accepted, but with no change id to follow: the veto cannot be checked.
        if (record.change_id === null) ctx.report.policy_change_outcome = "unreadable";
        else ctx.vetoDue = true;
      }
    }
    this.attempts.push(record);
  }

  private async runBitcoin(attempt: PlannedAttempt, ctx: RoundContext): Promise<void> {
    const path: OwnerSpendPath = attempt.move === "escape_early" ? "escape" : "no_cosigner";
    const record = this.newRecord(attempt, ctx);
    const finish = (cls: AttemptRecord["actual_class"], actual: string, note: string | null) => {
      record.actual_class = cls;
      record.actual = actual;
      record.note = note;
      this.attempts.push(record);
    };
    if (ctx.utxos === null) return finish("unreadable", "unreadable", "Vault coins unreadable");
    if (ctx.kit.vault_script_hex.startsWith("mock-")) {
      return finish("skipped", "skipped", "mock Vault kit: no script to spend");
    }
    if (ctx.utxos.length === 0) return finish("skipped", "skipped", "no confirmed Vault coin");
    if (path === "escape") {
      let tip: number;
      try {
        tip = await this.ports.bitcoin.getTipHeight();
      } catch (error) {
        return finish("unreadable", "unreadable", `tip height unreadable: ${message(error)}`);
      }
      const matured = ctx.utxos.some(
        (u) => tip - (u.height as number) + 1 >= ctx.kit.escape_timelock_blocks,
      );
      // A matured coin would really escape: never broadcast it.
      if (matured) return finish("skipped", "skipped", "coin matured");
    }
    let spend: ReturnType<typeof buildOwnerSpend>;
    try {
      spend = buildOwnerSpend({
        kit: ctx.kit,
        coins: ctx.coins,
        ownerSecretKey: ctx.ownerSecret,
        destination: this.attackerAddress(ctx.btc),
        feeRateSatVb: FEE_RATE_SAT_VB,
        path,
      });
    } catch (error) {
      return finish("unreadable", "unreadable", `could not build the spend: ${message(error)}`);
    }
    record.tx_hash = spend.txid;
    record.args_sha256 = sha256(spend.rawHex);
    try {
      await this.ports.bitcoin.broadcast(spend.rawHex);
      // The node took an Owner-Key-only spend of Vault coins: the run fails.
      record.off_log = { kind: "bitcoin", raw_hex: spend.rawHex, txid: spend.txid, rejection: "" };
      record.explorer = bitcoinTxUrl(ctx.btc, spend.txid);
      record.expected_match = false;
      record.unexpected = true;
      return finish("off_log", "broadcast_accepted", null);
    } catch (error) {
      const rejection = nodeRejection(error);
      if (rejection === null) {
        return finish("unreadable", "unreadable", `broadcast unreadable: ${message(error)}`);
      }
      record.off_log = { kind: "bitcoin", raw_hex: spend.rawHex, txid: spend.txid, rejection };
      record.expected_match = REJECTION[path].test(rejection);
      return finish("off_log", record.expected_match ? "rejected" : "rejected:other_reason", null);
    }
  }

  /**
   * Polls `get_vault` until the Vault reads `clawed_back`, then reads the Clawback op and txid
   * from the feed. Not seen within the wait: `clawback_seen: false`, which fails the run.
   */
  private async awaitClawback(ctx: RoundContext): Promise<void> {
    const deadline = this.ports.clock.now() + this.clawbackWaitMs;
    for (;;) {
      const info = await this.ports.watcher.tick(ctx.vaultId).catch(() => null);
      if (info) {
        ctx.report.clawback_op_id = info.op_id;
        ctx.report.clawback_txid = info.txid;
      }
      const state = await this.ports.near
        .getVault(ctx.vaultId)
        .then((v) => v.state)
        .catch(() => null);
      if (state === "clawed_back") {
        ctx.report.clawback_seen = true;
        await this.readClawbackFromFeed(ctx);
        return;
      }
      if (this.ports.clock.now() >= deadline) {
        ctx.report.clawback_seen = false;
        return;
      }
      await this.ports.clock.sleep(CLAWBACK_POLL_MS);
    }
  }

  /**
   * Polls `get_vault` until the redirect is no longer the pending change, then reads its outcome
   * from the feed, within the Clawback's wait. `vetoed` is the expected end; `withdrawn` (another
   * holder of the published Owner Key took it back) can never apply either. A Policy showing the
   * redirected address reads `applied`; a change still pending at the end reads `pending`. Any
   * other end lands in `veto_missing`, which fails the run.
   */
  private async awaitVeto(ctx: RoundContext): Promise<void> {
    ctx.vetoDue = false;
    const changeId = ctx.report.policy_change_id;
    if (changeId === null) return;
    const deadline = this.ports.clock.now() + this.clawbackWaitMs;
    for (;;) {
      await this.ports.watcher.tick(ctx.vaultId).catch(() => null);
      const vault = await this.ports.near.getVault(ctx.vaultId).catch(() => null);
      if (
        vault &&
        ctx.redirectedTo !== null &&
        vault.policy?.recovery_address === ctx.redirectedTo
      ) {
        ctx.report.policy_change_outcome = "applied";
        return;
      }
      const pending = vault?.pending_change?.change_id === changeId;
      if (vault && !pending) {
        const views = await this.ports.feed.entries().catch(() => [] as LogEntryView[]);
        const entry = views.find(
          (v) =>
            v.type === "policy_change" && v.change_id === changeId && v.vault_id === ctx.vaultId,
        );
        if (entry?.outcome && entry.outcome !== "pending") {
          ctx.report.policy_change_outcome = entry.outcome;
          return;
        }
      }
      if (this.ports.clock.now() >= deadline) {
        ctx.report.policy_change_outcome =
          vault === null ? "unreadable" : pending ? "pending" : "unread";
        return;
      }
      await this.ports.clock.sleep(CLAWBACK_POLL_MS);
    }
  }

  private async readClawbackFromFeed(ctx: RoundContext): Promise<void> {
    if (ctx.ownOpId === null) return;
    const views = await this.ports.feed.entries().catch(() => [] as LogEntryView[]);
    const own = views.find(
      (v) => v.type === "withdrawal" && v.op_id === ctx.ownOpId && v.vault_id === ctx.vaultId,
    );
    if (!own) return;
    ctx.report.clawback_op_id = own.clawback_op_id ?? ctx.report.clawback_op_id;
    ctx.report.clawback_txid = own.clawback_txid ?? ctx.report.clawback_txid;
    ctx.report.clawback_broadcast = own.clawback_broadcast;
  }

  /**
   * Reads the key's remaining allowance before a call. Below 0.05 NEAR or gone, it asks `/round`
   * once for a rotated key and continues with it; only when no fresh key is served does it stop
   * the run cleanly with a `stopped_reason`.
   */
  private async allowanceOk(ctx: RoundContext, round: PublicRound): Promise<boolean> {
    const read = () => this.ports.near.accessKey(ctx.ownerAccount, ctx.key.publicKeyString);
    const low = (state: Awaited<ReturnType<typeof read>>) =>
      state !== "unreachable" &&
      (!state.exists ||
        (state.allowanceYocto !== null && state.allowanceYocto < MIN_ALLOWANCE_YOCTO));
    const state = await read();
    if (!low(state)) return true; // an unreachable read: the call itself will report
    if ((await this.pickUpRotatedKey(ctx, round)) && !low(await read())) return true;
    this.stop(
      state !== "unreachable" && state.exists
        ? "published key below 0.05 NEAR allowance and /round served no new key"
        : "published key is gone and /round served no new key",
      "allowance",
    );
    return false;
  }

  /** Picks up a key rotated mid-run from `/round`; both public keys stay in the header. */
  private async pickUpRotatedKey(ctx: RoundContext, round: PublicRound): Promise<boolean> {
    const current = await this.ports.rounds.current().catch(() => null);
    if (!current || current.round !== round.round) return false;
    if (current.near_function_call_key === round.near_function_call_key) return false;
    try {
      const key = parseNearKey(current.near_function_call_key);
      ctx.key = key;
      this.publicKeys.add(key.publicKeyString);
      round.near_function_call_key = current.near_function_call_key;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Polls the feed every 15 s up to `logWaitMs` until every on-chain attempt is matched. An
   * unreadable attempt with a hash is looked up too: found, it takes the outcome the log records.
   */
  private async matchLog(): Promise<void> {
    const pending = () =>
      this.attempts.filter(
        (a) =>
          a.log_entry === null &&
          (needsLog(a) || (a.actual_class === "unreadable" && a.tx_hash !== null && a.method)),
      );
    if (pending().length === 0) return;
    const deadline = this.ports.clock.now() + this.logWaitMs;
    for (;;) {
      const views = await this.ports.feed.entries().catch(() => [] as LogEntryView[]);
      for (const attempt of pending()) {
        const hit = views.find((v) => matches(attempt, v));
        if (!hit) continue;
        const wasUnreadable = attempt.actual_class === "unreadable";
        reconcile(attempt, hit);
        if (wasUnreadable) this.followReconciledRedirect(attempt, hit);
      }
      if (pending().length === 0) return;
      if (this.ports.clock.now() >= deadline) return;
      await this.ports.clock.sleep(LOG_POLL_MS);
    }
  }

  /**
   * A redirect whose answer was unreadable but that the log shows accepted: its veto was never
   * awaited, so the round takes the change id and outcome the log shows (`pending` fails).
   */
  private followReconciledRedirect(attempt: AttemptRecord, view: LogEntryView): void {
    if (!this.redirectIds.has(attempt.id) || attempt.actual_class !== "accepted") return;
    const round = this.rounds.find((r) => r.round === attempt.round);
    if (!round || round.policy_change_outcome !== null) return;
    round.policy_change_id = view.change_id;
    round.policy_change_outcome =
      view.change_id === null ? "unreadable" : (view.outcome ?? "unread");
  }

  private async readAttackerBalances(): Promise<AttackerAddress[]> {
    const out: AttackerAddress[] = [];
    for (const address of this.attackerAddresses) {
      let sats: number | null;
      try {
        sats = satsNum(String(utxoSats(await this.ports.bitcoin.getUtxos(address))));
      } catch {
        sats = null; // unreadable: the run cannot prove 0 sats, so it fails
      }
      out.push({ address, final_balance_sats: sats });
    }
    return out;
  }

  /** A P2WPKH destination from 20 bytes of the seeded RNG; recorded for the balance check. */
  private attackerAddress(btc: BtcNetwork): string {
    const program = Uint8Array.from({ length: 20 }, () =>
      Math.floor(this.destinationRandom() * 256),
    );
    const address = p2wpkhAddress(program, btc);
    this.attackerAddresses.add(address);
    return address;
  }

  private nearLink(hash: string): string | null {
    return this.network === "mock" ? null : nearTxUrl(this.params.nearNetwork, hash);
  }

  private async safe<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  private async balance(address: string): Promise<number | null> {
    const utxos = await this.confirmedUtxos(address);
    return utxos === null ? null : satsNum(String(utxoSats(utxos)));
  }
}

/** Ends of an accepted redirect that do not fail the run (only `vetoed` proves the veto). */
const VETO_ENDS: ReadonlySet<RedirectOutcome> = new Set(["vetoed", "withdrawn"]);

/** A coin that is not the Vault's, for refusals whose inputs do not matter. */
export const DECOY_COIN: Outpoint = { txid: "ef".repeat(32), vout: 7, value_sats: "100000" };

/** A refused contract call or an accepted request must appear in the Attempt Log. */
function needsLog(attempt: AttemptRecord): boolean {
  if (attempt.actual_class === "refused") return true;
  return (
    attempt.actual_class === "accepted" &&
    (attempt.category === "withdrawal_request" || attempt.category === "policy_change")
  );
}

function matches(attempt: AttemptRecord, view: LogEntryView): boolean {
  // Rejected calls and scanned requests match by NEAR tx hash.
  if (attempt.tx_hash && view.tx_hash && attempt.tx_hash === view.tx_hash) return true;
  // An entry whose tx hash the feed has not scanned yet: Vault id + id, within one number space
  // (a withdrawal's op id and a Policy Change's change id are different counters).
  const idType =
    attempt.category === "withdrawal_request"
      ? "withdrawal"
      : attempt.category === "policy_change"
        ? "policy_change"
        : null;
  const id = idType === "withdrawal" ? attempt.op_id : attempt.change_id;
  const viewId = idType === "withdrawal" ? view.op_id : view.change_id;
  return (
    view.type === idType &&
    id !== null &&
    id === viewId &&
    attempt.vault_id !== null &&
    attempt.vault_id === view.vault_id
  );
}

/** Records the log match; an unreadable attempt takes the outcome the log shows. */
function reconcile(attempt: AttemptRecord, view: LogEntryView): void {
  attempt.log_entry = view.n;
  if (attempt.actual_class !== "unreadable") return;
  if (view.type === "rejected") {
    attempt.actual = view.code ?? "refused";
    attempt.actual_class = "refused";
    attempt.expected_match = attempt.expected.includes(attempt.actual);
  } else {
    attempt.actual = "accepted";
    attempt.actual_class = "accepted";
    attempt.expected_match = attempt.expected.includes("accepted");
    attempt.unexpected = !attempt.expected_match;
    attempt.op_id = view.op_id;
    attempt.change_id = view.change_id;
    attempt.vault_id = view.vault_id;
  }
  attempt.note = `${attempt.note ?? "unreadable answer"}; outcome read from Attempt Log entry ${view.n}`;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/** Runs an attack and returns the report and the process exit code (`passed ? 0 : 1`). */
export async function runAttack(
  ports: AttackPorts,
  params: AttackParams,
): Promise<{ report: AttackReport; exitCode: number }> {
  const report = await new AttackRun(ports, params).execute();
  return { report, exitCode: report.summary.passed ? 0 : 1 };
}
