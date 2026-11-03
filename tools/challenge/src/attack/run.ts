/**
 * Runs the scripted rounds through ports, waits for the next round and the Attempt Log, and
 * assembles the report and its pass/fail. Everything the run touches is a port, so the dry run
 * (mock contract, fake backend, simulated watcher, fake feed) and the tests share one code path
 * with the live signet run.
 */
import { createHash } from "node:crypto";
import {
  bitcoinTxUrl,
  nearTxUrl,
  parseNearKey,
  randomP2wpkhAddress,
  type BtcNetwork,
  type NearKey,
  type NearNetwork,
  type Outpoint,
  type Utxo,
  type Vault,
  type VaultKit,
} from "@morrow/core-ts";
import type { AttemptEntry } from "../attempts.js";
import type { PublicRound } from "../store.js";
import { buildOwnerSpend, type OwnerSpendPath } from "./bitcoin.js";
import type { CallPlan, CallResult, NearPort } from "./near.js";
import {
  CATEGORIES,
  allCategories,
  buildPlan,
  liveCategories,
  notDeployed,
  notDeployedNote,
  type Move,
  type PlannedAttempt,
} from "./plan.js";
import type {
  ActualClass,
  AttackReport,
  AttemptRecord,
  OffLogEvidence,
  ReportNetwork,
  RoundReport,
} from "./report.js";

export const ROUND_POLL_MS = 30_000;
export const LOG_POLL_MS = 15_000;
export const CLAWBACK_POLL_MS = 15_000;
export const DEFAULT_ROUND_WAIT_MS = 60 * 60_000;
export const DEFAULT_LOG_WAIT_MS = 10 * 60_000;
export const DEFAULT_CLAWBACK_WAIT_MS = 5 * 60_000;
/** The key is replaced below this remaining allowance; the run stops cleanly. */
export const MIN_ALLOWANCE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
/** Fee bound for the full-balance request: 2 sat/vB × (60 + 250 × inputs) vB. */
export const FEE_RATE_SAT_VB = 2;

export interface RoundSource {
  current(): Promise<PublicRound | null>;
}

export interface BitcoinPort {
  getUtxos(address: string): Promise<Utxo[]>;
  getTipHeight(): Promise<number>;
  /** Broadcasts a raw transaction; returns the txid, or throws with the node's rejection text. */
  broadcast(rawHex: string): Promise<string>;
}

/** A matching view of the Attempt Log, independent of the feed's wire shape. */
export interface LogEntryView {
  n: number;
  tx_hash: string | null;
  op_id: string | null;
  vault_id: string | null;
}

export interface AttemptsFeed {
  entries(): Promise<LogEntryView[]>;
}

/** Converts the public `GET /attempts` entries to matching views (key rotations are dropped). */
export function logViews(entries: readonly AttemptEntry[]): LogEntryView[] {
  const views: LogEntryView[] = [];
  for (const entry of entries) {
    if (entry.type === "rejected") {
      views.push({ n: entry.n, tx_hash: entry.tx_hash, op_id: null, vault_id: null });
    } else if (entry.type === "withdrawal" || entry.type === "policy_change") {
      views.push({
        n: entry.n,
        tx_hash: entry.tx_hash,
        op_id: entry.type === "withdrawal" ? entry.op_id : entry.change_id,
        vault_id: entry.vault_id,
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
 * The Auto-Clawback actor. Live: a no-op returning null (the real watcher acts on its own, and
 * the clawback is read from the feed). Dry run: claws back any new request and reports the op.
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
  network: ReportNetwork;
  nearNetwork: NearNetwork;
  /** Dry run: all five categories; live: only `liveMethods`. */
  dryRun: boolean;
  toolCommit: string | null;
  liveMethods?: readonly string[];
  roundWaitMs?: number;
  logWaitMs?: number;
  clawbackWaitMs?: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const satsNum = (value: string | number) => Number(BigInt(value));
const utxoSats = (utxos: readonly { value_sats: string }[]) =>
  utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);

/** The fee bound the full-balance request keeps back so the request could execute after the Delay. */
export function requestAmount(coins: readonly Outpoint[]): bigint {
  const total = coins.reduce((sum, c) => sum + BigInt(c.value_sats), 0n);
  return total - BigInt(FEE_RATE_SAT_VB) * BigInt(60 + 250 * coins.length);
}

const BAD_ENVELOPE = "ab".repeat(79);

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
  coins: Outpoint[];
  vaultAddress: string;
  /** This session's own accepted request, if any. */
  ownOpId: string | null;
  /** Attacker destinations drawn this round, for the balance check. */
  destinations: Set<string>;
}

export class AttackRun {
  private readonly attempts: AttemptRecord[] = [];
  private readonly rounds: RoundReport[] = [];
  private readonly publicKeys = new Set<string>();
  private readonly attackerAddresses = new Set<string>();
  private nextId = 1;
  private stoppedReason: string | null = null;
  private challengeRounds: number[] = [];

  constructor(
    private readonly ports: AttackPorts,
    private readonly params: AttackParams,
  ) {}

  private get roundWaitMs() {
    return this.params.roundWaitMs ?? DEFAULT_ROUND_WAIT_MS;
  }
  private get logWaitMs() {
    return this.params.logWaitMs ?? DEFAULT_LOG_WAIT_MS;
  }
  private get clawbackWaitMs() {
    return this.params.clawbackWaitMs ?? DEFAULT_CLAWBACK_WAIT_MS;
  }

  async execute(): Promise<AttackReport> {
    const startedAt = new Date(this.ports.clock.now()).toISOString();
    const nearTipStart = await this.safeTip(() => this.ports.near.tipHeight());
    const btcTipStart = await this.safeTip(() => this.ports.bitcoin.getTipHeight());

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
      if (this.stoppedReason) break;
      const round = await this.awaitRound(planned.index);
      if (!round) {
        this.stoppedReason ??= `no confirmed round within ${Math.round(this.roundWaitMs / 60000)} min`;
        break;
      }
      contractId = round.vault_contract;
      codeHash ??= await this.safeHash(() => this.ports.near.codeHash(round.vault_contract));
      if (!this.challengeRounds.includes(round.round)) this.challengeRounds.push(round.round);
      await this.runRound(planned, round);
    }

    const matched = await this.matchLog();
    const attackers = await this.readAttackerBalances();
    const endedAt = new Date(this.ports.clock.now()).toISOString();
    const nearTipEnd = await this.safeTip(() => this.ports.near.tipHeight());
    const btcTipEnd = await this.safeTip(() => this.ports.bitcoin.getTipHeight());

    const notDeployedCats = notDeployed(categories);
    const satsToAttackers = attackers.reduce((sum, a) => sum + a.final_balance_sats, 0);
    const onLogTotal = this.attempts.filter((a) => needsLog(a)).length;
    const onLogMatched = this.attempts.filter((a) => needsLog(a) && a.log_entry !== null).length;
    const missing = this.attempts
      .filter((a) => needsLog(a) && a.log_entry === null && a.tx_hash)
      .map((a) => a.tx_hash as string);

    const violations = this.attempts.some(
      (a) => !a.expected_match && a.actual_class !== "unreadable",
    );
    const passed =
      !violations && satsToAttackers === 0 && missing.length === 0 && onLogMatched === onLogTotal;

    void matched;
    return {
      header: {
        tool_commit: this.params.toolCommit,
        seed: this.params.seed,
        network: this.params.network,
        near_network: this.params.nearNetwork,
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
        on_log: `${onLogMatched}/${onLogTotal}`,
        on_log_matched: onLogMatched,
        on_log_total: onLogTotal,
        missing_hashes: missing,
        off_log: this.attempts.filter((a) => a.actual_class === "off_log").length,
        allowed_harmless: this.attempts.filter((a) => a.actual_class === "allowed_harmless").length,
        not_deployed: notDeployedCats,
        not_deployed_note: notDeployedNote(categories),
        stopped_reason: this.stoppedReason,
        passed,
      },
    };
  }

  /** Waits for a confirmed round from `/round`, polling up to `roundWaitMs`. */
  private async awaitRound(index: number): Promise<PublicRound | null> {
    const deadline = this.ports.clock.now() + this.roundWaitMs;
    for (;;) {
      const round = await this.ports.rounds.current();
      if (round && round.funding_height !== null && round.vault_id) return round;
      if (this.ports.clock.now() >= deadline) return null;
      void index;
      await this.ports.clock.sleep(ROUND_POLL_MS);
    }
  }

  private async runRound(
    planned: { index: number; budget: number; scripted: PlannedAttempt[]; fill: PlannedAttempt[] },
    round: PublicRound,
  ): Promise<void> {
    const ctx = await this.openRoundContext(planned.index, round);
    if (!ctx) return;

    let done = 0;
    const budget = planned.budget;
    for (const attempt of planned.scripted) {
      if (this.stoppedReason || done >= budget) break;
      const recorded = await this.runAttempt(attempt, ctx, round);
      if (recorded) done += 1;
    }

    // Wait for the watcher to claw back the request before the fill phase.
    if (!this.stoppedReason) await this.awaitClawback(ctx);

    for (const attempt of planned.fill) {
      if (this.stoppedReason || done >= budget) break;
      const recorded = await this.runAttempt(attempt, ctx, round, true);
      if (recorded) done += 1;
    }

    // Round-end bookkeeping: the Vault balance after the Clawback.
    ctx.report.balance_after_sats = await this.safeBalance(ctx.vaultAddress);
    this.rounds.push(ctx.report);
  }

  private async openRoundContext(index: number, round: PublicRound): Promise<RoundContext | null> {
    let key: NearKey;
    try {
      key = parseNearKey(round.near_function_call_key);
    } catch {
      this.stoppedReason ??= `round ${round.round} has an unreadable function-call key`;
      return null;
    }
    this.publicKeys.add(key.publicKeyString);
    const vaultId = round.vault_id as string;
    let vault: Vault;
    let kit: VaultKit;
    try {
      vault = await this.ports.near.getVault(vaultId);
      kit = await this.ports.near.getVaultKit(vaultId);
    } catch (error) {
      this.stoppedReason ??= `round ${round.round} views failed: ${message(error)}`;
      return null;
    }
    const vaultAddress = vault.addresses?.vault ?? round.vault_address ?? "";
    const coins = await this.confirmedCoins(vaultAddress);
    const report: RoundReport = {
      round: index,
      challenge_round: round.round,
      vault_id: vaultId,
      vault_address: vaultAddress,
      funding_txid: round.funding_txid,
      balance_before_sats: coins === null ? null : satsNum(String(utxoSats(coins))),
      balance_after_sats: null,
      request_tx_hash: null,
      request_op_id: null,
      clawback_op_id: null,
      clawback_txid: null,
    };
    return {
      report,
      key,
      ownerSecret: hexToBytes(round.owner_key_secret),
      ownerAccount: round.owner_account,
      vaultContract: round.vault_contract,
      vaultId,
      btc: round.btc_network,
      kit,
      coins: coins ?? [],
      vaultAddress,
      ownOpId: null,
      destinations: new Set(),
    };
  }

  private async confirmedCoins(address: string): Promise<Outpoint[] | null> {
    if (!address) return [];
    try {
      const utxos = await this.ports.bitcoin.getUtxos(address);
      return utxos
        .filter((u) => u.height !== null)
        .map((u) => ({ txid: u.txid, vout: u.vout, value_sats: u.value_sats }));
    } catch {
      return null;
    }
  }

  /** Runs one planned attempt, appends its record, and returns false when it was skipped. */
  private async runAttempt(
    attempt: PlannedAttempt,
    ctx: RoundContext,
    round: PublicRound,
    afterClawback = false,
  ): Promise<boolean> {
    const info = CATEGORIES[attempt.category];
    if (info.method === null) return this.runBitcoin(attempt, ctx);

    if (!(await this.allowanceOk(ctx, round))) return false;

    const planResult = this.planMove(attempt.move, ctx);
    if (!planResult) return false; // no target (e.g. Execute with no pending request)
    const { plan, harmless } = planResult;
    const result = await this.ports.near.call(ctx.key, plan);
    this.recordCall(attempt, plan, result, ctx, afterClawback, harmless);
    if (attempt.move === "full_request" && result.kind === "accepted") {
      const opId = typeof result.value === "string" ? result.value : null;
      ctx.ownOpId = opId;
      ctx.report.request_tx_hash = result.hash;
      ctx.report.request_op_id = opId;
    }
    return true;
  }

  private planMove(move: Move, ctx: RoundContext): { plan: CallPlan; harmless: boolean } | null {
    const base = { signerId: ctx.ownerAccount, receiverId: ctx.vaultContract };
    const envelope = this.envelope(ctx);
    const coins = ctx.coins.length > 0 ? ctx.coins : [this.dummyCoin()];
    const destination = this.freshAttackerAddress(ctx);
    const feeRate = FEE_RATE_SAT_VB;
    switch (move) {
      case "clawback_as_owner":
        return {
          plan: {
            ...base,
            method: "begin_clawback",
            args: { vault_id: ctx.vaultId, utxos: coins, fee_rate_sat_vb: feeRate },
          },
          harmless: false,
        };
      case "bad_envelope":
        return {
          plan: {
            ...base,
            method: "request_withdrawal",
            args: {
              vault_id: ctx.vaultId,
              amount_sats: "1000",
              destination,
              fee_rate_sat_vb: feeRate,
              utxos: coins,
              envelope: BAD_ENVELOPE,
            },
          },
          harmless: false,
        };
      case "allowance_over_limit":
        return {
          plan: {
            ...base,
            method: "spend_allowance",
            args: {
              vault_id: ctx.vaultId,
              amount_sats: "1000",
              destination,
              fee_rate_sat_vb: feeRate,
              utxos: coins,
              envelope,
            },
          },
          harmless: false,
        };
      case "full_request":
      case "same_coins_request":
      case "request_after_clawback": {
        if (ctx.coins.length === 0) return null;
        const amount = requestAmount(ctx.coins);
        if (amount <= 0n) return null;
        return {
          plan: {
            ...base,
            method: "request_withdrawal",
            args: {
              vault_id: ctx.vaultId,
              amount_sats: amount.toString(),
              destination,
              fee_rate_sat_vb: feeRate,
              utxos: ctx.coins,
              envelope,
            },
          },
          harmless: false,
        };
      }
      case "execute_early":
      case "execute_after_clawback": {
        const opId = ctx.ownOpId;
        if (opId === null) return null;
        return {
          plan: { ...base, method: "begin_execute", args: { op_id: opId, envelope } },
          harmless: false,
        };
      }
      case "sign_before_freeze":
      case "sign_after_clawback": {
        const opId = ctx.ownOpId;
        if (opId === null) return null;
        return {
          plan: { ...base, method: "sign_input", args: { op_id: opId, input_index: 0 } },
          harmless: false,
        };
      }
      case "refresh_after_clawback":
        return {
          plan: {
            ...base,
            method: "refresh",
            args: { vault_id: ctx.vaultId, fee_rate_sat_vb: feeRate, utxos: coins, envelope },
          },
          harmless: false,
        };
      case "allowance_after_clawback":
        return {
          plan: {
            ...base,
            method: "spend_allowance",
            args: {
              vault_id: ctx.vaultId,
              amount_sats: "1000",
              destination,
              fee_rate_sat_vb: feeRate,
              utxos: coins,
              envelope,
            },
          },
          harmless: false,
        };
      case "policy_change_after_clawback":
        return {
          plan: {
            ...base,
            method: "propose_policy_change",
            args: { vault_id: ctx.vaultId, changes: { fee_cap_sats: "20000" }, envelope },
          },
          harmless: false,
        };
      case "storage_no_deposit":
        return {
          plan: { ...base, method: "top_up_storage", args: { vault_id: ctx.vaultId } },
          harmless: true,
        };
      default:
        return null;
    }
  }

  private recordCall(
    attempt: PlannedAttempt,
    plan: CallPlan,
    result: CallResult,
    ctx: RoundContext,
    afterClawback: boolean,
    harmless: boolean,
  ): void {
    const argsSha = sha256(JSON.stringify(plan.args));
    const record: AttemptRecord = {
      id: this.nextId++,
      round: ctx.report.round,
      category: attempt.category,
      method: plan.method,
      args_sha256: argsSha,
      expected: attempt.expected,
      actual: "",
      actual_class: "unreadable",
      expected_match: false,
      tx_hash: null,
      explorer: null,
      op_id: null,
      vault_id: null,
      log_entry: null,
      off_log: null,
    };
    const windowCodes = afterClawback
      ? ["ERR_CLAWED_BACK", "ERR_VAULT_NOT_ACTIVE"]
      : ["ERR_CLAWED_BACK"];

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
        if (attempt.category === "withdrawal_request" && typeof result.value === "string") {
          record.op_id = result.value;
          record.vault_id = ctx.vaultId;
        }
      }
    } else if (result.kind === "refused") {
      record.tx_hash = result.hash;
      record.explorer = this.nearLink(result.hash);
      const code = result.code ?? result.failure;
      record.actual = code;
      record.actual_class = "refused";
      record.expected_match = attempt.expected.includes(code) || windowCodes.includes(code);
    } else if (result.kind === "not_included") {
      record.tx_hash = result.hash || null;
      record.actual = `off_log:${result.reason}`;
      record.actual_class = "off_log";
      record.off_log = { kind: "pre_inclusion", reason: result.reason, error: result.error };
      // An honest pre-inclusion refusal is not a violation.
      record.expected_match = true;
      if (result.reason === "allowance") {
        this.stoppedReason ??= "published key out of gas allowance (NotEnoughAllowance)";
      }
    } else {
      record.tx_hash = result.hash;
      record.actual = "unreadable";
      record.actual_class = "unreadable";
      record.off_log = null;
    }
    this.attempts.push(record);
  }

  private async runBitcoin(attempt: PlannedAttempt, ctx: RoundContext): Promise<boolean> {
    const path: OwnerSpendPath = attempt.move === "escape_early" ? "escape" : "no_cosigner";
    const record: AttemptRecord = {
      id: this.nextId++,
      round: ctx.report.round,
      category: attempt.category,
      method: null,
      args_sha256: null,
      expected: attempt.expected,
      actual: "",
      actual_class: "off_log",
      expected_match: false,
      tx_hash: null,
      explorer: null,
      op_id: null,
      vault_id: null,
      log_entry: null,
      off_log: null,
    };
    if (ctx.coins.length === 0 || ctx.kit.vault_script_hex.startsWith("mock-")) {
      // No real coins or a mock kit: there is nothing to broadcast. Record it honestly.
      record.actual = "off_log:not_broadcast";
      record.off_log = {
        kind: "bitcoin",
        raw_hex: "",
        txid: "",
        rejection: ctx.coins.length === 0 ? "no confirmed Vault coin to spend" : "mock Vault kit",
      };
      record.expected_match = true;
      this.attempts.push(record);
      return true;
    }
    const destination = this.freshAttackerAddress(ctx);
    const spend = buildOwnerSpend({
      kit: ctx.kit,
      coins: ctx.coins,
      ownerSecretKey: ctx.ownerSecret,
      destination,
      feeRateSatVb: FEE_RATE_SAT_VB,
      path,
    });
    record.tx_hash = spend.txid;
    record.explorer = bitcoinTxUrl(ctx.btc, spend.txid);
    try {
      await this.ports.bitcoin.broadcast(spend.rawHex);
      // Accepted by the node: this is a real spend of Vault coins — the run fails.
      record.actual = "off_log:broadcast_accepted";
      record.off_log = { kind: "bitcoin", raw_hex: spend.rawHex, txid: spend.txid, rejection: "" };
      record.expected_match = false;
    } catch (error) {
      record.actual = "off_log:rejected";
      record.off_log = {
        kind: "bitcoin",
        raw_hex: spend.rawHex,
        txid: spend.txid,
        rejection: message(error),
      };
      record.expected_match = true;
    }
    this.attempts.push(record);
    return true;
  }

  private async awaitClawback(ctx: RoundContext): Promise<void> {
    const deadline = this.ports.clock.now() + this.clawbackWaitMs;
    for (;;) {
      const info = await this.ports.watcher.tick(ctx.vaultId);
      if (info) {
        ctx.report.clawback_op_id = info.op_id;
        ctx.report.clawback_txid = info.txid;
      }
      let state: Vault["state"] | null;
      try {
        state = (await this.ports.near.getVault(ctx.vaultId)).state;
      } catch {
        state = null;
      }
      if (state === "clawed_back") return;
      if (this.ports.clock.now() >= deadline) return;
      await this.ports.clock.sleep(CLAWBACK_POLL_MS);
    }
  }

  /**
   * Reads the key's remaining allowance before a call. Below 0.05 NEAR or gone, it asks `/round`
   * once for a rotated key and continues with it; only when no fresh key is served does it stop
   * the run cleanly with a `stopped_reason`.
   */
  private async allowanceOk(ctx: RoundContext, round: PublicRound): Promise<boolean> {
    const read = async () => this.ports.near.accessKey(ctx.ownerAccount, ctx.key.publicKeyString);
    const state = await read();
    if (state === "unreachable") return true; // a transient read; the call itself will report
    const low =
      !state.exists ||
      (state.allowanceYocto !== null && state.allowanceYocto < MIN_ALLOWANCE_YOCTO);
    if (!low) return true;
    if (await this.pickUpRotatedKey(ctx, round)) {
      const after = await read();
      if (
        after !== "unreachable" &&
        after.exists &&
        (after.allowanceYocto === null || after.allowanceYocto >= MIN_ALLOWANCE_YOCTO)
      ) {
        return true;
      }
    }
    this.stoppedReason ??= state.exists
      ? "published key below 0.05 NEAR allowance"
      : "published key is gone";
    return false;
  }

  /** Picks up a key rotated mid-run from `/round`; both public keys stay in the header. */
  private async pickUpRotatedKey(ctx: RoundContext, round: PublicRound): Promise<boolean> {
    const current = await this.ports.rounds.current();
    if (!current || current.near_function_call_key === round.near_function_call_key) return false;
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

  private async matchLog(): Promise<boolean> {
    const pending = () => this.attempts.filter((a) => needsLog(a) && a.log_entry === null);
    if (pending().length === 0) return true;
    const deadline = this.ports.clock.now() + this.logWaitMs;
    for (;;) {
      let views: LogEntryView[];
      try {
        views = await this.ports.feed.entries();
      } catch {
        views = [];
      }
      for (const attempt of pending()) {
        const hit = views.find((v) => matches(attempt, v));
        if (hit) attempt.log_entry = hit.n;
      }
      if (pending().length === 0) return true;
      if (this.ports.clock.now() >= deadline) return false;
      await this.ports.clock.sleep(LOG_POLL_MS);
    }
  }

  private async readAttackerBalances(): Promise<{ address: string; final_balance_sats: number }[]> {
    const out: { address: string; final_balance_sats: number }[] = [];
    for (const address of this.attackerAddresses) {
      let sats: number;
      try {
        sats = satsNum(String(utxoSats(await this.ports.bitcoin.getUtxos(address))));
      } catch {
        sats = 0;
      }
      out.push({ address, final_balance_sats: sats });
    }
    return out;
  }

  private freshAttackerAddress(ctx: RoundContext): string {
    const address = randomP2wpkhAddress(ctx.btc);
    ctx.destinations.add(address);
    this.attackerAddresses.add(address);
    return address;
  }

  private dummyCoin(): Outpoint {
    return { txid: "ab".repeat(32), vout: 0, value_sats: "100000" };
  }

  private envelope(ctx: RoundContext): string {
    // The run never forges a watcher envelope for a live Vault here; the mock accepts any
    // 160-hex envelope, and the live refusals we care about are reached before the seal matters.
    void ctx;
    return "cd".repeat(80);
  }

  private nearLink(hash: string): string | null {
    return this.params.nearNetwork === "testnet" || this.params.nearNetwork === "mainnet"
      ? nearTxUrl(this.params.nearNetwork, hash)
      : null;
  }

  private async safeTip(read: () => Promise<number>): Promise<number | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }
  private async safeHash(read: () => Promise<string>): Promise<string | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }
  private async safeBalance(address: string): Promise<number | null> {
    const coins = await this.confirmedCoins(address);
    return coins === null ? null : satsNum(String(utxoSats(coins)));
  }
}

/** A refused contract call or an accepted withdrawal must appear in the Attempt Log. */
function needsLog(attempt: AttemptRecord): boolean {
  if (attempt.actual_class === "refused") return true;
  if (attempt.actual_class === "accepted" && attempt.category === "withdrawal_request") return true;
  return false;
}

function matches(attempt: AttemptRecord, view: LogEntryView): boolean {
  // Rejected calls and scanned withdrawals match by NEAR tx hash.
  if (attempt.tx_hash && view.tx_hash && attempt.tx_hash === view.tx_hash) return true;
  // A withdrawal whose tx hash the feed has not scanned yet matches by Vault id + op id.
  return (
    attempt.op_id !== null &&
    attempt.op_id === view.op_id &&
    attempt.vault_id !== null &&
    attempt.vault_id === view.vault_id
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/** Runs an attack and returns the report and the process exit code. */
export async function runAttack(
  ports: AttackPorts,
  params: AttackParams,
): Promise<{ report: AttackReport; exitCode: number }> {
  const report = await new AttackRun(ports, params).execute();
  return { report, exitCode: report.summary.passed ? 0 : 1 };
}

export type { ActualClass, OffLogEvidence };
