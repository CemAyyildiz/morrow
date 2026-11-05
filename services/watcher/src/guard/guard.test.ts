import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAY_NS,
  HOUR_NS,
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  presetPolicy,
  sealEnvelope,
  type ContractClient,
  type EnvelopeKeypair,
  type ErrorCode,
  type Guardian,
  type ProposePolicyChangeArgs,
} from "@morrow/core-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { FileStore, InMemoryStore, type WatcherStore } from "../store.js";
import { createApiServer } from "../heartbeat.js";
import { LooseningGuard, VETO_LEAD_NS, envelopeKeypair, readDuress } from "./handler.js";
import { guardHealth } from "./health.js";
import {
  FileGuardStore,
  GUARD_PRUNE_AFTER_MS,
  InMemoryGuardStore,
  type GuardEntry,
  type GuardStore,
} from "./store.js";
import { GuardTicker } from "./ticker.js";

const OWNER = "daniel.testnet";
const GUARDIAN = "watcher-guardian.testnet";
const EMMA = "emma.testnet";
const PARENT = "challenge.testnet";
const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
const NEW_RECOVERY = `tb1qnewrcv${"q".repeat(32)}`;

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

const never = () => new Promise<never>(() => undefined);

/**
 * The Guardian signer, counting vetoes; `fail` makes the next vetoes throw instead, `hang` makes
 * the vetoes of those change ids never answer.
 */
function countingSigner(guardian: ContractClient) {
  const veto = {
    calls: 0,
    fail: null as null | (() => Error),
    after: false,
    hang: new Set<string>(),
    /** Runs before the real veto, e.g. someone applying the change first. */
    before: null as null | ((changeId: string) => Promise<void>),
  };
  const signer = new Proxy(guardian, {
    get: (target, prop, receiver) =>
      prop === "vetoPolicyChange"
        ? async (changeId: string) => {
            veto.calls++;
            if (veto.hang.has(changeId)) return never();
            await veto.before?.(changeId);
            // `after`: the veto lands, then the call fails (a crash before the result is stored).
            if (veto.fail && veto.after) await guardian.vetoPolicyChange(changeId);
            if (veto.fail) throw veto.fail();
            return guardian.vetoPolicyChange(changeId);
          }
        : Reflect.get(target, prop, receiver),
  });
  return { signer, veto };
}

interface SetupOptions {
  owner?: string;
  guardians?: Guardian[];
  /** The key the watcher holds: the Vault's own (default), another one, or none. */
  watcherKey?: "vault" | "other" | "none";
  challengeOwnerParent?: string | null;
  guardStore?: GuardStore;
  cursorStore?: WatcherStore;
  mock?: MockContractClient;
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

async function setup(options: SetupOptions = {}) {
  vaultKey ??= await generateEnvelopeKeypair();
  otherKey ??= await generateEnvelopeKeypair();
  const owner = options.owner ?? OWNER;
  const mock = options.mock ?? new MockContractClient();
  const vaultId = await as(mock, owner).createVault({
    owner_key: `02${"11".repeat(32)}`,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    policy: presetPolicy("standard", {
      plannedDepositSats: 10_000_000n,
      guardians: options.guardians ?? [AUTO, CONTACT],
      recoveryAddress: RECOVERY,
      network: "signet",
      watcherX25519Pk: vaultKey.publicKeyHex,
    }),
  });
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) =>
    logs.push({ level, msg, fields });
  const clock = { now: async () => mock.now() };
  const store = options.guardStore ?? new InMemoryGuardStore();
  const { signer, veto } = countingSigner(as(mock, GUARDIAN));
  const watcherKey = options.watcherKey ?? "vault";
  const guard = new LooseningGuard({
    reader: mock,
    guardianAccount: GUARDIAN,
    store,
    envelopeKeypair:
      watcherKey === "vault"
        ? envelopeKeypair(vaultKey.secretKeyHex)
        : watcherKey === "other"
          ? otherKey
          : null,
    challengeOwnerParent: options.challengeOwnerParent ?? null,
  });
  const loop = new EventLoop({
    client: mock,
    store: options.cursorStore ?? new InMemoryStore(),
    handlers: [guard],
    clock,
    log,
  });
  // The ticker's reader, with faults: `fail` throws, `hang` never answers for those change ids.
  const read = { fail: null as null | (() => Error), hang: new Set<string>() };
  const tickerReader = new Proxy(mock, {
    get: (target, prop, receiver) => {
      if (prop === "getPolicyChange") {
        return async (id: string) => {
          if (read.hang.has(id)) return never();
          if (read.fail) throw read.fail();
          return target.getPolicyChange(id);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ContractClient;
  const ticker = new GuardTicker({
    reader: tickerReader,
    signer,
    store,
    guardianAccount: GUARDIAN,
    clock,
    log,
    callTimeoutMs: 20,
  });
  /** One pass of both: the guard loop reads events, then the ticker sends due vetoes. */
  const tick = async () => {
    await loop.tick();
    await ticker.tick();
  };
  const propose = async (
    changes: ProposePolicyChangeArgs["changes"],
    flag: "normal" | "duress" = "normal",
  ) =>
    as(mock, owner).proposePolicyChange({
      vault_id: vaultId,
      changes,
      envelope: await sealEnvelope(flag, vaultKey.publicKeyHex),
    });
  const change = (id: string) => mock.getPolicyChange(id);
  const entry = async (id: string) => (await store.entry(id))!;
  return {
    mock,
    vaultId,
    owner,
    logs,
    store,
    veto,
    read,
    loop,
    ticker,
    tick,
    propose,
    change,
    entry,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Moves the mock clock to `veto_at` of the entry (or by `offsetNs` from it). */
async function toVetoAt(t: Setup, changeId: string, offsetNs = 0n) {
  const { veto_at } = await t.entry(changeId);
  t.mock.setNow(BigInt(veto_at) + offsetNs);
}

const higherDelay = { delay_ns: (48n * HOUR_NS).toString() };

describe("LooseningGuard + GuardTicker", () => {
  it("vetoes a loosening change exactly once at effective_at − 65 min", async () => {
    const t = await setup();
    const proposedAt = t.mock.now();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    const effectiveAt = proposedAt + 7n * DAY_NS;
    expect(await t.entry(id)).toMatchObject({
      change_id: id,
      vault_id: t.vaultId,
      proposed_at: proposedAt.toString(),
      effective_at: effectiveAt.toString(),
      veto_at: (effectiveAt - 65n * MINUTE_NS).toString(),
      loosening: true,
      reasons: ["recovery_address changed"],
      duress: "normal",
      status: "scheduled",
    });

    await toVetoAt(t, id, -1n);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect((await t.change(id)).state).toBe("pending");

    await toVetoAt(t, id);
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect((await t.entry(id)).status).toBe("vetoed");

    t.mock.advance(HOUR_NS);
    await t.tick();
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.entry(id)).status).toBe("vetoed");
    expect(JSON.stringify(t.logs)).not.toContain("duress");
  });

  it("leaves a tightening change pending, and it applies at effective_at", async () => {
    const t = await setup();
    const id = await t.propose(higherDelay);
    await t.tick();
    expect(await t.entry(id)).toMatchObject({ loosening: false, reasons: [], status: "skipped" });
    const { effective_at } = await t.change(id);
    t.mock.setNow(BigInt(effective_at) - VETO_LEAD_NS);
    await t.tick();
    t.mock.setNow(BigInt(effective_at));
    await t.tick();
    expect(t.veto.calls).toBe(0);
    await t.mock.applyPolicyChange(id);
    expect((await t.change(id)).state).toBe("applied");
    expect((await t.mock.getVault(t.vaultId)).policy.delay_ns).toBe(higherDelay.delay_ns);
    await t.tick();
    expect((await t.entry(id)).status).toBe("skipped");
  });

  it("vetoes a mixed change when any field loosens", async () => {
    const t = await setup();
    const id = await t.propose({ ...higherDelay, fee_cap_sats: "200000" });
    await t.tick();
    expect(await t.entry(id)).toMatchObject({ loosening: true, reasons: ["fee_cap_sats raised"] });
    await toVetoAt(t, id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");
  });

  it("vetoes a duress-flagged tightening change on the same schedule", async () => {
    const t = await setup();
    const id = await t.propose(higherDelay, "duress");
    await t.tick();
    expect(await t.entry(id)).toMatchObject({
      loosening: false,
      duress: "duress",
      status: "scheduled",
    });
    await toVetoAt(t, id, -1n);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    await toVetoAt(t, id);
    await t.tick();
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(JSON.stringify(t.logs)).not.toContain("duress");
  });

  for (const watcherKey of ["none", "other"] as const) {
    it(`reads duress as unknown with ${watcherKey === "none" ? "no key" : "another key"}; loosening alone decides`, async () => {
      const t = await setup({ watcherKey });
      const tight = await t.propose(higherDelay, "duress");
      await t.tick();
      expect(await t.entry(tight)).toMatchObject({ duress: "unknown", status: "skipped" });
      t.mock.advance(8n * DAY_NS);
      await t.mock.applyPolicyChange(tight);

      const loose = await t.propose({ fee_cap_sats: "200000" });
      await t.tick();
      expect(await t.entry(loose)).toMatchObject({ duress: "unknown", status: "scheduled" });
      await toVetoAt(t, loose);
      await t.tick();
      expect((await t.change(loose)).state).toBe("vetoed");
      expect(t.logs.some((l) => l.msg.includes("not this Vault's watcher key"))).toBe(
        watcherKey === "other",
      );
    });
  }

  it("ignores Vaults where its Guardian is absent or not auto_clawback", async () => {
    for (const guardians of [[CONTACT], [{ ...AUTO, kind: "backup_device" as const }, CONTACT]]) {
      const t = await setup({ guardians });
      const id = await t.propose({ recovery_address: NEW_RECOVERY });
      await t.tick();
      t.mock.advance(7n * DAY_NS - HOUR_NS);
      await t.tick();
      expect(await t.store.entry(id)).toBeNull();
      expect(t.veto.calls).toBe(0);
      expect((await t.change(id)).state).toBe("pending");
    }
  });

  it("skips Challenge Vaults, whose changes the challenge handler vetoes", async () => {
    const t = await setup({ owner: `r1.${PARENT}`, challengeOwnerParent: PARENT });
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    expect(await t.entry(id)).toMatchObject({ loosening: true, status: "skipped" });
    await toVetoAt(t, id);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    // Outside challenge mode the same owner is an ordinary guarded Vault.
    const plain = await setup({ owner: `r1.${PARENT}` });
    const other = await plain.propose({ recovery_address: NEW_RECOVERY });
    await plain.tick();
    expect((await plain.entry(other)).status).toBe("scheduled");
  });

  it("settles a change withdrawn or vetoed before veto_at, with no call", async () => {
    const t = await setup();
    const withdrawn = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    await as(t.mock, t.owner).vetoPolicyChange(
      withdrawn,
      await sealEnvelope("normal", vaultKey.publicKeyHex),
    );
    await t.tick();
    expect(await t.entry(withdrawn)).toMatchObject({ status: "settled", cause: "withdrawn" });

    const vetoed = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    await as(t.mock, EMMA).vetoPolicyChange(vetoed);
    await t.tick();
    expect(await t.entry(vetoed)).toMatchObject({ status: "settled", cause: "vetoed" });

    await toVetoAt(t, vetoed);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect(t.logs.filter((l) => l.msg === "loosening guard: change closed")).toHaveLength(2);
  });

  it("settles at veto time, with no call, when the loop has not seen the settlement yet", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.loop.tick();
    await as(t.mock, EMMA).vetoPolicyChange(id);
    await toVetoAt(t, id);
    await t.ticker.tick();
    expect(t.veto.calls).toBe(0);
    expect((await t.entry(id)).status).toBe("settled");
    expect(t.logs.find((l) => l.msg.includes("already settled"))).toMatchObject({
      fields: { change_id: id, change_state: "vetoed" },
    });
  });

  for (const code of [
    "ERR_BAD_OP_STATE",
    "ERR_CHANGE_NOT_FOUND",
    "ERR_CLAWED_BACK",
    "ERR_VAULT_NOT_ACTIVE",
  ] as ErrorCode[]) {
    it(`counts ${code} on the veto as settled`, async () => {
      const t = await setup();
      const id = await t.propose({ recovery_address: NEW_RECOVERY });
      await t.tick();
      t.veto.fail = () => new MorrowContractError(code);
      await toVetoAt(t, id);
      await t.tick();
      expect(t.veto.calls).toBe(1);
      expect(await t.entry(id)).toMatchObject({ status: "settled", cause: code });
      await t.tick();
      expect(t.veto.calls).toBe(1);
    });
  }

  it("retries a failing veto each tick", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    t.veto.fail = () => new Error("RPC timeout");
    await toVetoAt(t, id);
    await t.tick();
    t.mock.advance(30n * MINUTE_NS);
    await t.tick();
    expect(t.veto.calls).toBe(2);
    expect(await t.entry(id)).toMatchObject({ status: "scheduled", last_error: "RPC timeout" });

    t.veto.fail = null;
    await t.tick();
    expect(t.veto.calls).toBe(3);
    expect(await t.entry(id)).toMatchObject({ status: "vetoed", last_error: null });
  });

  it("keeps vetoing past effective_at while the change is pending", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    t.veto.fail = () => new Error("RPC timeout");
    await toVetoAt(t, id);
    await t.tick();
    t.mock.setNow(BigInt((await t.change(id)).effective_at) + HOUR_NS);
    await t.tick();
    expect((await t.entry(id)).status).toBe("scheduled");
    t.veto.fail = null;
    await t.tick();
    expect(t.veto.calls).toBe(3);
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect((await t.entry(id)).status).toBe("vetoed");
  });

  it("vetoes at once when first seen after veto_at, even after effective_at, until applied", async () => {
    const t = await setup();
    const late = await t.propose({ recovery_address: NEW_RECOVERY });
    t.mock.setNow(BigInt((await t.change(late)).effective_at) - 10n * MINUTE_NS);
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.change(late)).state).toBe("vetoed");

    const overdue = await t.propose({ recovery_address: NEW_RECOVERY });
    t.mock.setNow(BigInt((await t.change(overdue)).effective_at) + DAY_NS);
    await t.tick();
    expect(t.veto.calls).toBe(2);
    expect((await t.change(overdue)).state).toBe("vetoed");
    expect((await t.entry(overdue)).status).toBe("vetoed");
  });

  it("records a change already applied at first sight as settled, without an error", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    t.mock.setNow(BigInt((await t.change(id)).effective_at));
    await t.mock.applyPolicyChange(id);
    await t.tick();
    expect(await t.entry(id)).toMatchObject({
      status: "settled",
      cause: "already settled at first sight",
    });
    expect(t.veto.calls).toBe(0);
    expect(t.logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("logs an applied loosening change as an error (handler, read and race paths)", async () => {
    const applied = "loosening guard: loosening change applied without a veto";
    // The guard loop sees policy_change_applied first.
    const h = await setup();
    const viaEvent = await h.propose({ recovery_address: NEW_RECOVERY });
    await h.loop.tick();
    h.mock.setNow(BigInt((await h.change(viaEvent)).effective_at));
    await h.mock.applyPolicyChange(viaEvent);
    await h.loop.tick();
    expect(await h.entry(viaEvent)).toMatchObject({ status: "settled", cause: "applied" });
    expect(h.logs.find((l) => l.msg === applied)).toMatchObject({
      level: "error",
      fields: { change_id: viaEvent },
    });

    // The ticker reads it applied.
    const r = await setup();
    const viaRead = await r.propose({ recovery_address: NEW_RECOVERY });
    await r.loop.tick();
    r.mock.setNow(BigInt((await r.change(viaRead)).effective_at));
    await r.mock.applyPolicyChange(viaRead);
    await r.ticker.tick();
    expect(r.veto.calls).toBe(0);
    expect(await r.entry(viaRead)).toMatchObject({ status: "settled", cause: "applied" });
    expect(r.logs.find((l) => l.msg === applied)?.level).toBe("error");

    // The veto loses the race to an apply (ERR_BAD_OP_STATE), and the next read shows it applied.
    const race = await setup();
    const viaRace = await race.propose({ recovery_address: NEW_RECOVERY });
    await race.loop.tick();
    race.mock.setNow(BigInt((await race.change(viaRace)).effective_at));
    // Applied between the ticker's read and its veto: the real veto then fails ERR_BAD_OP_STATE.
    race.veto.before = (id) => race.mock.applyPolicyChange(id);
    await race.ticker.tick();
    expect(race.veto.calls).toBe(1);
    expect(await race.entry(viaRace)).toMatchObject({ status: "settled", cause: "applied" });
    expect(race.logs.find((l) => l.msg === applied)?.level).toBe("error");
  });

  it("retries a failed change read, never settles on it; ERR_CHANGE_NOT_FOUND settles", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    t.read.fail = () => new Error("RPC timeout");
    await toVetoAt(t, id);
    await t.ticker.tick();
    expect(t.veto.calls).toBe(0);
    expect(await t.entry(id)).toMatchObject({ status: "scheduled", last_error: "RPC timeout" });
    expect(t.ticker.lastError?.error).toBe("Error");
    t.read.fail = null;
    await t.ticker.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.entry(id)).status).toBe("vetoed");
    expect(t.ticker.lastError).toBeNull();

    const gone = await setup();
    const missing = await gone.propose({ recovery_address: NEW_RECOVERY });
    await gone.tick();
    gone.read.fail = () => new MorrowContractError("ERR_CHANGE_NOT_FOUND");
    await toVetoAt(gone, missing);
    await gone.ticker.tick();
    expect(gone.veto.calls).toBe(0);
    expect(await gone.entry(missing)).toMatchObject({ status: "settled", cause: "not_found" });
  });

  it("times out a hung read or veto, retries it, and still vetoes the other changes", async () => {
    const mock = new MockContractClient();
    const t = await setup({ mock });
    const second = await setup({ mock });
    const hungRead = await t.propose({ recovery_address: NEW_RECOVERY });
    const hungVeto = await second.propose({ recovery_address: NEW_RECOVERY });
    // Both Vaults on one mock: let the first guard see both changes.
    await t.loop.tick();
    t.read.hang.add(hungRead);
    t.veto.hang.add(hungVeto);
    await toVetoAt(t, hungVeto);
    await t.ticker.tick();
    expect(await t.entry(hungRead)).toMatchObject({ status: "scheduled" });
    expect((await t.entry(hungRead)).last_error).toMatch(/get_policy_change timed out/);
    expect((await t.entry(hungVeto)).last_error).toMatch(/veto_policy_change timed out/);
    expect(t.ticker.lastError?.error).toBe("GuardTimeoutError");

    t.read.hang.clear();
    t.veto.hang.clear();
    await t.ticker.tick();
    expect((await t.change(hungRead)).state).toBe("vetoed");
    expect((await t.change(hungVeto)).state).toBe("vetoed");
  });

  it("skips a Vault whose Owner Account is the guard's Guardian account, with a config error", async () => {
    const t = await setup({ owner: GUARDIAN });
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    expect(await t.entry(id)).toMatchObject({
      status: "skipped",
      cause: "owner is the guardian account",
    });
    await toVetoAt(t, id);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect(t.logs.find((l) => l.msg.includes("config error"))).toMatchObject({ level: "error" });
  });

  it("records a Clawback's veto as settled (clawback), not as the guard's veto", async () => {
    const clawback = (t: Setup) =>
      as(t.mock, GUARDIAN).beginClawback({
        vault_id: t.vaultId,
        utxos: [{ txid: "aa".repeat(32), vout: 0, value_sats: "100000" }],
        fee_rate_sat_vb: 2,
      });
    const viaEvent = await setup();
    const a = await viaEvent.propose({ recovery_address: NEW_RECOVERY });
    await viaEvent.loop.tick();
    await clawback(viaEvent);
    expect(await viaEvent.change(a)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    await viaEvent.loop.tick();
    expect(await viaEvent.entry(a)).toMatchObject({ status: "settled", cause: "clawback" });

    const viaRead = await setup();
    const b = await viaRead.propose({ recovery_address: NEW_RECOVERY });
    await viaRead.loop.tick();
    await clawback(viaRead);
    await toVetoAt(viaRead, b);
    await viaRead.ticker.tick();
    expect(viaRead.veto.calls).toBe(0);
    expect(await viaRead.entry(b)).toMatchObject({ status: "settled", cause: "clawback" });
  });

  it("logs a tightening duress change exactly like a tightening normal one", async () => {
    const lines = async (flag: "normal" | "duress") => {
      const t = await setup();
      const id = await t.propose(higherDelay, flag);
      await t.loop.tick();
      expect((await t.entry(id)).status).toBe(flag === "duress" ? "scheduled" : "skipped");
      return t.logs;
    };
    const normal = await lines("normal");
    expect(normal.length).toBeGreaterThan(0);
    expect(await lines("duress")).toEqual(normal);
    expect(normal.map((l) => l.msg)).toEqual(["loosening guard: change recorded"]);
    expect(Object.keys(normal[0]!.fields).sort()).toEqual(["change_id", "vault_id"]);
  });

  it("marks its own veto as vetoed when the result was lost before it was stored", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    t.veto.fail = () => new Error("connection reset");
    t.veto.after = true;
    await toVetoAt(t, id);
    await t.ticker.tick();
    expect((await t.change(id)).state).toBe("vetoed");
    expect((await t.entry(id)).status).toBe("scheduled");
    await t.loop.tick(); // policy_change_vetoed by the guard's own Guardian
    expect((await t.entry(id)).status).toBe("vetoed");
    await t.ticker.tick();
    expect(t.veto.calls).toBe(1);
  });
});

describe("guard restart", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reloads the schedule from disk and still vetoes once", async () => {
    dir = await mkdtemp(join(tmpdir(), "morrow-guard-"));
    const files = { guard: join(dir, "clawbacks.guard.json"), cursor: join(dir, "c.json") };
    const first = await setup({
      guardStore: new FileGuardStore(files.guard),
      cursorStore: new FileStore(files.cursor),
    });
    const id = await first.propose({ recovery_address: NEW_RECOVERY });
    await first.tick();
    const saved = await readFile(files.guard, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ entries: [{ change_id: id, status: "scheduled" }] });
    expect(saved).not.toMatch(/[0-9a-f]{160}/); // no envelope on disk

    // A new process: fresh guard, ticker and stores over the same files and contract.
    const restarted = await setupOver(first.mock, files);
    await toVetoAt(restarted, id);
    await restarted.tick();
    await restarted.tick();
    expect(restarted.veto.calls).toBe(1);
    expect((await first.change(id)).state).toBe("vetoed");
    expect((await new FileGuardStore(files.guard).entry(id))?.status).toBe("vetoed");
  });
});

/** A restarted watcher over the same mock contract and state files (its own Vault is unused). */
async function setupOver(mock: MockContractClient, files: { guard: string; cursor: string }) {
  return setup({
    mock,
    guardStore: new FileGuardStore(files.guard),
    cursorStore: new FileStore(files.cursor),
  });
}

describe("envelope key", () => {
  it("derives the libsodium public key from the secret", async () => {
    const pair = await generateEnvelopeKeypair();
    expect(envelopeKeypair(pair.secretKeyHex)).toEqual(pair);
  });

  it("reads normal, duress, or unknown", async () => {
    const pair = await generateEnvelopeKeypair();
    const other = await generateEnvelopeKeypair();
    const duress = await sealEnvelope("duress", pair.publicKeyHex);
    expect(await readDuress(duress, pair.publicKeyHex, pair)).toBe("duress");
    expect(
      await readDuress(await sealEnvelope("normal", pair.publicKeyHex), pair.publicKeyHex, pair),
    ).toBe("normal");
    expect(await readDuress(duress, pair.publicKeyHex, null)).toBe("unknown");
    expect(await readDuress(duress, pair.publicKeyHex, other)).toBe("unknown");
    // The Vault names another key: the flag is not read even if the envelope would open.
    expect(await readDuress(duress, other.publicKeyHex, pair)).toBe("unknown");
    expect(await readDuress("ab".repeat(80), pair.publicKeyHex, pair)).toBe("unknown");
  });
});

describe("guard config", () => {
  const base = {
    MORROW_NEAR_NETWORK: "testnet",
    MORROW_VAULT_CONTRACT: "vault.testnet",
    MORROW_BTC_BACKEND_URL: "https://mempool.space/signet/api",
  };

  it("reads MORROW_WATCHER_X25519_SK as an optional 32-byte hex secret", () => {
    expect(loadConfig(base).watcherEnvelopeSecretKey).toBeNull();
    expect(
      loadConfig({ ...base, MORROW_WATCHER_X25519_SK: "" }).watcherEnvelopeSecretKey,
    ).toBeNull();
    expect(
      loadConfig({ ...base, MORROW_WATCHER_X25519_SK: "AB".repeat(32) }).watcherEnvelopeSecretKey,
    ).toBe("ab".repeat(32));
    for (const bad of ["ab".repeat(31), "zz".repeat(32), `0x${"ab".repeat(32)}`]) {
      expect(() => loadConfig({ ...base, MORROW_WATCHER_X25519_SK: bad })).toThrow(
        /MORROW_WATCHER_X25519_SK must be a 32-byte hex secret key/,
      );
    }
  });
});

const sample = (changeId: string, overrides: Partial<GuardEntry> = {}) => ({
  change_id: changeId,
  vault_id: "1",
  proposed_at: "1",
  effective_at: "2",
  veto_at: "1",
  loosening: true,
  reasons: ["recovery_address changed"],
  duress: "normal" as const,
  status: "scheduled" as const,
  cause: null,
  last_error: null,
  ...overrides,
});

describe("GuardStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never lets a stale snapshot revert a final status (compare-and-set)", async () => {
    const store = new InMemoryGuardStore();
    const snapshot = await store.add(sample("7"));
    // The handler settles the entry while the ticker still holds its scheduled snapshot.
    expect(
      await store.update({ ...snapshot, status: "settled", cause: "withdrawn" }, "scheduled"),
    ).toBe(true);
    expect(await store.update({ ...snapshot, status: "vetoed" }, "scheduled")).toBe(false);
    expect(await store.update({ ...snapshot, last_error: "RPC timeout" }, "scheduled")).toBe(false);
    expect(await store.entry("7")).toMatchObject({ status: "settled", cause: "withdrawn" });
    expect(await store.update({ ...sample("8"), updated_at: "" }, "scheduled")).toBe(false); // unknown id
  });

  it("drops final entries 30 days after their last update, keeps scheduled ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const store = new InMemoryGuardStore();
    await store.add(sample("1", { status: "skipped", cause: "not loosening" }));
    await store.add(sample("2"));
    vi.setSystemTime(Date.now() + GUARD_PRUNE_AFTER_MS - 1_000);
    await store.add(sample("3", { status: "settled", cause: "vetoed" }));
    expect((await store.entries()).map((e) => e.change_id)).toEqual(["1", "2", "3"]);
    vi.setSystemTime(Date.now() + 2_000);
    await store.add(sample("4"));
    expect((await store.entries()).map((e) => e.change_id)).toEqual(["2", "3", "4"]);
  });
});

describe("corrupt guard file", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("moves it aside, resets the guard cursor and rebuilds the schedule with the first-sight rule", async () => {
    dir = await mkdtemp(join(tmpdir(), "morrow-guard-"));
    const path = join(dir, "clawbacks.guard.json");
    const cursor = new FileStore(join(dir, "clawbacks.guard-cursor.json"));
    const errors: string[] = [];
    const store = new FileGuardStore(path, {
      log: (level, msg) => {
        if (level === "error") errors.push(msg);
      },
      onCorrupt: () => cursor.reset(),
    });
    const t = await setup({ guardStore: store, cursorStore: cursor });
    const settled = await t.propose({ recovery_address: NEW_RECOVERY });
    await as(t.mock, EMMA).vetoPolicyChange(settled);
    const pending = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.loop.tick();
    expect((await cursor.progress()).cursor).not.toBe("0");

    await writeFile(path, "{not json");
    await expect(store.entries()).rejects.toThrow(/corrupt/);
    expect((await readdir(dir)).some((f) => f.startsWith("clawbacks.guard.json.corrupt-"))).toBe(
      true,
    );
    expect(errors).toEqual(["loosening guard: guard file corrupt; moved aside, rebuilding"]);
    expect((await cursor.progress()).cursor).toBe("0");
    expect(await store.entries()).toEqual([]);

    await t.loop.tick();
    expect(await t.entry(settled)).toMatchObject({
      status: "settled",
      cause: "already settled at first sight",
    });
    expect((await t.entry(pending)).status).toBe("scheduled");
    expect(t.logs.filter((l) => l.level === "error")).toEqual([]);
    await toVetoAt(t, pending);
    await t.ticker.tick();
    expect((await t.change(pending)).state).toBe("vetoed");
  });
});

describe("guard health", () => {
  it("reports the guard cursor, its lag, the scheduled count and the last error, no change details", async () => {
    const main = new InMemoryStore();
    const cursor = new InMemoryStore();
    await main.commit("10", "1");
    await cursor.commit("7", "1");
    const store = new InMemoryGuardStore();
    await store.add(sample("41"));
    await store.add(sample("42", { status: "vetoed" }));
    const loop = { lastError: null };
    const ticker = { lastError: { at: "2026-11-05T00:00:00.000Z", error: "GuardTimeoutError" } };
    const health = guardHealth({ cursor, store, loop, ticker });
    expect(await health("10")).toEqual({
      cursor: "7",
      lag: "3",
      scheduled: 1,
      last_error: ticker.lastError,
    });
    expect(await health("5")).toMatchObject({ lag: "0" });

    const server = createApiServer(main, undefined, undefined, health).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/heartbeat`)).json()) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        last_seq: "10",
        guard: { cursor: "7", lag: "3", scheduled: 1 },
      });
      expect(JSON.stringify(body)).not.toMatch(/"4[12]"|recovery_address|duress/);
    } finally {
      server.close();
    }
    // Without the guard the heartbeat has no guard section.
    const plain = createApiServer(main).listen(0);
    await new Promise((resolve) => plain.once("listening", resolve));
    try {
      const { port: p } = plain.address() as AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${p}/heartbeat`)).json()).not.toHaveProperty(
        "guard",
      );
    } finally {
      plain.close();
    }
  });
});

describe("GuardTicker.start", () => {
  it("logs a failing tick, keeps rescheduling, and stops", async () => {
    const store = new InMemoryGuardStore();
    let failures = 2;
    const flaky = new Proxy(store, {
      get: (target, prop, receiver) =>
        prop === "entries"
          ? async () => {
              if (failures-- > 0) throw new Error("disk busy");
              return target.entries();
            }
          : Reflect.get(target, prop, receiver),
    });
    let ticks = 0;
    const logs: string[] = [];
    const ticker = new GuardTicker({
      reader: new MockContractClient(),
      signer: new MockContractClient(),
      store: flaky,
      guardianAccount: GUARDIAN,
      clock: {
        now: async () => {
          ticks++;
          return 0n;
        },
      },
      log: (_level, msg) => logs.push(msg),
      intervalMs: 5,
    });
    ticker.start();
    ticker.start(); // a second start is a no-op
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(4), { timeout: 2_000 });
    expect(logs.filter((m) => m === "loosening guard tick failed; will retry")).toHaveLength(2);
    expect(ticker.lastError).toBeNull(); // the latest tick was clean
    ticker.stop();
    const stoppedAt = ticks;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ticks).toBeLessThanOrEqual(stoppedAt + 1);
  });
});
