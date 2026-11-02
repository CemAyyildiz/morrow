import {
  DAY_NS,
  HOUR_NS,
  MIN_VAULT_STORAGE_YOCTO,
  MockContractClient,
  presetPolicy,
  type BitcoinBackend,
  type ContractClient,
  type SpendOp,
  type TxStatus,
  type Utxo,
} from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import { InMemoryJobStore } from "../clawback/jobs.js";
import { ClawbackRunner, type BroadcastSigned } from "../clawback/runner.js";
import { loadConfig } from "../config.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { InMemoryStore } from "../store.js";
import { ChallengeHandler, MAX_VETO_ATTEMPTS, isChallengeOwner } from "./handler.js";

const PARENT = "challenge.testnet";
const GUARDIAN = "watcher-guardian.testnet";
const ENVELOPE = "ab".repeat(80);
const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
const DESTINATION = `tb1qdstn${"p".repeat(34)}`;

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

class FakeBackend implements BitcoinBackend {
  readonly utxos = new Map<string, Utxo[]>();
  readonly txs = new Map<string, TxStatus>();
  async getUtxos(address: string): Promise<Utxo[]> {
    return this.utxos.get(address) ?? [];
  }
  async getTipHeight(): Promise<number> {
    return 100;
  }
  async getTx(id: string): Promise<TxStatus | null> {
    return this.txs.get(id) ?? null;
  }
  async broadcast(): Promise<string> {
    throw new Error("the runner uses broadcastSigned");
  }
  async getSpender(): Promise<null> {
    return null;
  }
}

/** A Guardian signer whose veto throws while `failing.on` is set. */
function flakyVeto(guardian: ContractClient) {
  const failing = { on: true, calls: 0 };
  const signer = new Proxy(guardian, {
    get: (target, prop, receiver) =>
      prop === "vetoPolicyChange"
        ? async (changeId: string) => {
            failing.calls++;
            if (failing.on) throw new Error("RPC timeout");
            return guardian.vetoPolicyChange(changeId);
          }
        : Reflect.get(target, prop, receiver),
  });
  return { signer, failing };
}

async function setup(
  owners: string[] = [`r1.${PARENT}`],
  wrapSigner: (guardian: ContractClient) => ContractClient = (g) => g,
) {
  const mock = new MockContractClient();
  const vaultIds: string[] = [];
  for (const owner of owners) {
    vaultIds.push(
      await as(mock, owner).createVault({
        owner_key: `02${"11".repeat(32)}`,
        deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
        policy: {
          ...presetPolicy("standard", {
            plannedDepositSats: 100_000n,
            guardians: [
              {
                guardian_key: `03${"22".repeat(32)}`,
                guardian_account: GUARDIAN,
                kind: "auto_clawback",
              },
            ],
            recoveryAddress: RECOVERY,
            network: "signet",
            watcherX25519Pk: "44".repeat(32),
          }),
          allowance_limit_sats: "0",
        },
      }),
    );
  }
  const backend = new FakeBackend();
  const jobs = new InMemoryJobStore();
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) =>
    logs.push({ level, msg, fields });
  const broadcasts: string[] = [];
  const broadcastSigned: BroadcastSigned = async (op: SpendOp) => {
    broadcasts.push(op.op_id);
    const id = `c1${op.op_id.padStart(62, "0")}`;
    backend.txs.set(id, { txid: id, confirmations: 0, block_height: null });
    return id;
  };
  const guardian = as(mock, GUARDIAN);
  const clock = { now: async () => mock.now() };
  const runner = new ClawbackRunner({
    reader: mock,
    signer: guardian,
    guardianAccount: GUARDIAN,
    backend,
    broadcastSigned,
    jobs,
    clock,
    log,
    sweepVsize: ({ inputs }) => 11 + 140 * inputs + 43,
  });
  const lookups: string[] = [];
  const reader = new Proxy(mock, {
    get: (target, prop, receiver) => {
      if (prop === "getVault") {
        return (id: string) => {
          lookups.push(id);
          return target.getVault(id);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ContractClient;
  const handler = new ChallengeHandler({
    reader,
    signer: wrapSigner(guardian),
    ownerParent: PARENT,
    enqueue: (vaultId, trigger) => runner.enqueue(vaultId, trigger),
  });
  const store = new InMemoryStore();
  const loop = new EventLoop({ client: mock, store, handlers: [handler], clock, log });
  return { mock, vaultIds, backend, jobs, logs, broadcasts, runner, loop, store, lookups };
}

const withdraw = (mock: MockContractClient, owner: string, vaultId: string, n = 1) =>
  as(mock, owner).requestWithdrawal({
    vault_id: vaultId,
    amount_sats: "50000",
    destination: DESTINATION,
    fee_rate_sat_vb: 2,
    utxos: [{ txid: n.toString(16).padStart(64, "0"), vout: 0, value_sats: "100000" }],
    envelope: ENVELOPE,
  });

const propose = (mock: MockContractClient, owner: string, vaultId: string) =>
  as(mock, owner).proposePolicyChange({
    vault_id: vaultId,
    changes: { delay_ns: (2n * HOUR_NS).toString() },
    envelope: ENVELOPE,
  });

describe("isChallengeOwner", () => {
  it("matches direct sub-accounts of the parent only", () => {
    expect(isChallengeOwner(`r1.${PARENT}`, PARENT)).toBe(true);
    expect(isChallengeOwner(`r12.${PARENT}`, PARENT)).toBe(true);
    expect(isChallengeOwner(PARENT, PARENT)).toBe(false);
    expect(isChallengeOwner(`x.r1.${PARENT}`, PARENT)).toBe(false);
    expect(isChallengeOwner(`evilchallenge.testnet`, PARENT)).toBe(false);
    expect(isChallengeOwner(`r1.other.testnet`, PARENT)).toBe(false);
  });
});

describe("ChallengeHandler", () => {
  it("claws back a Withdrawal Request on a Challenge Vault (trigger challenge), coins to the Recovery Address", async () => {
    const t = await setup();
    const [vaultId] = t.vaultIds as [string];
    const vault = await t.mock.getVault(vaultId);
    t.backend.utxos.set(vault.addresses!.vault, [
      { txid: "aa".repeat(32), vout: 0, value_sats: "100000", height: 90 },
    ]);
    await withdraw(t.mock, `r1.${PARENT}`, vaultId);

    await t.loop.tick();
    const [job] = await t.jobs.jobs();
    expect(job).toMatchObject({ vault_id: vaultId, trigger: "challenge", status: "queued" });
    expect(t.logs.some((l) => l.msg.includes("clawback queued"))).toBe(true);

    await t.runner.tick();
    const [ran] = await t.jobs.jobs();
    expect(ran?.status).toBe("broadcast");
    const op = await t.mock.getOp(ran!.sweeps![0]!.op_id!);
    expect(op).toMatchObject({ kind: "clawback", state: "signed", destination: RECOVERY });
    expect((await t.mock.getVault(vaultId)).state).toBe("clawed_back");
    expect(t.broadcasts).toEqual([op.op_id]);
  });

  it("vetoes a Policy Change on a Challenge Vault", async () => {
    const t = await setup();
    const [vaultId] = t.vaultIds as [string];
    const changeId = await propose(t.mock, `r1.${PARENT}`, vaultId);
    await t.loop.tick();
    const events = await t.mock.eventsSince("0", 100);
    expect(events.at(-1)).toMatchObject({
      kind: "policy_change_vetoed",
      data: { change_id: changeId, by: GUARDIAN },
    });
    expect((await t.mock.getVault(vaultId)).pending_change).toBeNull();
  });

  it("treats a change that is no longer pending as done", async () => {
    const t = await setup();
    const [vaultId] = t.vaultIds as [string];
    const changeId = await propose(t.mock, `r1.${PARENT}`, vaultId);
    await as(t.mock, `r1.${PARENT}`).vetoPolicyChange(changeId, ENVELOPE); // Owner withdraws it
    expect(await t.loop.tick()).toBeGreaterThan(0);
    expect((await t.store.progress()).cursor).toBe(
      (await t.mock.eventsSince("0", 100)).at(-1)!.seq,
    );
    expect(t.logs.some((l) => l.msg.includes("already settled"))).toBe(true);
  });

  it("retries a failed veto on the next tick", async () => {
    let flaky!: ReturnType<typeof flakyVeto>;
    const t = await setup(undefined, (g) => (flaky = flakyVeto(g)).signer);
    const [vaultId] = t.vaultIds as [string];
    await propose(t.mock, `r1.${PARENT}`, vaultId);
    await t.loop.tick();
    expect((await t.mock.getVault(vaultId)).pending_change).not.toBeNull();
    flaky.failing.on = false;
    await t.loop.tick();
    expect(flaky.failing.calls).toBe(2);
    expect((await t.mock.getVault(vaultId)).pending_change).toBeNull();
  });

  it("commits a failed veto once the runner has clawed the Vault back", async () => {
    let flaky!: ReturnType<typeof flakyVeto>;
    const t = await setup(undefined, (g) => (flaky = flakyVeto(g)).signer);
    const [vaultId] = t.vaultIds as [string];
    const vault = await t.mock.getVault(vaultId);
    t.backend.utxos.set(vault.addresses!.vault, [
      { txid: "aa".repeat(32), vout: 0, value_sats: "100000", height: 90 },
    ]);
    await propose(t.mock, `r1.${PARENT}`, vaultId);
    await withdraw(t.mock, `r1.${PARENT}`, vaultId);
    expect(await t.loop.tick()).toBe(2); // vault_created, vault_activated; the veto failed
    await t.runner.enqueue(vaultId, "challenge");
    await t.runner.tick();
    expect((await t.mock.getVault(vaultId)).state).toBe("clawed_back");

    flaky.failing.on = false; // the real veto now fails: the Vault is no longer active
    await t.loop.tick();
    const events = await t.mock.eventsSince("0", 100);
    expect((await t.store.progress()).cursor).toBe(events.at(-1)!.seq);
    expect(t.logs.find((l) => l.msg.includes("already settled"))).toMatchObject({
      level: "info",
      fields: { vault_state: "clawed_back" },
    });
  });

  it("logs an error when the change was applied before the veto", async () => {
    let flaky!: ReturnType<typeof flakyVeto>;
    const t = await setup(undefined, (g) => (flaky = flakyVeto(g)).signer);
    const [vaultId] = t.vaultIds as [string];
    const changeId = await propose(t.mock, `r1.${PARENT}`, vaultId);
    await t.loop.tick(); // the veto fails
    t.mock.advance(8n * DAY_NS);
    await t.mock.applyPolicyChange(changeId);
    flaky.failing.on = false;
    await t.loop.tick();
    expect(t.logs.find((l) => l.msg.includes("applied before veto"))).toMatchObject({
      level: "error",
      fields: { change_id: changeId },
    });
    expect(t.logs.some((l) => l.msg.includes("already settled"))).toBe(false);
  });

  it(`gives up on a veto after ${MAX_VETO_ATTEMPTS} consecutive failures`, async () => {
    let flaky!: ReturnType<typeof flakyVeto>;
    const t = await setup(undefined, (g) => (flaky = flakyVeto(g)).signer);
    const [vaultId] = t.vaultIds as [string];
    await propose(t.mock, `r1.${PARENT}`, vaultId);
    const proposedSeq = (await t.mock.eventsSince("0", 100)).at(-1)!.seq;
    for (let i = 1; i < MAX_VETO_ATTEMPTS; i++) await t.loop.tick();
    expect(flaky.failing.calls).toBe(MAX_VETO_ATTEMPTS - 1);
    expect(BigInt((await t.store.progress()).cursor)).toBeLessThan(BigInt(proposedSeq));
    await t.loop.tick();
    expect(flaky.failing.calls).toBe(MAX_VETO_ATTEMPTS);
    expect((await t.store.progress()).cursor).toBe(proposedSeq);
    expect(t.logs.find((l) => l.msg.includes("giving up"))).toMatchObject({
      level: "error",
      fields: { vault_id: vaultId, error: "RPC timeout" },
    });
  });

  it("ignores Vaults whose owner is outside the parent", async () => {
    const outsiders = ["owner.testnet", `x.r1.${PARENT}`, PARENT];
    const t = await setup(outsiders);
    for (const [i, owner] of outsiders.entries()) {
      await withdraw(t.mock, owner, t.vaultIds[i]!, i + 1);
      await propose(t.mock, owner, t.vaultIds[i]!);
    }
    await t.loop.tick();
    expect(await t.jobs.jobs()).toEqual([]);
    for (const id of t.vaultIds) {
      expect((await t.mock.getVault(id)).pending_change).not.toBeNull();
    }
  });

  it("looks up each Vault's owner once (from vault_created when it has seen it)", async () => {
    const t = await setup();
    const [vaultId] = t.vaultIds as [string];
    await withdraw(t.mock, `r1.${PARENT}`, vaultId, 1);
    await propose(t.mock, `r1.${PARENT}`, vaultId);
    await t.loop.tick();
    expect(t.lookups).toEqual([]);
  });

  it("falls back to one getVault per Vault after a restart past vault_created", async () => {
    const t = await setup();
    const [vaultId] = t.vaultIds as [string];
    const [, activated] = await t.mock.eventsSince("0", 100);
    await t.store.commit(activated!.seq, activated!.block_timestamp);
    await withdraw(t.mock, `r1.${PARENT}`, vaultId, 1);
    await propose(t.mock, `r1.${PARENT}`, vaultId);
    await t.loop.tick();
    expect(await t.jobs.jobs()).toMatchObject([{ vault_id: vaultId, trigger: "challenge" }]);
    expect((await t.mock.getVault(vaultId)).pending_change).toBeNull();
    expect(t.lookups).toEqual([vaultId]);
  });
});

describe("challenge config", () => {
  const base = {
    MORROW_NEAR_NETWORK: "testnet",
    MORROW_VAULT_CONTRACT: "vault.testnet",
    MORROW_BTC_BACKEND_URL: "https://mempool.space/signet/api",
  };
  const guardian = {
    MORROW_GUARDIAN_ACCOUNT: GUARDIAN,
    MORROW_GUARDIAN_NEAR_KEY: "ed25519:abc",
    MORROW_GUARDIAN_BTC_KEY: "ab".repeat(32),
  };

  it("is off by default, needs a Guardian and a NEAR account id", () => {
    expect(loadConfig(base).challengeOwnerParent).toBeNull();
    expect(() => loadConfig({ ...base, MORROW_CHALLENGE_OWNER_PARENT: PARENT })).toThrow(
      /needs the Auto-Clawback Guardian/,
    );
    expect(() =>
      loadConfig({ ...base, ...guardian, MORROW_CHALLENGE_OWNER_PARENT: "Bad Parent" }),
    ).toThrow(/NEAR sub-account id/);
    for (const parent of ["testnet", "a", `${"a".repeat(60)}.testnet`]) {
      expect(() =>
        loadConfig({ ...base, ...guardian, MORROW_CHALLENGE_OWNER_PARENT: parent }),
      ).toThrow(/NEAR sub-account id/);
    }
    expect(
      loadConfig({ ...base, ...guardian, MORROW_CHALLENGE_OWNER_PARENT: PARENT })
        .challengeOwnerParent,
    ).toBe(PARENT);
  });
});
