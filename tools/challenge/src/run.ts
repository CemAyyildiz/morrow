import type { AccountId, BitcoinBackend, MorrowEvent, SpendOp, U64, Vault } from "@morrow/core-ts";
import { Transaction } from "bitcoinjs-lib";
import { KeyPair } from "near-api-js";
import {
  MAX_LOOKUPS_PER_TICK,
  scanRejectedAttempts,
  type AttemptSources,
  type AttemptStore,
  type WithdrawalAttempt,
} from "./attempts.js";
import { DEFAULT_ROTATION_MARGIN_BLOCKS } from "./config.js";
import type { Logger } from "./log.js";
import {
  KEY_ALLOWANCE_LOW_YOCTO,
  OWNER_BALANCE_LOW_YOCTO,
  OWNER_BALANCE_TOP_UP_YOCTO,
  STORAGE_LOW_YOCTO,
  STORAGE_TOP_UP_YOCTO,
} from "./near.js";
import { RoundError, refreshDeadline, type RoundNear } from "./round.js";
import type { RoundRecord, RoundStore } from "./store.js";
import type { WatcherClient } from "./watcher-client.js";

/** A NEAR access key as seen on chain; `allowanceYocto` null means unlimited (or full access). */
export type KeyState = { exists: false } | { exists: true; allowanceYocto: bigint | null };

/** The NEAR side of the round loop, done by the operator. */
export interface RunNear extends RoundNear {
  /** View. */
  getVault(vaultId: U64): Promise<Vault>;
  /** `top_up_storage`, paid by the parent account. */
  topUpStorage(vaultId: U64, depositYocto: bigint): Promise<void>;
  /** View: the account's available (spendable) balance. */
  availableBalance(accountId: AccountId): Promise<bigint>;
  /** Transfers NEAR from the parent account. */
  transferFromParent(accountId: AccountId, yocto: bigint): Promise<void>;
  /** View of one key of `accountId` (`secretKey` is that account's full-access key). */
  accessKey(accountId: AccountId, secretKey: string, publicKey: string): Promise<KeyState>;
  /** Deletes a key, signed by the account's full-access key. */
  deleteKey(accountId: AccountId, secretKey: string, publicKey: string): Promise<void>;
  /** View: `events_since(cursor, limit)`, events with `seq > cursor`, ascending. */
  eventsSince(cursor: U64, limit: number): Promise<MorrowEvent[]>;
  /** View: `get_op`. */
  getOp(opId: U64): Promise<SpendOp>;
}

export const TICK_MS = 30_000;
export const OPEN_RETRY_MS = 10 * 60_000;
/** After this many failed openings in a row, `run` stops opening rounds until restarted. */
export const MAX_FAILED_OPENINGS = 5;
/** Top-ups (storage and Owner Account balance): one per target per 10 min, 10 per UTC day. */
export const TOP_UP_COOLDOWN_MS = 10 * 60_000;
export const MAX_TOP_UPS_PER_DAY = 10;
/** The event tail reads `events_since` pages of 100, at most 10 pages per tick. */
export const EVENT_PAGE_SIZE = 100;
export const MAX_EVENT_PAGES_PER_TICK = 10;
/** Clawback lookups (`get_op` or the Bitcoin backend) per tick. */
export const MAX_CLAWBACK_CHECKS_PER_TICK = 20;

/** The txid of a transaction; the witness does not change it, so an unsigned one has it too. */
export function txidOf(hex: string): string {
  return Transaction.fromHex(hex).getId();
}

export interface RoundRunnerOptions {
  store: RoundStore;
  attempts: AttemptStore;
  near: RunNear;
  backend: Pick<BitcoinBackend, "getTx" | "getTipHeight">;
  watcher: WatcherClient;
  sources: AttemptSources;
  /** Opens round N+1: 7.1a `openRound` with `next: true` (same safety checks). */
  openNext: () => Promise<RoundRecord>;
  /** Rotate this many blocks before the rotation deadline. Default 144. */
  rotationMarginBlocks?: number;
  /** The Escape Timelock of the rounds `openNext` opens, to check the margin against. */
  nextEscapeTimelockBlocks?: number;
  /** Default 30 s. */
  intervalMs?: number;
  /** A failed opening is retried at most this often. Default 10 min. */
  openRetryMs?: number;
  /** Milliseconds since the Unix epoch. */
  now?: () => number;
  log: Logger;
}

type EndReason = "no_round" | "clawed_back" | "rotation";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The challenge round loop. Each tick reconciles the current round with the chain, in order:
 * funding confirmation, end of round (next round, rotation, hard-deadline Clawback), sweeps,
 * storage top-up, Owner Account balance, the published key's allowance, the event tail, Clawback
 * txids, rejected attempts, and retiring old rounds' keys. Ticks never overlap; a failing step
 * is logged and retried on the next tick.
 */
export class RoundRunner {
  private running: Promise<void> | null = null;
  private failedOpenings = 0;
  private openingDisabled = false;
  /** Rounds (or "next") whose too-large rotation margin was already reported. */
  private readonly marginReported = new Set<string>();
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly options: RoundRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Runs one tick. Returns false, without doing anything, while another tick is running. */
  async tick(): Promise<boolean> {
    if (this.running) {
      this.log("debug", "tick skipped: the previous tick is still running");
      return false;
    }
    this.running = this.reconcile().finally(() => {
      this.running = null;
    });
    await this.running;
    return true;
  }

  /** Ticks now and then every `intervalMs` after the previous tick ends. */
  start(): { stop(): Promise<void> } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      await this.tick().catch((error: unknown) => {
        this.log("error", "tick failed; will retry", { error: message(error) });
      });
      if (!stopped) timer = setTimeout(() => void loop(), this.options.intervalMs ?? TICK_MS);
    };
    void loop();
    return {
      stop: async () => {
        stopped = true;
        clearTimeout(timer);
        await this.running;
      },
    };
  }

  private async reconcile(): Promise<void> {
    const { store, backend } = this.options;
    await this.step("funding", () => refreshDeadline(store, backend));
    await this.step("round", () => this.endOfRound());
    await this.step("sweep", () => this.sweep());
    await this.step("storage", () => this.storage());
    await this.step("balance", () => this.ownerBalance());
    await this.step("key", () => this.functionCallKey());
    await this.step("events", () => this.tailEvents());
    await this.step("clawbacks", () => this.clawbacks());
    await this.step("attempts", () => this.scan());
    await this.step("retire", () => this.retireRounds());
  }

  private async step(name: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.log("error", `${name} step failed; will retry next tick`, { error: message(error) });
    }
  }

  // End of round

  /**
   * False (reported once at error) when the margin would rotate a round with this Escape
   * Timelock as soon as its funding confirms: margin rotation is then off for it.
   */
  private marginUsable(key: string, escapeTimelockBlocks: number): boolean {
    const margin = this.options.rotationMarginBlocks ?? DEFAULT_ROTATION_MARGIN_BLOCKS;
    const window = Math.floor((escapeTimelockBlocks * 4) / 5);
    if (margin < window) return true;
    if (!this.marginReported.has(key)) {
      this.marginReported.add(key);
      this.log(
        "error",
        "MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS is not below 80% of the Escape Timelock; " +
          "not rotating on margin (the hard-deadline Clawback still applies)",
        { round: key, margin_blocks: margin, rotation_window_blocks: window },
      );
    }
    return false;
  }

  private async endReason(current: RoundRecord | null): Promise<EndReason | null> {
    if (!current) return "no_round";
    if (current.vault_id === null) return null;
    const vault = await this.options.near.getVault(current.vault_id);
    if (vault.state === "clawed_back") return "clawed_back";
    const deadline = current.rotation_deadline_height;
    if (deadline === null) return null;
    const margin = this.options.rotationMarginBlocks ?? DEFAULT_ROTATION_MARGIN_BLOCKS;
    const tip = await this.options.backend.getTipHeight();
    if (tip >= deadline) {
      // Its keys are public and the Escape Path is near: send the coins home even without a
      // successor round.
      await this.hardDeadlineClawback(current, current.vault_id, tip);
      return "rotation";
    }
    const usable = this.marginUsable(String(current.round), current.escape_timelock_blocks);
    return usable && tip >= deadline - margin ? "rotation" : null;
  }

  private async hardDeadlineClawback(round: RoundRecord, vaultId: U64, tip: number) {
    const fields = {
      round: round.round,
      vault_id: vaultId,
      tip,
      deadline: round.rotation_deadline_height,
    };
    try {
      const job = await this.options.watcher.requestClawback(vaultId);
      this.log("warn", "round past its rotation deadline; asked the watcher to claw it back", {
        ...fields,
        job_id: job.job_id,
        job_status: job.status,
      });
    } catch (error) {
      this.log("error", "round past its rotation deadline and not clawed back; will retry", {
        ...fields,
        error: message(error),
      });
    }
  }

  private async endOfRound(): Promise<void> {
    const { store } = this.options;
    const current = await store.current();
    const reason = await this.endReason(current);
    if (!reason) return;
    if (this.openingDisabled) {
      this.log("error", "round opening disabled until restart", {
        reason,
        round: current?.round,
        failed_openings: this.failedOpenings,
      });
      return;
    }

    // Any unfinished opening (failed, or interrupted by a crash) counts as a failed attempt.
    const latest = await store.latest();
    if (latest && latest.status === "opening") {
      await this.sweepIfFunded(latest);
      const retryMs = this.options.openRetryMs ?? OPEN_RETRY_MS;
      const elapsed = this.now() - Date.parse(latest.updated_at);
      if (elapsed < retryMs) {
        this.log("info", "next round due; waiting to retry the failed opening", {
          reason,
          round: current?.round,
          retry_in_s: Math.ceil((retryMs - elapsed) / 1000),
        });
        return;
      }
    }

    // Recorded first, so a crash after the opening still sweeps the old Vault. The sweep only
    // runs once the old round is no longer open.
    if (reason === "rotation" && current?.vault_id) {
      await store.addPendingSweep(current.round, current.vault_id);
    }
    if (this.options.nextEscapeTimelockBlocks !== undefined) {
      this.marginUsable("next", this.options.nextEscapeTimelockBlocks);
    }
    this.log("info", "opening the next round", { reason, round: current?.round });
    try {
      const opened = await this.options.openNext();
      this.failedOpenings = 0;
      this.log("info", "round opened", {
        round: opened.round,
        vault_id: opened.vault_id,
        owner_account: opened.owner_account,
        funding_txid: opened.funding_txid,
      });
    } catch (error) {
      const short = error instanceof RoundError && error.code === "RECOVERY_BALANCE_SHORT";
      this.log(
        "error",
        short ? "Recovery balance too low to open the next round" : "opening the next round failed",
        { reason, round: current?.round, error: message(error) },
      );
      const after = await store.latest();
      if (after && after.status === "opening" && after.round !== latest?.round) {
        await this.sweepIfFunded(after);
        this.failedOpenings++;
        if (this.failedOpenings >= MAX_FAILED_OPENINGS) {
          this.openingDisabled = true;
          this.log("error", "round opening disabled until restart", {
            failed_openings: this.failedOpenings,
          });
        }
      }
    }
  }

  /**
   * A failed opening whose funding reached the network holds Recovery coins: claw them back.
   * A funding transaction the backend has never seen was lost, so its Vault is empty.
   */
  private async sweepIfFunded(round: RoundRecord): Promise<void> {
    if (round.status === "open" || !round.vault_id || !round.funding_txid) return;
    if ((await this.options.backend.getTx(round.funding_txid)) === null) {
      this.log("warn", "failed opening's funding never reached the network; nothing to sweep", {
        round: round.round,
        funding_txid: round.funding_txid,
      });
      return;
    }
    await this.options.store.addPendingSweep(round.round, round.vault_id);
  }

  private async sweep(): Promise<void> {
    const { store, near, watcher } = this.options;
    const sweeps = await store.pendingSweeps();
    if (sweeps.length === 0) return;
    const rounds = await store.rounds();
    for (const sweep of sweeps) {
      const round = rounds.find((r) => r.round === sweep.round);
      // Still served (the next round has not opened yet): nothing to sweep.
      if (round && round.status === "open") continue;
      try {
        const vault = await near.getVault(sweep.vault_id);
        if (vault.state === "clawed_back") {
          await store.removePendingSweep(sweep.vault_id);
          this.log("info", "old Vault clawed back", sweepFields(sweep));
          continue;
        }
        const job = await watcher.requestClawback(sweep.vault_id);
        this.log("info", "asked the watcher to claw back an old Vault", {
          ...sweepFields(sweep),
          job_id: job.job_id,
          job_status: job.status,
        });
      } catch (error) {
        this.log("error", "old Vault not swept yet; will retry next tick", {
          ...sweepFields(sweep),
          error: message(error),
        });
      }
    }
  }

  // Top-ups

  /** One top-up per target per 10 min and at most 10 per UTC day, shared by every target. */
  private async topUpAllowed(target: string, fields: Record<string, unknown>): Promise<boolean> {
    const now = this.now();
    const topUps = await this.options.store.topUps();
    const last = topUps.filter((t) => t.target === target).at(-1);
    if (last && now - last.at < TOP_UP_COOLDOWN_MS) {
      this.log("info", "top-up due; waiting for its cooldown", {
        ...fields,
        retry_in_s: Math.ceil((TOP_UP_COOLDOWN_MS - (now - last.at)) / 1000),
      });
      return false;
    }
    const today = topUps.filter((t) => utcDay(t.at) === utcDay(now)).length;
    if (today >= MAX_TOP_UPS_PER_DAY) {
      this.log("error", "daily top-up cap reached; skipping", {
        ...fields,
        top_ups_today: today,
      });
      return false;
    }
    return true;
  }

  /** The current round, unless its Vault is clawed back. */
  private async liveRound(): Promise<RoundRecord | null> {
    const round = await this.options.store.current();
    if (!round?.vault_id) return null;
    const vault = await this.options.near.getVault(round.vault_id);
    return vault.state === "clawed_back" ? null : round;
  }

  private async storage(): Promise<void> {
    const { store, near } = this.options;
    const round = await store.current();
    if (!round?.vault_id) return;
    const vault = await near.getVault(round.vault_id);
    if (vault.state === "clawed_back") return;
    const balance = BigInt(vault.storage_balance);
    if (balance >= STORAGE_LOW_YOCTO) return;
    const fields = {
      round: round.round,
      vault_id: round.vault_id,
      storage_balance_yocto: balance.toString(),
    };
    const target = `storage:${round.vault_id}`;
    if (!(await this.topUpAllowed(target, fields))) return;
    await near.topUpStorage(round.vault_id, STORAGE_TOP_UP_YOCTO);
    await store.addTopUp(target, this.now());
    this.log("info", "storage topped up", {
      ...fields,
      top_up_yocto: STORAGE_TOP_UP_YOCTO.toString(),
    });
  }

  /** Spam burns the Owner Account's own balance as gas; keep it above 0.5 NEAR. */
  private async ownerBalance(): Promise<void> {
    const round = await this.liveRound();
    if (!round) return;
    const { store, near } = this.options;
    const balance = await near.availableBalance(round.owner_account);
    if (balance >= OWNER_BALANCE_LOW_YOCTO) return;
    const fields = {
      round: round.round,
      owner_account: round.owner_account,
      balance_yocto: balance.toString(),
    };
    const target = `balance:${round.owner_account}`;
    if (!(await this.topUpAllowed(target, fields))) return;
    await near.transferFromParent(round.owner_account, OWNER_BALANCE_TOP_UP_YOCTO);
    await store.addTopUp(target, this.now());
    this.log("info", "Owner Account balance topped up", {
      ...fields,
      top_up_yocto: OWNER_BALANCE_TOP_UP_YOCTO.toString(),
    });
  }

  // Published function-call key

  private async functionCallKey(): Promise<void> {
    const { store, near } = this.options;
    let round = await this.liveRound();
    if (!round || !round.function_call_key_added) return;
    const owner = round.owner_account;
    const secret = round.owner_account_full_access_key;
    const oldPublic = round.near_function_call_public_key;

    if (!round.next_function_call_key) {
      const state = await near.accessKey(owner, secret, oldPublic);
      const spent =
        state.exists &&
        state.allowanceYocto !== null &&
        state.allowanceYocto < KEY_ALLOWANCE_LOW_YOCTO;
      if (state.exists && !spent) {
        await this.deleteRetired(round);
        return;
      }
      // The new key is persisted (not served) before it exists on chain, so it is never lost.
      const fresh = KeyPair.fromRandom("ed25519");
      round = await store.patchOpen(round.round, {
        next_function_call_key: fresh.toString(),
        next_function_call_public_key: fresh.getPublicKey().toString(),
      });
      if (!round) return;
    }

    const nextKey = round.next_function_call_key as string;
    const nextPublic = round.next_function_call_public_key as string;
    // Resumed after a crash or a failed add: add only if it is not on chain yet.
    if (!(await near.accessKey(owner, secret, nextPublic)).exists) {
      await near.addFunctionCallKey(owner, secret, nextPublic);
    }
    const old = await near.accessKey(owner, secret, oldPublic);
    const swapped = await store.patchOpen(round.round, {
      near_function_call_key: nextKey,
      near_function_call_public_key: nextPublic,
      next_function_call_key: null,
      next_function_call_public_key: null,
      retired_function_call_public_keys: [
        ...(round.retired_function_call_public_keys ?? []),
        ...(old.exists ? [oldPublic] : []),
      ],
    });
    if (!swapped) return;
    await this.options.attempts.add({
      type: "key_rotated",
      round: swapped.round,
      time: new Date(this.now()).toISOString(),
      reason: old.exists ? "allowance_low" : "key_missing",
      old_public_key: oldPublic,
      new_public_key: nextPublic,
    });
    this.log("info", "published function-call key rotated", {
      round: swapped.round,
      reason: old.exists ? "allowance_low" : "key_missing",
      old_public_key: oldPublic,
      new_public_key: nextPublic,
    });
    await this.deleteRetired(swapped);
  }

  /** Deletes replaced keys; one that fails stays listed and is retried next tick. */
  private async deleteRetired(round: RoundRecord): Promise<void> {
    const retired = round.retired_function_call_public_keys ?? [];
    if (retired.length === 0) return;
    const remaining = await this.deleteKeys(round, retired);
    if (remaining.length !== retired.length) {
      await this.options.store.patchOpen(round.round, {
        retired_function_call_public_keys: remaining,
      });
    }
  }

  /** Deletes the Owner Account's keys that still exist; returns those that failed. */
  private async deleteKeys(round: RoundRecord, publicKeys: string[]): Promise<string[]> {
    const { near } = this.options;
    const owner = round.owner_account;
    const secret = round.owner_account_full_access_key;
    const remaining: string[] = [];
    for (const publicKey of publicKeys) {
      try {
        if ((await near.accessKey(owner, secret, publicKey)).exists) {
          await near.deleteKey(owner, secret, publicKey);
        }
      } catch (error) {
        remaining.push(publicKey);
        this.log("warn", "old function-call key not deleted yet; will retry", {
          round: round.round,
          old_public_key: publicKey,
          error: message(error),
        });
      }
    }
    return remaining;
  }

  // Retired rounds

  /** Was served: its funding confirmed while it was open, and its key was published. */
  private static served(round: RoundRecord): boolean {
    return round.funding_height !== null && round.function_call_key_added;
  }

  /**
   * A closed, served round whose Vault is clawed back and whose sweep is done gets its published
   * function-call keys deleted (signed with the operator-held full-access key of its Owner
   * Account); it is no longer scanned.
   */
  private async retireRounds(): Promise<void> {
    const { store, near } = this.options;
    const sweeping = new Set((await store.pendingSweeps()).map((s) => s.round));
    for (const round of await store.rounds()) {
      if (round.status !== "closed" || !RoundRunner.served(round) || round.published_key_deleted) {
        continue;
      }
      if (!round.vault_id || sweeping.has(round.round)) continue;
      if ((await near.getVault(round.vault_id)).state !== "clawed_back") continue;
      const keys = [
        round.near_function_call_public_key,
        ...(round.next_function_call_public_key ? [round.next_function_call_public_key] : []),
        ...(round.retired_function_call_public_keys ?? []),
      ];
      const remaining = await this.deleteKeys(round, keys);
      if (remaining.length > 0) continue;
      await store.patch(round.round, { published_key_deleted: true }, ["closed"]);
      this.log("info", "retired round's published key deleted", { round: round.round });
    }
  }

  // Attempt Log from events

  /**
   * Tails `events_since` from the persisted cursor, at most `MAX_EVENT_PAGES_PER_TICK` pages,
   * keeping only events of served rounds' Vaults (any status).
   */
  private async tailEvents(): Promise<void> {
    const { store, attempts, near } = this.options;
    const rounds = new Map<string, number>();
    for (const round of await store.rounds()) {
      if (RoundRunner.served(round) && round.vault_id !== null)
        rounds.set(round.vault_id, round.round);
    }
    const roundOf = (vaultId: U64) => rounds.get(vaultId) ?? null;
    let cursor = await attempts.cursor();
    for (let page = 0; page < MAX_EVENT_PAGES_PER_TICK; page++) {
      const events = await near.eventsSince(cursor, EVENT_PAGE_SIZE);
      if (events.length === 0) return;
      const applied = await attempts.applyEvents(events, roundOf);
      cursor = applied.cursor;
      for (const entry of applied.opened) {
        this.log("info", "attempt", {
          round: entry.round,
          n: entry.n,
          type: entry.type,
          seq: entry.seq,
          vault_id: entry.vault_id,
        });
      }
      for (const entry of applied.settled) {
        this.log("info", "attempt settled", {
          round: entry.round,
          n: entry.n,
          type: entry.type,
          outcome: entry.outcome,
        });
      }
      if (events.length < EVENT_PAGE_SIZE) return;
    }
  }

  /**
   * For clawed-back withdrawals: reads the Clawback op's transaction for its txid, then asks
   * the Bitcoin backend until it returns the transaction (broadcast). At most
   * `MAX_CLAWBACK_CHECKS_PER_TICK` lookups; a failing one is retried next tick.
   */
  private async clawbacks(): Promise<void> {
    const { attempts, near, backend } = this.options;
    const due = (await attempts.entries()).filter(
      (e): e is WithdrawalAttempt =>
        e.type === "withdrawal" &&
        e.outcome === "clawed_back" &&
        e.clawback_op_id !== null &&
        !e.clawback_broadcast,
    );
    let budget = MAX_CLAWBACK_CHECKS_PER_TICK;
    for (const entry of due) {
      if (budget <= 0) return;
      let txid = entry.clawback_txid;
      try {
        if (txid === null) {
          budget--;
          const op = await near.getOp(entry.clawback_op_id as U64);
          if (op.unsigned_tx_hex === null) continue;
          txid = txidOf(op.unsigned_tx_hex);
          await attempts.patchClawback(entry.seq, {
            clawback_txid: txid,
            clawback_broadcast: false,
          });
          if (budget <= 0) return;
        }
        budget--;
        if ((await backend.getTx(txid)) === null) continue;
        await attempts.patchClawback(entry.seq, { clawback_txid: txid, clawback_broadcast: true });
        this.log("info", "clawback broadcast", { round: entry.round, n: entry.n, txid });
      } catch (error) {
        this.log("warn", "clawback not readable yet; will retry", {
          round: entry.round,
          n: entry.n,
          clawback_op_id: entry.clawback_op_id,
          error: message(error),
        });
      }
    }
  }

  // Rejected attempts

  /**
   * Scans the current round, the latest served round before it (its last calls may land after
   * it is replaced) and every served round still waiting for its sweep: their keys are public.
   * At most `MAX_LOOKUPS_PER_TICK` RPC lookups are spent per tick.
   */
  private async scan(): Promise<void> {
    const { store, attempts, sources } = this.options;
    const current = await store.current();
    if (!current) return;
    const rounds = await store.rounds();
    const live = (r: RoundRecord) => RoundRunner.served(r) && !r.published_key_deleted;
    const wanted = new Set<number>([current.round]);
    const predecessor = rounds.findLast(
      (r) => r.round < current.round && r.status === "closed" && live(r),
    );
    if (predecessor) wanted.add(predecessor.round);
    for (const sweep of await store.pendingSweeps()) {
      const round = rounds.find((r) => r.round === sweep.round);
      if (round && live(round)) wanted.add(sweep.round);
    }

    let budget = MAX_LOOKUPS_PER_TICK;
    for (const round of rounds.filter((r) => wanted.has(r.round))) {
      try {
        const result = await scanRejectedAttempts(round, sources, attempts, this.log, budget);
        budget -= result.lookups;
        if (result.listError) {
          // Indexer or transport failure: expected now and then.
          this.log("warn", "attempt scan: indexer unavailable; listing skipped this tick", {
            round: round.round,
            error: result.listError.message,
          });
        }
      } catch (error) {
        // Store write, parse error or bug.
        this.log("error", "attempt scan failed; will retry next tick", {
          round: round.round,
          error: message(error),
        });
      }
    }
  }
}

const sweepFields = (sweep: { round: number; vault_id: U64 }) => ({
  round: sweep.round,
  vault_id: sweep.vault_id,
});
