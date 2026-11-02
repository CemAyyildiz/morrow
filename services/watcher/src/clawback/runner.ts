import {
  MAX_INPUTS_PER_OP,
  MorrowContractError,
  completeAndBroadcast,
  type BitcoinBackend,
  type ContractClient,
  type ErrorCode,
  type Hex,
  type Outpoint,
  type SpendOp,
  type SpendSource,
  type U64,
  type Vault,
  type VaultKit,
} from "@morrow/core-ts";
import type { ChainClock } from "../clock.js";
import type { Logger } from "../log.js";
import { clawbackFeeRate, outputScriptLength, sweepVsize } from "./fees.js";
import {
  TERMINAL_JOB_STATUSES,
  type ClawbackJob,
  type ClawbackTrigger,
  type Conflict,
  type JobStatus,
  type JobStore,
  type Sweep,
  type SweepState,
} from "./jobs.js";

/** Assembles the Guardian witnesses on a signed clawback op, broadcasts it and returns the txid. */
export type BroadcastSigned = (op: SpendOp) => Promise<Hex>;

/** The broadcaster for real ops: `completeAndBroadcast` with the Guardian key (idempotent). */
export function guardianBroadcaster(
  reader: ContractClient,
  backend: BitcoinBackend,
  guardianSecretKey: Uint8Array,
): BroadcastSigned {
  return async (op) => {
    const kit = await reader.getVaultKit(op.vault_id);
    return completeAndBroadcast(
      op,
      op.source === "allowance" ? kit.allowance_script_hex : kit.vault_script_hex,
      { role: "guardian", secretKey: guardianSecretKey },
      backend,
    );
  };
}

/** Virtual size of a sweep, as the contract computes it when it checks the fee. */
export type SweepSizer = (sweep: {
  inputs: number;
  witnessScriptHex: Hex;
  recoveryAddress: string;
}) => number;

export const contractSweepVsize: SweepSizer = ({ inputs, witnessScriptHex, recoveryAddress }) =>
  sweepVsize(inputs, Math.floor(witnessScriptHex.length / 2), outputScriptLength(recoveryAddress));

export interface ClawbackRunnerOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** Client signed by the Guardian account (a function-call key) for begin_clawback and sign_input. */
  signer: ContractClient;
  guardianAccount: string;
  /** Compressed pubkey of the configured Guardian BTC key; must equal the Vault's guardian_key. */
  guardianKey?: Hex;
  backend: BitcoinBackend;
  broadcastSigned: BroadcastSigned;
  jobs: JobStore;
  clock: ChainClock;
  log: Logger;
  /** Rate when nothing competes for the coins (MORROW_CLAWBACK_FEE_RATE). */
  baseFeeRate?: number;
  intervalMs?: number;
  sweepVsize?: SweepSizer;
}

/** The job can never succeed: retrying would only repeat the same rejection. */
const PERMANENT: ReadonlySet<ErrorCode> = new Set([
  "ERR_VAULT_NOT_FOUND",
  "ERR_VAULT_NOT_ACTIVE",
  "ERR_UNAUTHORIZED",
]);
/** The contract refused this sweep at its fixed rate; other sweeps of the job still run. */
const SWEEP_REFUSED: ReadonlySet<ErrorCode> = new Set([
  "ERR_FEE_TOO_HIGH",
  "ERR_INSUFFICIENT_FUNDS",
  "ERR_BAD_ADDRESS",
]);
const FINAL_SWEEP_STATES: readonly SweepState[] = ["confirmed", "skipped", "covered", "lost"];
/** Bitcoin Core's answer when an input is already spent by a confirmed transaction. */
const INPUTS_SPENT = /missingorspent|missing.?inputs/i;

const key = (u: { txid: Hex; vout: number }) => `${u.txid}:${u.vout}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusOf(sweeps: Sweep[]): JobStatus {
  const open = sweeps.filter((s) => !FINAL_SWEEP_STATES.includes(s.state));
  if (open.length === 0) {
    if (sweeps.some((s) => s.state === "lost")) return "lost";
    if (sweeps.length > 0 && sweeps.every((s) => s.state === "skipped")) return "failed";
    return "done";
  }
  if (open.some((s) => s.state === "planned" || s.state === "begun")) return "running";
  if (open.some((s) => s.pinned)) return "pinned";
  // A signed op whose broadcasts were all refused is not out yet.
  return open.some((s) => s.txid === null) ? "running" : "broadcast";
}

/**
 * Auto-Clawback: runs each due job from its persisted step. Plan (UTXOs, conflicts and the one fee
 * rate per op), `begin_clawback` per op, `sign_input` for every unsigned input, Guardian witness
 * and broadcast, then rebroadcast the same transaction each tick until it confirms.
 */
export class ClawbackRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly baseFeeRate: number;
  private readonly intervalMs: number;
  private readonly sizer: SweepSizer;

  constructor(private readonly options: ClawbackRunnerOptions) {
    this.baseFeeRate = options.baseFeeRate ?? 2;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.sizer = options.sweepVsize ?? contractSweepVsize;
  }

  /** Queues a job due now (NEAR block time); a Vault with an unfinished job keeps that one. */
  async enqueue(vaultId: U64, trigger: ClawbackTrigger = "manual"): Promise<ClawbackJob> {
    const now = await this.options.clock.now();
    const job = await this.options.jobs.enqueue(vaultId, trigger, now.toString());
    this.options.log("info", "clawback queued", {
      vault_id: vaultId,
      job_id: job.job_id,
      trigger,
    });
    return job;
  }

  /** Advances every unfinished job that is due. */
  async tick(): Promise<void> {
    const now = await this.options.clock.now();
    for (const job of await this.options.jobs.jobs()) {
      if (TERMINAL_JOB_STATUSES.includes(job.status)) continue;
      if (job.status === "queued" && BigInt(job.due_at) > now) continue;
      await this.advance(job);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.options.log("error", "clawback tick failed; will retry", { error: message(error) });
      }
      if (this.running) this.timer = setTimeout(run, this.intervalMs);
    };
    void run();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private save(job: ClawbackJob): Promise<void> {
    return this.options.jobs.update(job);
  }

  private async advance(job: ClawbackJob): Promise<void> {
    const { log } = this.options;
    try {
      await this.run(job);
    } catch (error) {
      job.last_error = message(error);
      if (error instanceof MorrowContractError && PERMANENT.has(error.code)) {
        job.status = "failed";
        log("error", "clawback failed", {
          vault_id: job.vault_id,
          job_id: job.job_id,
          error: job.last_error,
        });
      } else {
        log("warn", "clawback step failed; will retry", {
          vault_id: job.vault_id,
          job_id: job.job_id,
          error: job.last_error,
        });
      }
      await this.save(job);
    }
  }

  private async run(job: ClawbackJob): Promise<void> {
    const { log } = this.options;
    if (job.status === "queued") {
      job.status = "running";
      await this.save(job);
    }
    if (!job.sweeps) {
      job.sweeps = await this.plan(job);
      await this.save(job);
    }
    for (const sweep of job.sweeps) {
      if (sweep.state === "planned") await this.begin(job, sweep);
      if (sweep.state === "begun") await this.sign(job, sweep);
      if (sweep.state === "signed" || sweep.state === "broadcast") {
        await this.broadcast(job, sweep);
      }
    }
    const status = statusOf(job.sweeps);
    const changed = status !== job.status;
    job.status = status;
    job.last_error = null;
    await this.save(job);
    if (!changed) return;
    const fields = { vault_id: job.vault_id, job_id: job.job_id, ops: job.sweeps.length };
    if (status === "done") log("info", "clawback confirmed", fields);
    if (status === "lost")
      log("error", "clawback lost: a conflicting transaction confirmed", fields);
    if (status === "failed") log("error", "clawback failed: the contract refused every op", fields);
  }

  /** Reads the coins and conflicts once and fixes each op's fee rate for good. */
  private async plan(job: ClawbackJob): Promise<Sweep[]> {
    const { reader, backend, jobs, guardianAccount, guardianKey, log } = this.options;
    const vault = await reader.getVault(job.vault_id);
    if (vault.state === "pending_keys") throw new MorrowContractError("ERR_VAULT_NOT_ACTIVE");
    const guardian = vault.policy.guardians.find((g) => g.guardian_account === guardianAccount);
    if (!guardian) {
      throw new MorrowContractError("ERR_UNAUTHORIZED", `${guardianAccount} is not a Guardian`);
    }
    if (guardianKey && guardian.guardian_key.toLowerCase() !== guardianKey.toLowerCase()) {
      throw new MorrowContractError(
        "ERR_UNAUTHORIZED",
        `MORROW_GUARDIAN_BTC_KEY does not match the guardian_key of ${guardianAccount} in this Vault`,
      );
    }
    const kit = await reader.getVaultKit(job.vault_id);
    const ops = await Promise.all(
      (await jobs.frozenOps(job.vault_id)).map((o) => reader.getOp(o.op_id)),
    );
    const reserved = new Set(
      ops.filter((o) => o.kind === "clawback").flatMap((o) => o.utxos.map(key)),
    );
    const live = ops.filter(
      (o) => o.kind !== "clawback" && (o.state === "frozen" || o.state === "signed"),
    );

    const sweeps: Sweep[] = [];
    for (const source of ["vault", "allowance"] as const) {
      // Esplora's UTXO list drops coins spent in the mempool, so coins of live ops that a mempool
      // transaction is spending (the race) are added back.
      const candidates: Outpoint[] = (await backend.getUtxos(kit.addresses[source])).map(
        ({ txid, vout, value_sats }) => ({ txid, vout, value_sats }),
      );
      for (const op of live.filter((o) => o.source === source)) {
        for (const utxo of op.utxos) {
          if (await backend.getSpender(utxo)) candidates.push({ ...utxo });
        }
      }
      const seen = new Set<string>();
      const coins = candidates
        .filter((u) => !reserved.has(key(u)) && !seen.has(key(u)) && seen.add(key(u)))
        .sort((a, b) => (BigInt(b.value_sats) > BigInt(a.value_sats) ? 1 : -1));
      for (let i = 0; i < coins.length; i += MAX_INPUTS_PER_OP) {
        const chunk = coins.slice(i, i + MAX_INPUTS_PER_OP);
        sweeps.push(await this.planSweep(job, vault, kit, source, chunk, live));
      }
    }
    if (sweeps.length === 0) {
      log("info", "clawback: nothing to sweep", { vault_id: job.vault_id, job_id: job.job_id });
    }
    return sweeps;
  }

  private async planSweep(
    job: ClawbackJob,
    vault: Vault,
    kit: VaultKit,
    source: SpendSource,
    utxos: Outpoint[],
    live: SpendOp[],
  ): Promise<Sweep> {
    const { backend, log } = this.options;
    const keys = new Set(utxos.map(key));
    const conflicts: Conflict[] = [];
    for (const utxo of utxos) {
      const spender = await backend.getSpender(utxo);
      if (spender && !conflicts.some((c) => c.txid === spender.txid)) {
        conflicts.push({
          txid: spender.txid,
          op_id: null,
          fee_rate_sat_vb: spender.fee_rate_sat_vb,
          descendant_fees_sats: spender.descendant_fees_sats,
        });
      }
    }
    for (const op of live) {
      if (op.utxos.some((u) => keys.has(key(u)))) {
        conflicts.push({
          txid: null,
          op_id: op.op_id,
          fee_rate_sat_vb: op.fee_rate_sat_vb,
          descendant_fees_sats: null,
        });
      }
    }
    const vsize = this.sizer({
      inputs: utxos.length,
      witnessScriptHex: source === "vault" ? kit.vault_script_hex : kit.allowance_script_hex,
      recoveryAddress: vault.policy.recovery_address,
    });
    const total = utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
    const decision = clawbackFeeRate({
      vsize,
      totalSats: total,
      feeCapSats: BigInt(vault.policy.fee_cap_sats),
      baseRate: this.baseFeeRate,
      conflicts,
    });
    const fields = {
      vault_id: job.vault_id,
      job_id: job.job_id,
      source,
      inputs: utxos.length,
      fee_rate_sat_vb: decision.fee_rate_sat_vb,
      fee_sats: decision.fee_sats,
      conflicts,
    };
    const tooSmall = decision.fee_rate_sat_vb < 1;
    if (tooSmall) {
      log("error", "clawback skipped: the fee cap does not allow 1 sat/vB", fields);
    } else if (conflicts.length > 0) {
      log("warn", "clawback races conflicting spends; using the cap rate", fields);
      if (decision.below_double) {
        log("warn", "clawback cap rate is below 2x a conflict's rate; broadcasting anyway", fields);
      }
      if (decision.pinned) {
        log(
          "error",
          "clawback pinned: a conflict's fees with descendants exceed our capped fee",
          fields,
        );
      }
    }
    return {
      source,
      utxos,
      fee_rate_sat_vb: decision.fee_rate_sat_vb,
      vsize,
      conflicts,
      pinned: decision.pinned,
      op_id: null,
      txid: null,
      state: tooSmall ? "skipped" : "planned",
      last_error: tooSmall ? "fee cap below 1 sat/vB" : null,
    };
  }

  /**
   * A clawback op holding exactly these coins (ours from before a crash) and not held by another
   * sweep of the job is adopted rather than begun twice. Coins that some other clawback op already
   * holds are dropped from the sweep: the contract would refuse them.
   */
  private async existingClawback(job: ClawbackJob, sweep: Sweep): Promise<SpendOp | null> {
    const { reader, jobs } = this.options;
    let keys = new Set(sweep.utxos.map(key));
    const held = new Set((job.sweeps ?? []).filter((s) => s !== sweep).map((s) => s.op_id));
    for (const indexed of await jobs.frozenOps(job.vault_id)) {
      if (indexed.kind !== "clawback") continue;
      const op = await reader.getOp(indexed.op_id);
      const overlap = new Set(op.utxos.map(key).filter((k) => keys.has(k)));
      if (overlap.size === 0) continue;
      const same = op.utxos.length === keys.size && overlap.size === keys.size;
      if (same && op.source === sweep.source && !held.has(op.op_id)) return op;
      sweep.utxos = sweep.utxos.filter((u) => !overlap.has(key(u)));
      keys = new Set(sweep.utxos.map(key));
    }
    return null;
  }

  private async begin(job: ClawbackJob, sweep: Sweep): Promise<void> {
    const { signer, log } = this.options;
    const existing = await this.existingClawback(job, sweep);
    if (existing) {
      sweep.op_id = existing.op_id;
      sweep.utxos = existing.utxos;
      sweep.fee_rate_sat_vb = existing.fee_rate_sat_vb;
      sweep.state = "begun";
      await this.save(job);
      log("info", "clawback op already exists; resuming it", {
        vault_id: job.vault_id,
        job_id: job.job_id,
        op_id: existing.op_id,
      });
      return;
    }
    if (sweep.utxos.length === 0) {
      // The coins are already on their way home: nothing failed.
      sweep.state = "covered";
      await this.save(job);
      log("info", "clawback op not needed: its coins are already clawed back", {
        vault_id: job.vault_id,
        job_id: job.job_id,
        source: sweep.source,
      });
      return;
    }
    let opId: U64;
    try {
      opId = await signer.beginClawback({
        vault_id: job.vault_id,
        utxos: sweep.utxos,
        fee_rate_sat_vb: sweep.fee_rate_sat_vb,
        source: sweep.source,
      });
    } catch (error) {
      if (error instanceof MorrowContractError && SWEEP_REFUSED.has(error.code)) {
        sweep.state = "skipped";
        sweep.last_error = error.message;
        await this.save(job);
        log("error", "clawback op refused by the contract", {
          vault_id: job.vault_id,
          job_id: job.job_id,
          source: sweep.source,
          error: error.message,
        });
        return;
      }
      throw error;
    }
    sweep.op_id = opId;
    sweep.state = "begun";
    await this.save(job);
    log("info", "clawback begun", {
      vault_id: job.vault_id,
      job_id: job.job_id,
      op_id: opId,
      source: sweep.source,
      fee_rate_sat_vb: sweep.fee_rate_sat_vb,
    });
  }

  /** Signatures live in the contract, so a resumed job signs only the inputs still null. */
  private async sign(job: ClawbackJob, sweep: Sweep): Promise<void> {
    const { reader, signer, log } = this.options;
    const opId = sweep.op_id as U64;
    const op = await reader.getOp(opId);
    for (let i = 0; i < op.signatures.length; i++) {
      if (op.signatures[i] === null) await signer.signInput(opId, i);
    }
    const signed = await reader.getOp(opId);
    if (signed.signatures.some((s) => s === null)) {
      throw new Error(`clawback op ${opId} still has unsigned inputs`);
    }
    sweep.state = "signed";
    await this.save(job);
    log("info", "clawback co-signed", {
      vault_id: job.vault_id,
      job_id: job.job_id,
      op_id: opId,
      inputs: signed.signatures.length,
    });
  }

  /** Broadcasts, then rebroadcasts the same transaction whenever the backend no longer knows it. */
  private async broadcast(job: ClawbackJob, sweep: Sweep): Promise<void> {
    const { reader, backend, broadcastSigned, log } = this.options;
    const opId = sweep.op_id as U64;
    const fields = { vault_id: job.vault_id, job_id: job.job_id, op_id: opId, txid: sweep.txid };
    if (sweep.txid) {
      const status = await backend.getTx(sweep.txid);
      if (status && status.confirmations > 0) {
        sweep.state = "confirmed";
        await this.save(job);
        log("info", "clawback transaction confirmed", fields);
        return;
      }
      if (status) return;
    }
    const op = await reader.getOp(opId);
    try {
      const txid = await broadcastSigned(op);
      const first = sweep.txid === null;
      sweep.txid = txid;
      sweep.state = "broadcast";
      sweep.last_error = null;
      await this.save(job);
      log("info", first ? "clawback broadcast" : "clawback rebroadcast", { ...fields, txid });
    } catch (error) {
      const reason = message(error);
      if (INPUTS_SPENT.test(reason)) {
        sweep.state = "lost";
        sweep.last_error = reason;
        await this.save(job);
        log("error", "clawback inputs were spent by a conflicting transaction", {
          ...fields,
          conflicts: sweep.conflicts,
          error: reason,
        });
        return;
      }
      const repeated = reason === sweep.last_error;
      sweep.last_error = reason;
      await this.save(job);
      log(
        repeated ? "debug" : sweep.pinned ? "error" : "warn",
        "clawback broadcast refused; will rebroadcast",
        { ...fields, cpfp_blocked: sweep.pinned, error: reason },
      );
    }
  }
}
