import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BitcoinBackendError,
  MIN_VAULT_STORAGE_YOCTO,
  MockContractClient,
  MorrowContractError,
  WITNESS_TEMPLATES,
  presetPolicy,
  type BitcoinBackend,
  type ContractClient,
  type Spender,
  type SpendOp,
  type TxStatus,
  type Utxo,
  type VaultKit,
} from "@morrow/core-ts";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createApiServer } from "../heartbeat.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { InMemoryStore } from "../store.js";
import {
  clawbackFeeCap,
  clawbackFeeRate,
  outputScriptLength,
  sweepVsize,
  clawbackWitnessSize,
} from "./fees.js";
import { ClawbackIndexHandler } from "./index-handler.js";
import { FileJobStore, InMemoryJobStore, type JobStore } from "./jobs.js";
import {
  ClawbackRunner,
  contractSweepVsize,
  guardianBroadcaster,
  type BroadcastSigned,
  type SweepSizer,
} from "./runner.js";

const OWNER = "owner.test.near";
const GUARDIAN = "auto.guardian.test.near";
const ENVELOPE = "ab".repeat(80);
const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;

/** The mock estimates fees with its own size formula; the runner must use the same one here. */
const mockVsize: SweepSizer = ({ inputs }) => 11 + 140 * inputs + 43;
const ONE_INPUT_VSIZE = 194;

const txid = (n: number) => n.toString(16).padStart(64, "0");

class FakeBackend implements BitcoinBackend {
  readonly utxos = new Map<string, Utxo[]>();
  readonly spenders = new Map<string, Spender>();
  readonly txs = new Map<string, TxStatus>();
  private funded = 1000;

  fund(address: string, ...values: number[]): Utxo[] {
    const added = values.map((value, i) => ({
      txid: txid(++this.funded),
      vout: i,
      value_sats: String(value),
      height: 100,
    }));
    this.utxos.set(address, [...(this.utxos.get(address) ?? []), ...added]);
    return added;
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    return this.utxos.get(address) ?? [];
  }
  async getTipHeight(): Promise<number> {
    return 100;
  }
  async getTx(id: string): Promise<TxStatus | null> {
    return this.txs.get(id) ?? null;
  }
  async broadcast(raw: string): Promise<string> {
    throw new Error(`unexpected ${raw.length / 2}-byte broadcast: the runner uses broadcastSigned`);
  }
  async getSpender(outpoint: { txid: string; vout: number }): Promise<Spender | null> {
    return this.spenders.get(`${outpoint.txid}:${outpoint.vout}`) ?? null;
  }
}

/** Fake Guardian broadcaster: records each attempt; the txid is derived from the op id. */
function fakeBroadcaster(backend: FakeBackend) {
  const attempts: string[] = [];
  let failure: string | null = null;
  const broadcast: BroadcastSigned = async (op: SpendOp) => {
    attempts.push(op.op_id);
    expect(op.state).toBe("signed");
    if (failure) throw new BitcoinBackendError(failure);
    const id = `c1${op.op_id.padStart(62, "0")}`;
    backend.txs.set(id, { txid: id, confirmations: 0, block_height: null });
    return id;
  };
  return {
    attempts,
    broadcast,
    failWith: (reason: string | null) => {
      failure = reason;
    },
  };
}

/** The mock with some methods replaced; everything else is the mock itself. */
function withOverrides(
  mock: MockContractClient,
  overrides: Partial<ContractClient>,
): ContractClient {
  return new Proxy(mock, {
    get: (target, prop, receiver) => {
      if (prop in overrides) return overrides[prop as keyof ContractClient];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function setup(options: { guardian?: string } = {}) {
  const mock = new MockContractClient().asCaller(OWNER);
  const vaultId = await mock.createVault({
    owner_key: `02${"11".repeat(32)}`,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    policy: presetPolicy("standard", {
      plannedDepositSats: 10_000_000n,
      guardians: [
        {
          guardian_key: `03${"22".repeat(32)}`,
          guardian_account: options.guardian ?? GUARDIAN,
          kind: "auto_clawback",
        },
      ],
      recoveryAddress: RECOVERY,
      network: "signet",
      watcherX25519Pk: "44".repeat(32),
    }),
  });
  const vault = await mock.getVault(vaultId);
  const addresses = vault.addresses!;
  const backend = new FakeBackend();
  const jobs = new InMemoryJobStore();
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const broadcaster = fakeBroadcaster(backend);
  const watcherStore = new InMemoryStore();
  const index = new EventLoop({
    client: mock,
    store: watcherStore,
    handlers: [new ClawbackIndexHandler(jobs)],
    clock: { now: async () => mock.now() },
    log: () => undefined,
  });
  const runner = (
    overrides: {
      signer?: ContractClient;
      jobs?: JobStore;
      broadcast?: BroadcastSigned;
      guardianKey?: string;
    } = {},
  ) =>
    new ClawbackRunner({
      reader: mock,
      signer: overrides.signer ?? mock,
      guardianAccount: GUARDIAN,
      ...(overrides.guardianKey ? { guardianKey: overrides.guardianKey } : {}),
      backend,
      broadcastSigned: overrides.broadcast ?? broadcaster.broadcast,
      jobs: overrides.jobs ?? jobs,
      clock: { now: async () => mock.now() },
      log: (level, msg, fields = {}) => logs.push({ level, msg, fields }),
      sweepVsize: mockVsize,
    });
  const clawbackOps = () =>
    mock
      .eventsSince("0", 100)
      .then(
        (events) =>
          events.filter((e) => e.kind === "op_frozen" && e.data.kind === "clawback").length,
      );
  return {
    mock,
    vaultId,
    addresses,
    backend,
    jobs,
    logs,
    broadcaster,
    runner,
    index,
    clawbackOps,
  };
}

describe("clawback fees", () => {
  it("matches the contract's sweep vsize (tx.rs pinned vector: 2 inputs, P2WPKH, 3 sat/vB = 885)", () => {
    expect(clawbackWitnessSize(188)).toBe(342);
    expect(sweepVsize(2, 188, 22)).toBe(295);
    expect(sweepVsize(2, 188, 22) * 3).toBe(885);
  });

  it("reads the output script length from a segwit address", () => {
    expect(outputScriptLength("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe(22);
    expect(
      outputScriptLength("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"),
    ).toBe(34);
    expect(outputScriptLength("not an address")).toBe(34);
  });

  it("sizes sweeps from the kit script and the Recovery Address like the contract", () => {
    const sweep = { inputs: 2, witnessScriptHex: "ab".repeat(188) };
    expect(
      contractSweepVsize({
        ...sweep,
        recoveryAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
      }),
    ).toBe(295);
    // 34-byte output script (P2WSH / P2TR): 12 more non-witness bytes.
    expect(
      contractSweepVsize({
        ...sweep,
        recoveryAddress: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
      }),
    ).toBe(307);
  });

  it("caps at min(2 x Fee Cap, 10%), like clawback_fee_cap", () => {
    expect(clawbackFeeCap(100_000n, 210_000n)).toBe(21_000n);
    expect(clawbackFeeCap(100_000n, 10_000_000n)).toBe(200_000n);
  });

  it("uses the base rate without conflicts and the cap rate with any", () => {
    const base = { vsize: 200, totalSats: 1_000_000n, feeCapSats: 100_000n, baseRate: 2 };
    expect(clawbackFeeRate({ ...base, conflicts: [] })).toMatchObject({
      fee_rate_sat_vb: 2,
      cap_rate_sat_vb: 500,
      fee_sats: "400",
      pinned: false,
    });
    const race = clawbackFeeRate({ ...base, conflicts: [{ fee_rate_sat_vb: 3 }] });
    expect(race).toMatchObject({ fee_rate_sat_vb: 500, below_double: false, pinned: false });
    expect(clawbackFeeRate({ ...base, conflicts: [{ fee_rate_sat_vb: 300 }] }).below_double).toBe(
      true,
    );
    expect(
      clawbackFeeRate({
        ...base,
        conflicts: [{ fee_rate_sat_vb: 3, descendant_fees_sats: "100001" }],
      }).pinned,
    ).toBe(true);
    // Two mempool conflicts that only pin together, counting 1 sat/vB of incremental relay fee:
    // 50,000 + 49,800 + 200 x 1 >= 100,000.
    const one = { fee_rate_sat_vb: 3, descendant_fees_sats: "50000" };
    const two = { fee_rate_sat_vb: 3, descendant_fees_sats: "49800" };
    expect(clawbackFeeRate({ ...base, conflicts: [one] }).pinned).toBe(false);
    expect(clawbackFeeRate({ ...base, conflicts: [two] }).pinned).toBe(false);
    expect(clawbackFeeRate({ ...base, conflicts: [one, two] }).pinned).toBe(true);
    expect(
      clawbackFeeRate({
        ...base,
        conflicts: [one, { ...two, descendant_fees_sats: "49799" }],
      }).pinned,
    ).toBe(false);
    // A Vault so small the cap allows less than the base rate.
    expect(clawbackFeeRate({ ...base, totalSats: 3_000n, conflicts: [] }).fee_rate_sat_vb).toBe(1);
  });
});

describe("ClawbackRunner", () => {
  it("happy path: begins, signs every input and broadcasts with no human step, then confirms", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 600_000, 400_000);
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    const job = await runner.enqueue(t.vaultId);
    expect(job.status).toBe("queued");

    await runner.tick();
    const [broadcast] = await t.jobs.jobs();
    expect(broadcast?.status).toBe("broadcast");
    const sweep = broadcast!.sweeps![0]!;
    expect(sweep).toMatchObject({ source: "vault", fee_rate_sat_vb: 2, state: "broadcast" });
    const op = await t.mock.getOp(sweep.op_id!);
    expect(op).toMatchObject({ kind: "clawback", state: "signed", destination: RECOVERY });
    expect((await t.mock.getVault(t.vaultId)).state).toBe("clawed_back");
    expect(t.broadcaster.attempts).toEqual([op.op_id]);

    await runner.tick(); // still in the mempool: nothing to do
    expect(t.broadcaster.attempts).toHaveLength(1);
    t.backend.txs.set(sweep.txid!, { txid: sweep.txid!, confirmations: 1, block_height: 101 });
    await runner.tick();
    expect((await t.jobs.jobs())[0]).toMatchObject({ status: "done", last_error: null });
    expect(await t.clawbackOps()).toBe(1);
  });

  it("retries a failed step on the next tick from the persisted step", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 500_000);
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    t.broadcaster.failWith("connection reset");
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.sweeps?.[0]).toMatchObject({
      state: "signed",
      txid: null,
      last_error: "connection reset",
    });
    expect((await t.jobs.jobs())[0]?.status).toBe("running"); // not out yet
    t.broadcaster.failWith(null);
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.sweeps?.[0]?.state).toBe("broadcast");
    expect(await t.clawbackOps()).toBe(1);
  });

  it("mempool race: outbids a 3 sat/vB thief at the cap rate (>= 2x)", async () => {
    const t = await setup();
    const [coin] = t.backend.fund(t.addresses.vault, 1_000_000);
    t.backend.spenders.set(`${coin!.txid}:${coin!.vout}`, {
      txid: "ee".repeat(32),
      fee_rate_sat_vb: 3,
      fee_sats: "507",
      descendant_fees_sats: "507",
    });
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const [job] = await t.jobs.jobs();
    const capRate = Math.floor(100_000 / ONE_INPUT_VSIZE); // min(2 x 100k, 10% of 1M) / vsize
    expect(job?.status).toBe("broadcast");
    expect(job?.sweeps?.[0]).toMatchObject({ fee_rate_sat_vb: capRate, pinned: false });
    expect(capRate).toBeGreaterThanOrEqual(6);
    expect((await t.mock.getOp(job!.sweeps![0]!.op_id!)).fee_rate_sat_vb).toBe(capRate);
    expect(t.logs.some((l) => l.level === "warn" && /cap rate/.test(l.msg))).toBe(true);
  });

  it("cap below 2x: uses the cap rate, warns and still broadcasts", async () => {
    const t = await setup();
    const [coin] = t.backend.fund(t.addresses.vault, 1_000_000);
    t.backend.spenders.set(`${coin!.txid}:${coin!.vout}`, {
      txid: "ee".repeat(32),
      fee_rate_sat_vb: 400,
      fee_sats: "60000",
      descendant_fees_sats: "60000",
    });
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const [job] = await t.jobs.jobs();
    expect(job?.sweeps?.[0]?.fee_rate_sat_vb).toBe(Math.floor(100_000 / ONE_INPUT_VSIZE));
    expect(job?.status).toBe("broadcast");
    expect(t.logs.some((l) => l.level === "warn" && /below 2x/.test(l.msg))).toBe(true);
  });

  it("CPFP pin: still begins, signs and broadcasts, ends pinned, logs an error, keeps rebroadcasting", async () => {
    const t = await setup();
    const [coin] = t.backend.fund(t.addresses.vault, 1_000_000);
    t.backend.spenders.set(`${coin!.txid}:${coin!.vout}`, {
      txid: "ee".repeat(32),
      fee_rate_sat_vb: 3,
      fee_sats: "507",
      descendant_fees_sats: "300507",
    });
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    t.broadcaster.failWith("insufficient fee, rejecting replacement");
    await runner.tick();
    await runner.tick();
    const [job] = await t.jobs.jobs();
    expect(job?.status).toBe("pinned");
    expect(job?.sweeps?.[0]?.pinned).toBe(true);
    expect((await t.mock.getVault(t.vaultId)).state).toBe("clawed_back");
    expect(t.broadcaster.attempts).toHaveLength(2);
    expect(t.logs.some((l) => l.level === "error" && /pinned/.test(l.msg))).toBe(true);

    // The conflict leaves the mempool: the same Clawback goes through.
    t.broadcaster.failWith(null);
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("pinned");
    const id = (await t.jobs.jobs())[0]!.sweeps![0]!.txid!;
    t.backend.txs.set(id, { txid: id, confirmations: 1, block_height: 101 });
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("done");
  });

  it("crash mid-signing: resumes sign_input for the null signatures only", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 300_000, 300_000, 300_000);
    t.mock.asCaller(GUARDIAN);
    const calls: number[] = [];
    let crashed = false;
    const signer = withOverrides(t.mock, {
      signInput: async (opId: string, index: number) => {
        calls.push(index);
        if (index === 1 && !crashed) {
          crashed = true;
          throw new Error("process killed");
        }
        return t.mock.signInput(opId, index);
      },
    });
    const runner = t.runner({ signer });
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const [job] = await t.jobs.jobs();
    expect(job).toMatchObject({ status: "running", last_error: "process killed" });
    expect((await t.mock.getOp(job!.sweeps![0]!.op_id!)).signatures.map(Boolean)).toEqual([
      true,
      false,
      false,
    ]);
    await runner.tick();
    expect(calls).toEqual([0, 1, 1, 2]);
    expect((await t.jobs.jobs())[0]?.status).toBe("broadcast");
  });

  it("restart after begin_clawback but before the op id was saved: adopts the op, never builds a second", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-clawback-"));
    try {
      const t = await setup();
      t.backend.fund(t.addresses.vault, 500_000);
      t.mock.asCaller(GUARDIAN);
      const path = join(dir, "clawbacks.json");
      const crashing = withOverrides(t.mock, {
        beginClawback: async (args) => {
          await t.mock.beginClawback(args);
          throw new Error("process killed");
        },
      });
      const first = new FileJobStore(path);
      await t.runner({ signer: crashing, jobs: first }).enqueue(t.vaultId);
      await t.runner({ signer: crashing, jobs: first }).tick();
      expect((await first.jobs())[0]?.sweeps?.[0]?.op_id).toBeNull();

      // Restart: a fresh store instance on the same file; the event feed indexes the op.
      const second = new FileJobStore(path);
      const loop = new EventLoop({
        client: t.mock,
        store: new InMemoryStore(),
        handlers: [new ClawbackIndexHandler(second)],
        clock: { now: async () => t.mock.now() },
        log: () => undefined,
      });
      await loop.tick();
      await t.runner({ jobs: second }).tick();
      const [job] = await second.jobs();
      expect(job?.status).toBe("broadcast");
      expect(await t.clawbackOps()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dropped tx: rebroadcasts the same transaction; a confirmed conflict makes the job lost", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 500_000);
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const sweep = (await t.jobs.jobs())[0]!.sweeps![0]!;
    t.backend.txs.delete(sweep.txid!); // evicted from the mempool
    await runner.tick();
    expect(t.broadcaster.attempts).toEqual([sweep.op_id, sweep.op_id]);
    expect((await t.jobs.jobs())[0]?.sweeps?.[0]?.txid).toBe(sweep.txid);

    t.backend.txs.delete(sweep.txid!);
    t.broadcaster.failWith("bad-txns-inputs-missingorspent");
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("lost");
    expect(t.logs.some((l) => l.level === "error" && /lost/.test(l.msg))).toBe(true);
    await runner.tick();
    expect(t.broadcaster.attempts).toHaveLength(3);
  });

  it("nothing to sweep: done with no op", async () => {
    const t = await setup();
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    expect((await t.jobs.jobs())[0]).toMatchObject({ status: "done", sweeps: [] });
    expect(await t.clawbackOps()).toBe(0);
    expect((await t.mock.getVault(t.vaultId)).state).toBe("active");
  });

  it("sweeps both addresses, at most 5 coins per op, and skips coins already clawed back", async () => {
    const t = await setup();
    const coins = t.backend.fund(t.addresses.vault, ...Array.from({ length: 7 }, () => 100_000));
    t.backend.fund(t.addresses.allowance, 50_000);
    t.mock.asCaller(GUARDIAN);
    // A human Guardian already clawed back one coin.
    const reserved = coins[0]!;
    await t.mock.beginClawback({
      vault_id: t.vaultId,
      utxos: [{ txid: reserved.txid, vout: reserved.vout, value_sats: reserved.value_sats }],
      fee_rate_sat_vb: 2,
    });
    await t.index.tick();
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const sweeps = (await t.jobs.jobs())[0]!.sweeps!;
    expect(sweeps.map((s) => [s.source, s.utxos.length])).toEqual([
      ["vault", 5],
      ["vault", 1],
      ["allowance", 1],
    ]);
    expect(sweeps.flatMap((s) => s.utxos).some((u) => u.txid === reserved.txid)).toBe(false);
    expect(await t.clawbackOps()).toBe(4);
  });

  it("treats frozen or signed ops of the Vault as conflicts (via the op_frozen index)", async () => {
    const t = await setup();
    const [coin] = t.backend.fund(t.addresses.allowance, 100_000);
    await t.mock.spendAllowance({
      vault_id: t.vaultId,
      amount_sats: "50000",
      destination: `tb1qdstn${"p".repeat(34)}`,
      fee_rate_sat_vb: 5,
      utxos: [{ txid: coin!.txid, vout: coin!.vout, value_sats: coin!.value_sats }],
      envelope: ENVELOPE,
    });
    await t.index.tick();
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const sweep = (await t.jobs.jobs())[0]!.sweeps![0]!;
    expect(sweep.conflicts).toEqual([
      { txid: null, op_id: "1", fee_rate_sat_vb: 5, descendant_fees_sats: null },
    ]);
    expect(sweep.fee_rate_sat_vb).toBe(Math.floor(10_000 / ONE_INPUT_VSIZE));
  });

  it("fails a job for a Vault this Guardian does not guard", async () => {
    const t = await setup({ guardian: "someone.else.near" });
    t.backend.fund(t.addresses.vault, 500_000);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("failed");
    await runner.tick();
    expect(await t.clawbackOps()).toBe(0);
  });

  it("waits until the job is due in NEAR block time, and keeps one open job per Vault", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 500_000);
    t.mock.asCaller(GUARDIAN);
    const later = (t.mock.now() + 60_000_000_000n).toString();
    const scheduled = await t.jobs.enqueue(t.vaultId, "manual", later);
    expect((await t.jobs.enqueue(t.vaultId, "manual", "0")).job_id).toBe(scheduled.job_id);
    const runner = t.runner();
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("queued");
    t.mock.advance(60_000_000_000n);
    await runner.tick();
    expect((await t.jobs.jobs())[0]?.status).toBe("broadcast");
  });
});

describe("JobStore.advance", () => {
  it("only moves a queued job's due_at earlier, never later", async () => {
    const jobs = new InMemoryJobStore();
    expect(await jobs.advance("1", "50")).toBeNull();
    const job = await jobs.enqueue("1", "duress", "100");
    expect(job.trigger).toBe("duress");
    expect((await jobs.advance("1", "150"))?.due_at).toBe("100");
    expect((await jobs.advance("1", "100"))?.due_at).toBe("100");
    expect((await jobs.advance("1", "40"))?.due_at).toBe("40");
    expect((await jobs.job(job.job_id))?.due_at).toBe("40");
    // Another Vault's job is never touched.
    await jobs.enqueue("2", "manual", "100");
    await jobs.advance("1", "10");
    expect((await jobs.jobs()).map((j) => j.due_at)).toEqual(["10", "100"]);
  });

  it("leaves a job that is no longer queued as it is, and ignores finished jobs", async () => {
    const jobs = new InMemoryJobStore();
    const job = await jobs.enqueue("1", "duress", "100");
    await jobs.update({ ...job, status: "running" });
    expect(await jobs.advance("1", "10")).toMatchObject({ status: "running", due_at: "100" });
    await jobs.update({ ...job, status: "done" });
    expect(await jobs.advance("1", "10")).toBeNull();
    expect((await jobs.job(job.job_id))?.due_at).toBe("100");
  });

  it("a manual enqueue brings a duress job queued for later forward to now", async () => {
    const t = await setup();
    const later = (t.mock.now() + 23n * 3_600_000_000_000n).toString();
    const duress = await t.jobs.enqueue(t.vaultId, "duress", later);
    const job = await t.runner().enqueue(t.vaultId);
    expect(job).toMatchObject({
      job_id: duress.job_id,
      trigger: "duress",
      status: "queued",
      due_at: t.mock.now().toString(),
    });
    expect(await t.jobs.jobs()).toMatchObject([{ due_at: t.mock.now().toString() }]);
  });

  it("persists the earlier due_at in the jobs file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-jobs-"));
    try {
      const path = join(dir, "clawbacks.json");
      await new FileJobStore(path).enqueue("1", "duress", "100");
      await new FileJobStore(path).advance("1", "60");
      expect(await new FileJobStore(path).jobs()).toMatchObject([
        { vault_id: "1", trigger: "duress", status: "queued", due_at: "60" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ClawbackRunner edge cases", () => {
  it("sweeps a raced coin that the backend's UTXO list omits (spent in the mempool)", async () => {
    const t = await setup();
    const raced = { txid: txid(9999), vout: 0, value_sats: "500000" };
    const opId = await t.mock.requestWithdrawal({
      vault_id: t.vaultId,
      amount_sats: "400000",
      destination: `tb1qdstn${"p".repeat(34)}`,
      fee_rate_sat_vb: 3,
      utxos: [raced],
      envelope: ENVELOPE,
    });
    t.mock.advance(BigInt((await t.mock.getVault(t.vaultId)).policy.delay_ns));
    await t.mock.beginExecute(opId, ENVELOPE);
    await t.index.tick();
    t.backend.spenders.set(`${raced.txid}:0`, {
      txid: "ee".repeat(32),
      fee_rate_sat_vb: 3,
      fee_sats: "711",
      descendant_fees_sats: "711",
    });
    t.mock.asCaller(GUARDIAN);
    const runner = t.runner();
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const [job] = await t.jobs.jobs();
    expect(job?.sweeps?.map((s) => s.utxos)).toEqual([[raced]]);
    expect(job?.sweeps?.[0]?.conflicts.map((c) => c.txid ?? c.op_id)).toEqual([
      "ee".repeat(32),
      opId,
    ]);
    expect(job?.status).toBe("broadcast");
  });

  it("begins only the coins left when another clawback op took some of them", async () => {
    const t = await setup();
    const [a, b] = t.backend.fund(t.addresses.vault, 600_000, 400_000);
    t.mock.asCaller(GUARDIAN);
    const down = withOverrides(t.mock, {
      beginClawback: async () => {
        throw new Error("rpc down");
      },
    });
    await t.runner({ signer: down }).enqueue(t.vaultId);
    await t.runner({ signer: down }).tick();
    expect((await t.jobs.jobs())[0]?.sweeps?.[0]?.utxos).toHaveLength(2);
    // A human Guardian claws back coin a before the runner retries.
    const human = await t.mock.beginClawback({
      vault_id: t.vaultId,
      utxos: [{ txid: a!.txid, vout: a!.vout, value_sats: a!.value_sats }],
      fee_rate_sat_vb: 2,
    });
    await t.index.tick();
    await t.runner().tick();
    const sweep = (await t.jobs.jobs())[0]!.sweeps![0]!;
    expect(sweep.utxos.map((u) => u.txid)).toEqual([b!.txid]);
    expect(sweep.op_id).not.toBe(human);
    expect(sweep.state).toBe("broadcast");
    expect(await t.clawbackOps()).toBe(2);
  });

  it("an op whose coins are all in another clawback op is covered, and the job is done", async () => {
    const t = await setup();
    const [a] = t.backend.fund(t.addresses.vault, 600_000);
    t.mock.asCaller(GUARDIAN);
    const down = withOverrides(t.mock, {
      beginClawback: async () => {
        throw new Error("rpc down");
      },
    });
    await t.runner({ signer: down }).enqueue(t.vaultId);
    await t.runner({ signer: down }).tick();
    // Same coin, but a different op shape: a 2-coin op is not "this" sweep's op.
    const [extra] = t.backend.fund(t.addresses.vault, 100_000);
    await t.mock.beginClawback({
      vault_id: t.vaultId,
      utxos: [a!, extra!].map(({ txid: id, vout, value_sats }) => ({ txid: id, vout, value_sats })),
      fee_rate_sat_vb: 2,
    });
    await t.index.tick();
    await t.runner().tick();
    const [job] = await t.jobs.jobs();
    expect(job?.sweeps?.[0]).toMatchObject({ state: "covered", op_id: null, utxos: [] });
    expect(job?.status).toBe("done");
    expect(await t.clawbackOps()).toBe(1);
  });

  it("a refused op is skipped while a later op still broadcasts; all refused ends failed", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 500_000);
    t.backend.fund(t.addresses.allowance, 50_000);
    t.mock.asCaller(GUARDIAN);
    const refuseVault = withOverrides(t.mock, {
      beginClawback: async (args) => {
        if ((args.source ?? "vault") === "vault") throw new MorrowContractError("ERR_FEE_TOO_HIGH");
        return t.mock.beginClawback(args);
      },
    });
    const runner = t.runner({ signer: refuseVault });
    await runner.enqueue(t.vaultId);
    await runner.tick();
    const [job] = await t.jobs.jobs();
    expect(job?.sweeps?.map((s) => [s.source, s.state])).toEqual([
      ["vault", "skipped"],
      ["allowance", "broadcast"],
    ]);
    expect(job?.status).toBe("broadcast");

    const u = await setup();
    u.backend.fund(u.addresses.vault, 500_000);
    u.mock.asCaller(GUARDIAN);
    const refuseAll = withOverrides(u.mock, {
      beginClawback: async () => {
        throw new MorrowContractError("ERR_FEE_TOO_HIGH");
      },
    });
    const failing = u.runner({ signer: refuseAll });
    await failing.enqueue(u.vaultId);
    await failing.tick();
    expect((await u.jobs.jobs())[0]?.status).toBe("failed");
  });

  it("fails the job when MORROW_GUARDIAN_BTC_KEY does not match the Vault's guardian_key", async () => {
    const t = await setup();
    t.backend.fund(t.addresses.vault, 500_000);
    t.mock.asCaller(GUARDIAN);
    const wrong = t.runner({ guardianKey: `02${"99".repeat(32)}` });
    await wrong.enqueue(t.vaultId);
    await wrong.tick();
    const [job] = await t.jobs.jobs();
    expect(job?.status).toBe("failed");
    expect(job?.last_error).toMatch(/MORROW_GUARDIAN_BTC_KEY does not match/);
    expect(await t.clawbackOps()).toBe(0);

    const u = await setup();
    u.backend.fund(u.addresses.vault, 500_000);
    u.mock.asCaller(GUARDIAN);
    const right = u.runner({ guardianKey: `03${"22".repeat(32)}` });
    await right.enqueue(u.vaultId);
    await right.tick();
    expect((await u.jobs.jobs())[0]?.status).toBe("broadcast");
  });
});

describe("guardianBroadcaster", () => {
  // tx.rs's pinned 2-input sweep; the witnesses end with the script, right before the locktime.
  const UNSIGNED =
    "020000000201ababababababababababababababababababababababababababababababab0100000000fdffffff02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000fdffffff01db30030000000000160014751e76e8199196d454941c45d1b3a323f1433bd600000000";
  const kit = {
    vault_script_hex: "51".repeat(12),
    allowance_script_hex: "52".repeat(12),
  } as VaultKit;
  const op = (source: "vault" | "allowance") =>
    ({
      op_id: "9",
      vault_id: "1",
      kind: "clawback",
      source,
      state: "signed",
      unsigned_tx_hex: UNSIGNED,
      sighashes: ["11".repeat(32), "22".repeat(32)],
      signatures: [`02${"33".repeat(64)}`, `03${"44".repeat(64)}`],
      witness_template: WITNESS_TEMPLATES.clawback,
    }) as SpendOp;

  it("uses the allowance script for allowance ops and the vault script for vault ops", async () => {
    const raw: string[] = [];
    const backend = new FakeBackend();
    backend.broadcast = async (hex: string) => {
      raw.push(hex);
      return "aa".repeat(32);
    };
    const reader = { getVaultKit: async () => kit } as unknown as ContractClient;
    const broadcast = guardianBroadcaster(reader, backend, new Uint8Array(32).fill(1));
    await broadcast(op("vault"));
    await broadcast(op("allowance"));
    expect(raw[0]!.slice(0, -8).endsWith(`0c${kit.vault_script_hex}`)).toBe(true);
    expect(raw[1]!.slice(0, -8).endsWith(`0c${kit.allowance_script_hex}`)).toBe(true);
  });
});

describe("POST /clawbacks", () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function serve(clawbacks?: Parameters<typeof createApiServer>[2]) {
    const server = createApiServer(new InMemoryStore(), undefined, clawbacks).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return (body: unknown, token?: string) =>
      fetch(`http://127.0.0.1:${port}/clawbacks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
  }

  it("queues a job with the admin token (202), else 401", async () => {
    const t = await setup();
    const runner = t.runner();
    const post = await serve({ adminToken: "s3cret", enqueue: (id) => runner.enqueue(id) });
    const accepted = await post({ vault_id: t.vaultId }, "s3cret");
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ job_id: "1", vault_id: t.vaultId, status: "queued" });
    expect((await post({ vault_id: t.vaultId }, "wrong")).status).toBe(401);
    expect((await post({ vault_id: t.vaultId })).status).toBe(401);
    expect((await post({ vault: 1 }, "s3cret")).status).toBe(400);
    expect(await t.jobs.jobs()).toHaveLength(1);
  });

  it("answers 503 when the job cannot be queued", async () => {
    const post = await serve({
      adminToken: "s3cret",
      enqueue: () => Promise.reject(new Error("disk full")),
    });
    expect((await post({ vault_id: "1" }, "s3cret")).status).toBe(503);
  });

  it("is off (404) without an admin token", async () => {
    const post = await serve();
    expect((await post({ vault_id: "1" }, "anything")).status).toBe(404);
  });
});

describe("Auto-Clawback config", () => {
  const base = {
    MORROW_NEAR_NETWORK: "testnet",
    MORROW_VAULT_CONTRACT: "vault.testnet",
    MORROW_BTC_BACKEND_URL: "https://mempool.space/signet/api",
  };

  it("is off without Guardian material and needs all three variables", () => {
    expect(loadConfig(base)).toMatchObject({
      guardian: null,
      clawbackFeeRate: 2,
      adminToken: null,
    });
    expect(() => loadConfig({ ...base, MORROW_GUARDIAN_ACCOUNT: "g.testnet" })).toThrow(
      /needs all of/,
    );
    const config = loadConfig({
      ...base,
      MORROW_GUARDIAN_ACCOUNT: "g.testnet",
      MORROW_GUARDIAN_NEAR_KEY: "ed25519:abc",
      MORROW_GUARDIAN_BTC_KEY: "AB".repeat(32),
      MORROW_CLAWBACK_FEE_RATE: "5",
      MORROW_WATCHER_ADMIN_TOKEN: "t",
    });
    expect(config.guardian).toEqual({
      accountId: "g.testnet",
      nearKey: "ed25519:abc",
      btcKey: "ab".repeat(32),
    });
    expect(config).toMatchObject({ clawbackFeeRate: 5, adminToken: "t" });
    expect(() => loadConfig({ ...base, MORROW_CLAWBACK_FEE_RATE: "1.5" })).toThrow();
  });
});
