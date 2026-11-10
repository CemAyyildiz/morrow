import {
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  type BitcoinBackend,
  type ContractClient,
  type EnvelopeKeypair,
  type Guardian,
  type MorrowEvent,
  type Policy,
  type SpendOp,
  type TxStatus,
  type U64,
  type Utxo,
} from "@morrow/core-ts";
import { InMemoryJobStore, type ClawbackJob, type ClawbackTrigger } from "@morrow/watcher";
import { describe, expect, it, vi } from "vitest";
import { exitCode, runScenarios } from "../runner.js";
import { SCENARIOS } from "../scenarios.js";
import { judgeGuardian, judgePolicy, type JudgeSession } from "../session.js";
import {
  duressFields,
  runDuress,
  runDuressScenario,
  type DuressBitcoin,
  type DuressScenarioDeps,
} from "./s4-duress.js";

const OWNER = "owner.test.near";
const GUARDIAN = "guardian.test.near";
const GUARDIAN_KEY = `02${"11".repeat(32)}`;
const RECOVERY = `bcrt1q${"q".repeat(38)}`;
const ATTACKER = `bcrt1q${"p".repeat(38)}`;
const FUNDING_TXID = "ab".repeat(32);
const HOUR_NS = 60n * MINUTE_NS;

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

/** `client` with some of its methods replaced. */
function override(client: ContractClient, methods: Partial<ContractClient>): ContractClient {
  return new Proxy(client, {
    get: (target, prop, receiver) =>
      Object.hasOwn(methods, prop)
        ? methods[prop as keyof ContractClient]
        : (Reflect.get(target, prop, receiver) as unknown),
  });
}

/** A reader whose `events_since` passes each event through `map`. */
const mapEvents =
  (map: (event: MorrowEvent) => MorrowEvent): Wrap =>
  (client) =>
    override(client, {
      eventsSince: async (cursor: string, limit: number) =>
        (await client.eventsSince(cursor, limit)).map(map),
    });

/**
 * Fake regtest: funding adds one confirmed coin; a broadcast enters the mempool, and the next
 * block confirms it, moving its coins to the Recovery Address (only confirmed coins are listed,
 * as with `scantxoutset`).
 */
class FakeBitcoin implements DuressBitcoin {
  readonly coins = new Map<string, Utxo[]>();
  readonly txs = new Map<string, TxStatus>();
  readonly broadcasts: SpendOp[] = [];
  private readonly mempool: SpendOp[] = [];
  blocks = 0;

  readonly backend: BitcoinBackend = {
    getUtxos: async (address) => this.coins.get(address) ?? [],
    getTipHeight: async () => 100 + this.blocks,
    getTx: async (txid) => this.txs.get(txid) ?? null,
    broadcast: async () => {
      throw new Error("the runner broadcasts through broadcastSigned");
    },
    getSpender: async () => null,
  };

  async fund(address: string, sats: bigint) {
    const coin = { txid: FUNDING_TXID, vout: 0, value_sats: sats.toString(), height: 100 };
    this.coins.set(address, [...(this.coins.get(address) ?? []), coin]);
    return [{ txid: coin.txid, vout: coin.vout, value_sats: coin.value_sats }];
  }

  async newAddress() {
    return ATTACKER;
  }

  static txid(op: SpendOp) {
    return `c1${op.op_id.padStart(62, "0")}`;
  }

  broadcastSigned = async (op: SpendOp) => {
    if (op.state !== "signed") throw new Error(`op ${op.op_id} is ${op.state}`);
    const txid = FakeBitcoin.txid(op);
    if (!this.txs.has(txid)) {
      this.broadcasts.push(op);
      this.mempool.push(op);
      this.txs.set(txid, { txid, confirmations: 0, block_height: null });
    }
    return txid;
  };

  async mine() {
    this.blocks++;
    for (const op of this.mempool.splice(0)) {
      const txid = FakeBitcoin.txid(op);
      for (const [address, coins] of this.coins) {
        this.coins.set(
          address,
          coins.filter((c) => !op.utxos.some((u) => u.txid === c.txid && u.vout === c.vout)),
        );
      }
      const paid = { txid, vout: 0, value_sats: this.paid(op), height: 100 + this.blocks };
      this.coins.set(op.destination, [...(this.coins.get(op.destination) ?? []), paid]);
      this.txs.set(txid, { txid, confirmations: 1, block_height: 100 + this.blocks });
    }
  }

  /** What the transaction pays its destination. */
  paid(op: SpendOp): U64 {
    return op.amount_sats;
  }
}

type Wrap = (client: ContractClient, mock: MockContractClient) => ContractClient;

interface FixtureOptions {
  owner?: Wrap;
  guardian?: Wrap;
  reader?: Wrap;
  bitcoin?: (fake: FakeBitcoin) => void;
  jobs?: InMemoryJobStore;
  policy?: Partial<Policy>;
  guardianKind?: Guardian["kind"];
  envelopeKey?: EnvelopeKeypair;
}

/** S-4 against the mock contract and fake regtest, with a fake sleep that moves both clocks. */
async function fixture(options: FixtureOptions = {}) {
  const mock = new MockContractClient();
  const envelopeKey = await generateEnvelopeKeypair();
  const session = {
    guardianKey: GUARDIAN_KEY,
    guardianAccountId: GUARDIAN,
    watcher: envelopeKey,
  } as JudgeSession;
  const wrap = (f: Wrap | undefined, client: ContractClient) => (f ? f(client, mock) : client);
  const bitcoin = new FakeBitcoin();
  options.bitcoin?.(bitcoin);
  const jobs = options.jobs ?? new InMemoryJobStore();
  const createVault = vi.fn(async () => {
    const vaultId = await as(mock, OWNER).createVault({
      owner_key: `02${"22".repeat(32)}`,
      policy: judgePolicy(
        session,
        RECOVERY,
        [{ ...judgeGuardian(session), kind: options.guardianKind ?? "auto_clawback" }],
        options.policy,
      ),
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    });
    return {
      vaultId,
      owner: wrap(options.owner, as(mock, OWNER)),
      guardian: wrap(options.guardian, as(mock, GUARDIAN)),
      guardianAccount: GUARDIAN,
      guardianKey: GUARDIAN_KEY,
      envelopeKey: options.envelopeKey ?? envelopeKey,
      bitcoin,
    };
  });
  let wall = 0;
  const deps: DuressScenarioDeps = {
    reader: wrap(options.reader, mock),
    clock: { now: async () => mock.now() },
    sleep: async (ms) => {
      wall += ms;
      mock.advance(BigInt(ms) * 1_000_000n);
    },
    now: () => wall,
    createVault,
    jobs,
    rpcTimeoutMs: 2_000,
  };
  return { mock, deps, bitcoin, jobs, elapsed: () => wall };
}

async function run(deps: DuressScenarioDeps) {
  const lines: string[] = [];
  const results = await runScenarios(
    [{ id: "S-4", name: "Duress", mandatory: false, run: (ctx) => runDuress(ctx, deps) }],
    { release: false, write: (line) => lines.push(line) },
  );
  return { lines, code: exitCode(results), result: lines.at(-1) };
}

const failed = (detail: string) => `S-4 Duress FAIL: ${detail}`;

/** A job store whose queued jobs are due `shift` ns away from what the handler asked for. */
class ShiftedJobs extends InMemoryJobStore {
  constructor(private readonly shift: bigint) {
    super();
  }

  override enqueue(vaultId: U64, trigger: ClawbackTrigger, dueAt: U64): Promise<ClawbackJob> {
    return super.enqueue(vaultId, trigger, (BigInt(dueAt) + this.shift).toString());
  }

  override advance(vaultId: U64, dueAt: U64): Promise<ClawbackJob | null> {
    return super.advance(vaultId, (BigInt(dueAt) + this.shift).toString());
  }
}

/** A job store that cannot save (Firestore down): the handler fails on every try. */
class BrokenJobs extends InMemoryJobStore {
  override enqueue(): Promise<ClawbackJob> {
    return Promise.reject(new Error("Firestore unavailable"));
  }
}

const POLICY_MISMATCH = `Vault 1 does not have the S-4 Policy (a 1-minute Delay, ${GUARDIAN} as its Auto-Clawback Guardian, the session watcher key)`;

describe("S-4 Duress", () => {
  it("queues a duress Clawback at once, sweeps home, refuses the Execute and still shows Pending", async () => {
    const { mock, deps, bitcoin, jobs } = await fixture();
    const { lines, code } = await run(deps);
    expect(lines).toEqual([
      `  Vault 1: the Watcher's duress handler and Clawback runner run in-process as its Auto-Clawback Guardian ${GUARDIAN}`,
      "  Vault 1 holds 0.01 BTC on regtest",
      "  You are coerced: the Owner requests 900,000 sats to the attacker, with a duress-flagged Watcher Envelope",
      "  Withdrawal 1 looks normal on-chain: a 160-hex envelope like any other, and no duress field in the event or get_op",
      expect.stringMatching(
        /^ {2}Duress Clawback queued for \S+: min\(executable_at, signal \+ Delay\) − 65 min = \S+ has already passed with the 1-minute Delay, so it is due at once$/,
      ),
      "  No Vault Address spend before the scheduled time: the Vault coin is still unspent",
      `  Clawback ${"c1" + "2".padStart(62, "0")} confirmed: 999612 sats back at the Recovery Address, co-signed by the NEAR MPC network and broadcast by the Watcher's runner`,
      "  Coerced Execute rejected: ERR_CLAWED_BACK",
      "  Attacker received 0 sats",
      "  Normal mode shows withdrawal 1 as Clawed back and Execute as ERR_CLAWED_BACK",
      "  Duress mode still shows the request as Pending, and Execute as network busy",
      "S-4 Duress PASS",
    ]);
    expect(code).toBe(0);
    const [job] = await jobs.jobs();
    expect(job).toMatchObject({ vault_id: "1", trigger: "duress", status: "done" });
    // The runner, not S-4, began and signed the Clawback, as the Auto-Clawback Guardian.
    const clawback = await mock.getOp("2");
    expect(clawback).toMatchObject({ kind: "clawback", state: "signed", destination: RECOVERY });
    expect(bitcoin.broadcasts.map((op) => op.op_id)).toEqual(["2"]);
    expect(await bitcoin.backend.getUtxos(ATTACKER)).toEqual([]);
    const events = await mock.eventsSince("0", 100);
    expect(events.find((e) => e.kind === "vault_clawed_back")?.data).toMatchObject({
      by: GUARDIAN,
    });
  });

  it("is registered as S-4, not mandatory", () => {
    expect(SCENARIOS.find((s) => s.id === "S-4")).toEqual({
      id: "S-4",
      name: "Duress",
      mandatory: false,
      run: runDuressScenario,
    });
  });

  it("finds duress fields at any depth", () => {
    expect(duressFields({ a: 1, b: [{ c: { is_duress: false } }], Duress: 1 }, "x")).toEqual([
      "x.b[0].c.is_duress",
      "x.Duress",
    ]);
    expect(duressFields({ envelope: "00" }, "x")).toEqual([]);
  });

  it.each([
    ["a Guardian that is not an Auto-Clawback Guardian", { guardianKind: "backup_device" }],
    [
      "a Delay other than 1 minute",
      {
        policy: {
          delay_ns: (2n * MINUTE_NS).toString(),
          policy_change_delay_ns: (2n * MINUTE_NS).toString(),
        },
      },
    ],
  ] as [string, FixtureOptions][])("fails on a Vault with %s", async (_, options) => {
    const { deps } = await fixture(options);
    expect((await run(deps)).result).toBe(failed(POLICY_MISMATCH));
  });

  it("fails on a watcher key that is not the Vault's", async () => {
    const { deps } = await fixture({ envelopeKey: await generateEnvelopeKeypair() });
    expect((await run(deps)).result).toBe(failed(POLICY_MISMATCH));
  });

  it("fails, naming the Vault and the handler's last error, when no job is queued in time", async () => {
    const { deps, elapsed } = await fixture({ jobs: new BrokenJobs() });
    expect((await run(deps)).result).toBe(
      failed(
        "The Watcher queued no Clawback for Vault 1 within 60 s; last error: handler duress_handler failed; will retry: Firestore unavailable",
      ),
    );
    expect(elapsed()).toBeGreaterThanOrEqual(60_000);
    expect(elapsed()).toBeLessThan(70_000);
  });

  it("fails, naming both times, when the job is due later than at once", async () => {
    const { deps } = await fixture({ jobs: new ShiftedJobs(HOUR_NS) });
    expect((await run(deps)).result).toMatch(
      /^S-4 Duress FAIL: The duress Clawback is due at (\S+); min\(executable_at, signal \+ Delay\) − 65 min is (\S+), already passed, so it must be due at once \(NEAR time \S+\)$/,
    );
  });

  it("fails when the job is due before the 8.2 time", async () => {
    const { deps } = await fixture({ jobs: new ShiftedJobs(-2n * HOUR_NS) });
    expect((await run(deps)).result).toMatch(/^S-4 Duress FAIL: The duress Clawback is due at /);
  });

  it("fails when the queued job is not a duress job", async () => {
    class ManualJobs extends InMemoryJobStore {
      override enqueue(vaultId: U64, _trigger: ClawbackTrigger, dueAt: U64) {
        return super.enqueue(vaultId, "manual", dueAt);
      }
    }
    const { deps } = await fixture({ jobs: new ManualJobs() });
    expect((await run(deps)).result).toBe(
      failed("The Watcher queued a manual Clawback for Vault 1, expected duress"),
    );
  });

  it("fails when the Vault coin is spent in the mempool before the runner runs", async () => {
    const { deps, bitcoin } = await fixture({
      bitcoin: (fake) => {
        fake.backend.getSpender = async () => ({
          txid: "ee".repeat(32),
          fee_rate_sat_vb: 5,
          fee_sats: "1000",
          descendant_fees_sats: "1000",
        });
      },
    });
    expect((await run(deps)).result).toBe(
      failed(`The Vault coin ${FUNDING_TXID}:0 was spent before the duress Clawback ran`),
    );
    expect(bitcoin.broadcasts).toEqual([]);
  });

  it("fails when the Vault coin is gone before the runner runs", async () => {
    const { deps, bitcoin } = await fixture({
      bitcoin: (fake) => {
        const getUtxos = fake.backend.getUtxos;
        let reads = 0;
        // The runner never gets to read: the first read is S-4's check.
        fake.backend.getUtxos = async (address) => (reads++ === 0 ? [] : getUtxos(address));
      },
    });
    expect((await run(deps)).result).toBe(
      failed(`The Vault coin ${FUNDING_TXID}:0 was spent before the duress Clawback ran`),
    );
    expect(bitcoin.broadcasts).toEqual([]);
  });

  it("fails, naming the job status, when the sweep never confirms", async () => {
    const { deps, elapsed } = await fixture({
      bitcoin: (fake) => {
        fake.mine = async () => undefined;
      },
    });
    expect((await run(deps)).result).toBe(
      failed("Clawback job 1 is broadcast after 180 s; last error: none"),
    );
    expect(elapsed()).toBeLessThan(200_000);
  });

  it("fails when the runner's job fails", async () => {
    const { deps } = await fixture({
      guardian: (client) =>
        override(client, {
          beginClawback: async () => {
            throw new MorrowContractError("ERR_UNAUTHORIZED");
          },
        }),
    });
    expect((await run(deps)).result).toBe(
      failed("Clawback job 1 is failed; last error: ERR_UNAUTHORIZED"),
    );
  });

  it("fails when the Recovery Address receives less than the Clawback", async () => {
    const { deps } = await fixture({
      bitcoin: (fake) => {
        fake.paid = (op) => (BigInt(op.amount_sats) - 1n).toString();
      },
    });
    expect((await run(deps)).result).toBe(
      failed(
        `The Recovery Address received 999611 sats from Clawback ${"c1" + "2".padStart(62, "0")}, expected 999612`,
      ),
    );
  });

  it("fails when the coerced Execute is not refused", async () => {
    const { deps } = await fixture({
      owner: (client) =>
        override(client, { beginExecute: async (opId: string) => client.getOp(opId) }),
    });
    expect((await run(deps)).result).toBe(
      failed("The coerced Execute succeeded; expected ERR_CLAWED_BACK"),
    );
  });

  it("fails when the coerced Execute is refused with another code", async () => {
    const { deps } = await fixture({
      owner: (client) =>
        override(client, {
          beginExecute: async () => {
            throw new MorrowContractError("ERR_NOT_EXECUTABLE");
          },
        }),
    });
    expect((await run(deps)).result).toBe(failed("ERR_NOT_EXECUTABLE"));
  });

  it("fails when the attacker is paid", async () => {
    const { deps } = await fixture({
      bitcoin: (fake) => {
        fake.coins.set(ATTACKER, [
          { txid: "dd".repeat(32), vout: 1, value_sats: "900000", height: 101 },
        ]);
      },
    });
    expect((await run(deps)).result).toBe(failed("Attacker received 900000 sats"));
  });

  it("fails on a duress envelope longer than a normal one", async () => {
    const { deps, jobs } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "withdrawal_requested"
          ? { ...e, data: { ...e.data, envelope: `${e.data.envelope}00` } }
          : e,
      ),
    });
    expect((await run(deps)).result).toBe(
      failed(
        "Duress leak: the withdrawal_requested envelope is 162 hex characters, a normal one 160",
      ),
    );
    expect(await jobs.jobs()).toEqual([]);
  });

  it("fails when the event carries another envelope", async () => {
    const { deps } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "withdrawal_requested"
          ? { ...e, data: { ...e.data, envelope: "0".repeat(160) } }
          : e,
      ),
    });
    expect((await run(deps)).result).toBe(
      failed("The withdrawal_requested event does not carry the envelope S-4 sent"),
    );
  });

  it("fails on a duress field in the withdrawal_requested event", async () => {
    const { deps } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "withdrawal_requested"
          ? ({ ...e, data: { ...e.data, duress: false } } as MorrowEvent)
          : e,
      ),
    });
    expect((await run(deps)).result).toBe(failed("Duress leak: withdrawal_requested.data.duress"));
  });

  it("fails on a duress field in get_op", async () => {
    const { deps } = await fixture({
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => ({ ...(await client.getOp(opId)), is_duress: true }),
        }),
    });
    expect((await run(deps)).result).toBe(failed("Duress leak: get_op.is_duress"));
  });

  it("fails when the request does not end voided", async () => {
    let clawed = false;
    const { deps } = await fixture({
      owner: (client) =>
        override(client, {
          beginExecute: async (opId: string, envelope: string) => {
            clawed = true;
            return client.beginExecute(opId, envelope);
          },
        }),
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => {
            const op = await client.getOp(opId);
            return clawed && op.state === "voided" ? { ...op, state: "cancelled" } : op;
          },
        }),
    });
    expect((await run(deps)).result).toBe(failed("Withdrawal 1 is cancelled, expected voided"));
  });

  it("puts a time limit on each RPC call", async () => {
    const { deps } = await fixture({
      reader: (client) => override(client, { getOp: () => new Promise<never>(() => undefined) }),
    });
    expect((await run({ ...deps, rpcTimeoutMs: 50 })).result).toBe(
      failed("get_op timed out after 50 ms"),
    );
  });

  it("puts a time limit on the Clawback runner", async () => {
    const { deps } = await fixture({
      guardian: (client) =>
        override(client, { signInput: () => new Promise<never>(() => undefined) }),
    });
    expect((await run({ ...deps, rpcTimeoutMs: 50 })).result).toBe(
      failed("the Clawback runner timed out after 150 ms"),
    );
  });
});
