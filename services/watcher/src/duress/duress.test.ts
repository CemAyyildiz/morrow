import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAY_NS,
  HOUR_NS,
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  generateEnvelopeKeypair,
  presetPolicy,
  sealEnvelope,
  type ContractClient,
  type EnvelopeKeypair,
  type Guardian,
  type Policy,
  type ProposePolicyChangeArgs,
  type U64,
} from "@morrow/core-ts";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobStore, InMemoryJobStore, type JobStore } from "../clawback/jobs.js";
import { VETO_LEAD_NS, envelopeKeypair } from "../guard/handler.js";
import { readHeartbeat } from "../heartbeat.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { FileStore, InMemoryStore, type WatcherStore } from "../store.js";
import { DuressHandler, duressDueAt, ownerEnvelope } from "./handler.js";
import { duressHealth } from "./health.js";
import { FileDuressStore, InMemoryDuressStore, type DuressStore } from "./store.js";

const OWNER = "daniel.testnet";
const GUARDIAN = "watcher-guardian.testnet";
const EMMA = "emma.testnet";
const PARENT = "challenge.testnet";
const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
const DESTINATION = `tb1qdstn${"p".repeat(34)}`;
const LEAD = 65n * MINUTE_NS;

/** A view of the shared mock that signs every call as `account`. */
function as(mock: MockContractClient, account: string): ContractClient {
  return new Proxy(mock, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        target.asCaller(account);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const AUTO: Guardian = {
  guardian_key: `03${"22".repeat(32)}`,
  guardian_account: GUARDIAN,
  kind: "auto_clawback",
};
const CONTACT: Guardian = {
  guardian_key: `02${"33".repeat(32)}`,
  guardian_account: EMMA,
  kind: "trusted_contact",
};

let vaultKey: EnvelopeKeypair;
let otherKey: EnvelopeKeypair;
/** Every withdrawal spends a new coin, also across setups sharing one mock. */
let coins = 0;

interface SetupOptions {
  owner?: string;
  guardians?: Guardian[];
  policy?: Partial<Policy>;
  /** The key the watcher holds: the Vault's own (default) or another one. */
  watcherKey?: "vault" | "other";
  challengeOwnerParent?: string | null;
  store?: DuressStore;
  cursor?: WatcherStore;
  jobs?: JobStore;
  mock?: MockContractClient;
}

async function setup(options: SetupOptions = {}) {
  vaultKey ??= await generateEnvelopeKeypair();
  otherKey ??= await generateEnvelopeKeypair();
  const owner = options.owner ?? OWNER;
  const mock = options.mock ?? new MockContractClient();
  const vaultId = await as(mock, owner).createVault({
    owner_key: `02${"11".repeat(32)}`,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    policy: {
      ...presetPolicy("standard", {
        plannedDepositSats: 10_000_000n,
        guardians: options.guardians ?? [AUTO, CONTACT],
        recoveryAddress: RECOVERY,
        network: "signet",
        watcherX25519Pk: vaultKey.publicKeyHex,
      }),
      ...options.policy,
    },
  });
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) =>
    logs.push({ level, msg, fields });
  const store = options.store ?? new InMemoryDuressStore();
  const jobs = options.jobs ?? new InMemoryJobStore();
  const cursor = options.cursor ?? new InMemoryStore();
  // The handler's reader; `getOp.fail` makes that many get_op calls throw.
  const getOp = { fail: 0 };
  const reader = new Proxy(mock, {
    get: (target, prop, receiver) => {
      if (prop === "getOp") {
        return async (id: U64) => {
          if (getOp.fail > 0) {
            getOp.fail--;
            throw new Error("RPC unavailable");
          }
          return target.getOp(id);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ContractClient;
  const handler = new DuressHandler({
    reader,
    guardianAccount: GUARDIAN,
    store,
    jobs,
    envelopeKeypair:
      options.watcherKey === "other" ? otherKey : envelopeKeypair(vaultKey.secretKeyHex),
    challengeOwnerParent: options.challengeOwnerParent ?? null,
  });
  const loop = new EventLoop({
    client: mock,
    store: cursor,
    handlers: [handler],
    clock: { now: async () => mock.now() },
    log,
  });
  const seal = (flag: "normal" | "duress") => sealEnvelope(flag, vaultKey.publicKeyHex);
  const withdraw = async (flag: "normal" | "duress" = "normal", envelope?: string) =>
    as(mock, owner).requestWithdrawal({
      vault_id: vaultId,
      amount_sats: "100000",
      destination: DESTINATION,
      fee_rate_sat_vb: 2,
      utxos: [{ txid: (++coins).toString(16).padStart(64, "0"), vout: 0, value_sats: "200000" }],
      envelope: envelope ?? (await seal(flag)),
    });
  const propose = async (
    changes: ProposePolicyChangeArgs["changes"],
    flag: "normal" | "duress" = "normal",
  ) =>
    as(mock, owner).proposePolicyChange({
      vault_id: vaultId,
      changes,
      envelope: await seal(flag),
    });
  const vaultJobs = async () => (await jobs.jobs()).filter((j) => j.vault_id === vaultId);
  const executableAt = async (opId: U64) => BigInt((await mock.getOp(opId)).executable_at!);
  return {
    mock,
    vaultId,
    owner,
    logs,
    store,
    jobs,
    cursor,
    getOp,
    loop,
    seal,
    withdraw,
    propose,
    vaultJobs,
    executableAt,
  };
}

const higherDelay = { delay_ns: (48n * HOUR_NS).toString() };

describe("duressDueAt", () => {
  const t = 1_000n * DAY_NS;

  it("is the Delay since the first signal minus 65 min without a live withdrawal", () => {
    expect(duressDueAt(t, 24n * HOUR_NS, [], t)).toBe(t + 24n * HOUR_NS - LEAD);
    expect(LEAD).toBe(VETO_LEAD_NS);
  });

  it("takes the earliest live executable_at when it comes first", () => {
    const live = [t + 20n * HOUR_NS, t + 3n * HOUR_NS, t + 30n * HOUR_NS];
    expect(duressDueAt(t, 24n * HOUR_NS, live, t)).toBe(t + 3n * HOUR_NS - LEAD);
    expect(duressDueAt(t, 2n * HOUR_NS, live, t)).toBe(t + 2n * HOUR_NS - LEAD);
  });

  it("is now once that time has passed", () => {
    const now = t + 23n * HOUR_NS;
    expect(duressDueAt(t, 24n * HOUR_NS, [], now)).toBe(now);
    expect(duressDueAt(t, 24n * HOUR_NS, [now + 30n * MINUTE_NS], now)).toBe(now);
  });
});

describe("ownerEnvelope", () => {
  it("returns the Owner's envelope of exactly the events that carry one", async () => {
    const t = await setup();
    const withdrawal = await t.withdraw();
    const cancelled = await t.withdraw();
    await as(t.mock, EMMA).cancel(cancelled);
    t.mock.advance(24n * HOUR_NS);
    await as(t.mock, t.owner).beginExecute(withdrawal, await t.seal("normal"));
    const change = await t.propose(higherDelay);
    await as(t.mock, t.owner).vetoPolicyChange(change, await t.seal("normal"));
    await as(t.mock, GUARDIAN).beginClawback({
      vault_id: t.vaultId,
      utxos: [{ txid: "ff".repeat(32), vout: 0, value_sats: "300000" }],
      fee_rate_sat_vb: 2,
    });
    const events = await t.mock.eventsSince("0", 100);
    const kinds = new Set<string>();
    for (const event of events) {
      const data = event.data as { envelope?: string | null };
      expect(ownerEnvelope(event)).toBe(data.envelope ?? null);
      if (ownerEnvelope(event) !== null) kinds.add(event.kind);
    }
    expect([...kinds].sort()).toEqual([
      "op_frozen",
      "policy_change_proposed",
      "policy_change_withdrawn",
      "withdrawal_requested",
    ]);
  });
});

describe("DuressHandler", () => {
  it("records a normal withdrawal and queues nothing", async () => {
    const t = await setup();
    const op = await t.withdraw();
    await t.loop.tick();
    expect(await t.store.vault(t.vaultId)).toMatchObject({
      ops: [op],
      first_duress_signal_at: null,
    });
    expect(await t.jobs.jobs()).toEqual([]);
    expect(t.logs).toEqual([
      {
        level: "info",
        msg: "duress handler: envelope recorded",
        fields: { vault_id: t.vaultId, seq: expect.any(String), kind: "withdrawal_requested" },
      },
    ]);
  });

  it("queues a duress job at min(executable_at, t + Delay) − 65 min on the first duress withdrawal", async () => {
    const t = await setup();
    const at = t.mock.now();
    const op = await t.withdraw("duress");
    await t.loop.tick();
    expect(await t.executableAt(op)).toBe(at + 24n * HOUR_NS);
    expect(await t.store.vault(t.vaultId)).toMatchObject({
      ops: [op],
      first_duress_signal_at: at.toString(),
    });
    expect(await t.jobs.jobs()).toMatchObject([
      {
        vault_id: t.vaultId,
        trigger: "duress",
        status: "queued",
        due_at: (at + 24n * HOUR_NS - LEAD).toString(),
        sweeps: null,
      },
    ]);
  });

  it("counts withdrawals recorded before the first signal, which may come from any Owner envelope", async () => {
    const t = await setup();
    const requestedAt = t.mock.now();
    await t.withdraw();
    t.mock.advance(5n * HOUR_NS);
    await t.propose(higherDelay, "duress");
    await t.loop.tick();
    expect((await t.store.vault(t.vaultId))?.first_duress_signal_at).toBe(t.mock.now().toString());
    expect((await t.vaultJobs())[0]?.due_at).toBe((requestedAt + 24n * HOUR_NS - LEAD).toString());
  });

  it("queues the job due now when the deadline − 65 min has already passed", async () => {
    const t = await setup();
    await t.withdraw();
    t.mock.advance(23n * HOUR_NS + 30n * MINUTE_NS); // the first withdrawal executes in 30 min
    await t.withdraw("duress");
    await t.loop.tick();
    expect((await t.vaultJobs())[0]).toMatchObject({
      trigger: "duress",
      due_at: t.mock.now().toString(),
    });
  });

  it("does not commit the event until the state and the job are stored; a failed write retries it", async () => {
    class FlakyJobs extends InMemoryJobStore {
      fail = 1;
      override enqueue(...args: Parameters<InMemoryJobStore["enqueue"]>) {
        if (this.fail-- > 0) return Promise.reject(new Error("disk full"));
        return super.enqueue(...args);
      }
    }
    class FlakyStore extends InMemoryDuressStore {
      fail = 1;
      override markDuress(...args: Parameters<InMemoryDuressStore["markDuress"]>) {
        if (this.fail-- > 0) return Promise.reject(new Error("disk full"));
        return super.markDuress(...args);
      }
    }
    for (const failing of ["jobs", "state"] as const) {
      const jobs = new FlakyJobs();
      const store = new FlakyStore();
      if (failing === "jobs") store.fail = 0;
      else jobs.fail = 0;
      const t = await setup({ jobs, store });
      await t.withdraw("duress");
      const [last] = (await t.mock.eventsSince("0", 100)).slice(-1);
      await t.loop.tick();
      expect(BigInt((await t.cursor.progress()).cursor)).toBeLessThan(BigInt(last!.seq));
      expect(await jobs.jobs()).toEqual([]);
      expect(t.logs.some((l) => l.msg === "handler duress_handler failed; will retry")).toBe(true);

      await t.loop.tick();
      expect((await t.cursor.progress()).cursor).toBe(last!.seq);
      expect(await jobs.jobs()).toMatchObject([{ trigger: "duress", status: "queued" }]);
      expect((await store.vault(t.vaultId))?.first_duress_signal_at).not.toBeNull();
    }
  });

  it("moves due_at earlier for a later withdrawal with an earlier executable_at (lowered Delay)", async () => {
    const t = await setup();
    const t0 = t.mock.now();
    const change = await t.propose({ delay_ns: (2n * HOUR_NS).toString() });
    t.mock.setNow(t0 + 7n * DAY_NS - 10n * MINUTE_NS);
    const signalAt = t.mock.now();
    const first = await t.withdraw("duress");
    await t.loop.tick();
    const [queued] = await t.vaultJobs();
    expect(queued?.due_at).toBe((signalAt + 24n * HOUR_NS - LEAD).toString());

    t.mock.setNow(t0 + 7n * DAY_NS);
    await t.mock.applyPolicyChange(change);
    const second = await t.withdraw();
    expect(await t.executableAt(second)).toBeLessThan(await t.executableAt(first));
    await t.loop.tick();
    // min(both live executable_at, first signal + the 2 h Delay now in force) − 65 min.
    const expected = signalAt + 2n * HOUR_NS - LEAD;
    expect(await t.vaultJobs()).toMatchObject([
      { job_id: queued!.job_id, status: "queued", due_at: expected.toString() },
    ]);
    expect(expected).toBeGreaterThan(t.mock.now());
  });

  it("leaves due_at unchanged for a later withdrawal that executes after the current minimum", async () => {
    const t = await setup();
    await t.withdraw("duress");
    await t.loop.tick();
    const before = await t.vaultJobs();
    t.mock.advance(HOUR_NS);
    await t.withdraw();
    await t.withdraw("duress");
    await t.loop.tick();
    expect(await t.vaultJobs()).toEqual(before);
    expect((await t.store.vault(t.vaultId))?.ops).toHaveLength(3);
  });

  it("moves due_at earlier when a Fast Approval lowers executable_at", async () => {
    const floor = 3n * HOUR_NS;
    const t = await setup({
      policy: { fast_approval: true, fast_approval_floor_ns: floor.toString() },
    });
    const at = t.mock.now();
    const op = await t.withdraw("duress");
    await t.loop.tick();
    expect((await t.vaultJobs())[0]?.due_at).toBe((at + 24n * HOUR_NS - LEAD).toString());
    t.mock.advance(HOUR_NS);
    await as(t.mock, EMMA).fastApprove(op);
    expect(await t.executableAt(op)).toBe(at + HOUR_NS + floor);
    await t.loop.tick();
    expect(await t.vaultJobs()).toMatchObject([
      { status: "queued", due_at: (at + HOUR_NS + floor - LEAD).toString() },
    ]);
  });

  it("ignores recorded withdrawals that were cancelled or executed", async () => {
    const t = await setup();
    const cancelled = await t.withdraw();
    const executed = await t.withdraw();
    await as(t.mock, EMMA).cancel(cancelled);
    t.mock.advance(24n * HOUR_NS);
    await as(t.mock, t.owner).beginExecute(executed, await t.seal("normal"));
    t.mock.advance(HOUR_NS);
    await t.propose(higherDelay, "duress");
    await t.loop.tick();
    expect((await t.store.vault(t.vaultId))?.ops).toEqual([cancelled, executed]);
    // Neither one is live: only the Delay since the signal counts (both would make it due now).
    expect((await t.vaultJobs())[0]?.due_at).toBe((t.mock.now() + 24n * HOUR_NS - LEAD).toString());
  });

  it("retries the event when get_op fails", async () => {
    const t = await setup();
    await t.withdraw("duress");
    t.getOp.fail = 1;
    await t.loop.tick();
    expect(await t.jobs.jobs()).toEqual([]);
    expect(t.loop.lastError).toMatchObject({ error: "Error" });
    await t.loop.tick();
    expect(await t.vaultJobs()).toHaveLength(1);
  });

  it("never queues a Clawback from an envelope it cannot read, and warns without the flag", async () => {
    for (const watcherKey of ["vault", "other"] as const) {
      const t = await setup({ watcherKey });
      // With the Vault's key the envelope does not open; with another key it is not even tried.
      const op =
        watcherKey === "vault"
          ? await t.withdraw("normal", "ab".repeat(80))
          : await t.withdraw("duress");
      await t.loop.tick();
      expect(await t.jobs.jobs()).toEqual([]);
      expect(await t.store.vault(t.vaultId)).toMatchObject({
        ops: [op],
        first_duress_signal_at: null,
      });
      expect(t.logs).toEqual([
        {
          level: "warn",
          msg: "duress handler: envelope could not be read; no Clawback scheduled from it",
          fields: { vault_id: t.vaultId, seq: expect.any(String), kind: "withdrawal_requested" },
        },
      ]);
    }
  });

  it("ignores Vaults that do not list its Guardian as auto_clawback", async () => {
    const asContact: Guardian = { ...AUTO, kind: "trusted_contact" };
    for (const guardians of [[CONTACT], [asContact, CONTACT]]) {
      const t = await setup({ guardians });
      await t.withdraw("duress");
      await t.loop.tick();
      expect(await t.store.vaults()).toEqual([]);
      expect(await t.jobs.jobs()).toEqual([]);
      expect(t.logs).toEqual([]);
    }
  });

  it("skips Challenge Vaults and a Vault whose Owner is the Guardian account", async () => {
    for (const options of [
      { owner: `bob.${PARENT}`, challengeOwnerParent: PARENT },
      { owner: GUARDIAN },
    ]) {
      const t = await setup(options);
      await t.withdraw("duress");
      await t.loop.tick();
      expect(await t.store.vaults()).toEqual([]);
      expect(await t.jobs.jobs()).toEqual([]);
    }
  });

  it("leaves an open job that is already running as it is", async () => {
    const t = await setup({
      policy: { fast_approval: true, fast_approval_floor_ns: (3n * HOUR_NS).toString() },
    });
    const op = await t.withdraw("duress");
    await t.loop.tick();
    const [job] = await t.vaultJobs();
    await t.jobs.update({ ...job!, status: "running" });
    t.mock.advance(HOUR_NS);
    await as(t.mock, EMMA).fastApprove(op);
    await t.loop.tick();
    expect(await t.vaultJobs()).toMatchObject([
      { job_id: job!.job_id, status: "running", due_at: job!.due_at },
    ]);
  });

  it("queues nothing for a Vault already clawed back (replayed history)", async () => {
    const t = await setup();
    await t.withdraw("duress");
    await as(t.mock, GUARDIAN).beginClawback({
      vault_id: t.vaultId,
      utxos: [{ txid: "ee".repeat(32), vout: 0, value_sats: "300000" }],
      fee_rate_sat_vb: 2,
    });
    await t.loop.tick();
    expect((await t.store.vault(t.vaultId))?.first_duress_signal_at).not.toBeNull();
    expect(await t.jobs.jobs()).toEqual([]);
  });

  it("logs a duress envelope exactly like a normal one", async () => {
    const lines = async (flag: "normal" | "duress") => {
      const t = await setup();
      await t.withdraw(flag);
      await t.loop.tick();
      expect(await t.jobs.jobs()).toHaveLength(flag === "duress" ? 1 : 0);
      return t.logs;
    };
    const normal = await lines("normal");
    expect(await lines("duress")).toEqual(normal);
    expect(JSON.stringify(normal)).not.toMatch(/"(normal|duress|unknown)"/);
  });
});

describe("duress restart", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const filesIn = (base: string) => ({
    state: join(base, "clawbacks.duress.json"),
    cursor: join(base, "clawbacks.duress-cursor.json"),
    jobs: join(base, "clawbacks.json"),
  });

  it("reloads the state from disk and never queues a second job", async () => {
    dir = await mkdtemp(join(tmpdir(), "morrow-duress-"));
    const files = filesIn(dir);
    const stores = () => ({
      store: new FileDuressStore(files.state),
      cursor: new FileStore(files.cursor),
      jobs: new FileJobStore(files.jobs),
    });
    const first = await setup(stores());
    const signalAt = first.mock.now();
    await first.withdraw("duress");
    await first.loop.tick();
    const saved = await readFile(files.state, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      vaults: { [first.vaultId]: { first_duress_signal_at: signalAt.toString() } },
    });
    expect(saved).not.toMatch(/[0-9a-f]{160}/); // no envelope on disk
    const [job] = await new FileJobStore(files.jobs).jobs();

    // A new process over the same files and contract (its own new Vault is unused).
    const restarted = await setup({ ...stores(), mock: first.mock });
    await restarted.loop.tick();
    first.mock.advance(HOUR_NS);
    await first.withdraw("duress");
    await restarted.loop.tick();
    const jobs = await new FileJobStore(files.jobs).jobs();
    expect(jobs).toMatchObject([
      { job_id: job!.job_id, vault_id: first.vaultId, due_at: job!.due_at },
    ]);
    expect((await new FileDuressStore(files.state).vault(first.vaultId))?.ops).toHaveLength(2);
  });

  it("moves a corrupt state file aside, resets the cursor and rebuilds without a second job", async () => {
    dir = await mkdtemp(join(tmpdir(), "morrow-duress-"));
    const files = filesIn(dir);
    const cursor = new FileStore(files.cursor);
    const errors: string[] = [];
    const store = new FileDuressStore(files.state, {
      log: (level, msg) => {
        if (level === "error") errors.push(msg);
      },
      onCorrupt: () => cursor.reset(),
    });
    const t = await setup({ store, cursor, jobs: new FileJobStore(files.jobs) });
    const signalAt = t.mock.now();
    await t.withdraw("duress");
    await t.loop.tick();
    const [job] = await t.vaultJobs();
    expect((await cursor.progress()).cursor).not.toBe("0");

    await writeFile(files.state, "{not json");
    await expect(store.vaults()).rejects.toThrow(/corrupt/);
    expect((await readdir(dir)).some((f) => f.startsWith("clawbacks.duress.json.corrupt-"))).toBe(
      true,
    );
    expect(errors).toEqual(["duress handler: state file corrupt; moved aside, rebuilding"]);
    expect((await cursor.progress()).cursor).toBe("0");
    expect(await store.vaults()).toEqual([]);

    await t.loop.tick();
    expect((await store.vault(t.vaultId))?.first_duress_signal_at).toBe(signalAt.toString());
    expect(await t.vaultJobs()).toEqual([job]);
  });
});

describe("duress health", () => {
  it("reports the duress loop's cursor, lag and last error, nothing about any Vault", async () => {
    const t = await setup();
    await t.withdraw("duress");
    const main = new InMemoryStore();
    const [last] = (await t.mock.eventsSince("0", 100)).slice(-1);
    await main.commit(last!.seq, last!.block_timestamp);
    const health = duressHealth({ cursor: t.cursor, loop: t.loop });
    expect(await health(last!.seq)).toEqual({ cursor: "0", lag: last!.seq, last_error: null });
    await t.loop.tick();
    const heartbeat = await readHeartbeat(main, undefined, health);
    expect(heartbeat.duress).toEqual({ cursor: last!.seq, lag: "0", last_error: null });
    expect(Object.keys(heartbeat.duress ?? {})).toEqual(["cursor", "lag", "last_error"]);
  });
});
