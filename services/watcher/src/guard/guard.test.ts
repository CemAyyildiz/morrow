import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { FileStore, InMemoryStore, type WatcherStore } from "../store.js";
import { LooseningGuard, VETO_LEAD_NS, envelopeKeypair, readDuress } from "./handler.js";
import { FileGuardStore, InMemoryGuardStore, type GuardStore } from "./store.js";
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

/** The Guardian signer, counting vetoes; `fail` makes the next vetoes throw instead. */
function countingSigner(guardian: ContractClient) {
  const veto = { calls: 0, fail: null as null | (() => Error), after: false };
  const signer = new Proxy(guardian, {
    get: (target, prop, receiver) =>
      prop === "vetoPolicyChange"
        ? async (changeId: string) => {
            veto.calls++;
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
  const ticker = new GuardTicker({ reader: mock, signer, store, clock, log });
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
  return { mock, vaultId, owner, logs, store, veto, loop, ticker, tick, propose, change, entry };
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
    expect((await t.entry(withdrawn)).status).toBe("settled");

    const vetoed = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    await as(t.mock, EMMA).vetoPolicyChange(vetoed);
    await t.tick();
    expect((await t.entry(vetoed)).status).toBe("settled");

    await toVetoAt(t, vetoed);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect(t.logs.filter((l) => l.msg.includes("settled before its veto"))).toHaveLength(2);
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

  for (const code of ["ERR_BAD_OP_STATE", "ERR_CHANGE_NOT_FOUND"] as ErrorCode[]) {
    it(`counts ${code} on the veto as settled`, async () => {
      const t = await setup();
      const id = await t.propose({ recovery_address: NEW_RECOVERY });
      await t.tick();
      t.veto.fail = () => new MorrowContractError(code);
      await toVetoAt(t, id);
      await t.tick();
      expect(t.veto.calls).toBe(1);
      expect((await t.entry(id)).status).toBe("settled");
      await t.tick();
      expect(t.veto.calls).toBe(1);
    });
  }

  it("retries a failing veto each tick until effective_at, never after", async () => {
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

  it("stops at effective_at and logs the missed veto", async () => {
    const t = await setup();
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    t.veto.fail = () => new Error("RPC timeout");
    await toVetoAt(t, id);
    await t.tick();
    t.mock.setNow(BigInt((await t.change(id)).effective_at));
    t.veto.fail = null;
    await t.tick();
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.change(id)).state).toBe("pending");
    expect((await t.entry(id)).status).toBe("settled");
    expect(t.logs.find((l) => l.msg.includes("veto window missed"))).toMatchObject({
      level: "error",
      fields: { change_id: id },
    });
  });

  it("vetoes at once when first seen after veto_at (catch-up), but not after effective_at", async () => {
    const t = await setup();
    const late = await t.propose({ recovery_address: NEW_RECOVERY });
    const { effective_at } = await t.change(late);
    t.mock.setNow(BigInt(effective_at) - 10n * MINUTE_NS);
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.change(late)).state).toBe("vetoed");

    const missed = await t.propose({ recovery_address: NEW_RECOVERY });
    t.mock.setNow(BigInt((await t.change(missed)).effective_at));
    await t.tick();
    expect(t.veto.calls).toBe(1);
    expect((await t.entry(missed)).status).toBe("settled");
    expect(t.logs.some((l) => l.level === "error" && l.msg.includes("missed"))).toBe(true);
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
