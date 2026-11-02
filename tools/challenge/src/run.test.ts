import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockContractClient } from "@morrow/core-ts";
import { afterEach, describe, expect, it } from "vitest";
import { FileAttemptStore, InMemoryAttemptStore, type AttemptStore } from "./attempts.js";
import type { LogLevel } from "./log.js";
import { STORAGE_TOP_UP_YOCTO } from "./near.js";
import { RecoveryWallet } from "./recovery-wallet.js";
import { openRound } from "./round.js";
import { RoundRunner, type RoundRunnerOptions } from "./run.js";
import { createRoundServer } from "./serve.js";
import {
  FileRoundStore,
  InMemoryRoundStore,
  publicRound,
  type RoundRecord,
  type RoundStore,
} from "./store.js";
import {
  CONTRACT,
  FakeBackend,
  GUARDIAN,
  GUARDIAN_KEY,
  PARENT,
  RECOVERY_SECRET,
  X25519,
  fakeChainSources,
  fakeWatcher,
  mockRunNear,
} from "./test-helpers.js";

const NEAR = 1_000_000_000_000_000_000_000_000n;
const MINUTE = 60_000;

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Logged {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

function setup(
  stores: { store?: RoundStore; attempts?: AttemptStore } = {},
  mock = new MockContractClient({ allowedNetworks: ["signet"] }),
  backend = new FakeBackend(),
) {
  const store = stores.store ?? new InMemoryRoundStore();
  const attempts = stores.attempts ?? new InMemoryAttemptStore();
  const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
  if (!backend.utxos.has(wallet.address)) backend.fund(wallet.address, 1_000_000);
  const near = mockRunNear(mock);
  const watcher = fakeWatcher(mock);
  const chain = fakeChainSources();
  const logs: Logged[] = [];
  const clock = { now: Date.now() };
  const opens = { calls: 0 };
  const openNext = () => {
    opens.calls++;
    return openRound({
      store,
      near: near.near,
      wallet,
      ownerParent: PARENT,
      vaultContract: CONTRACT,
      nearNetwork: "testnet",
      policy: {
        guardianAccount: GUARDIAN,
        guardianKey: GUARDIAN_KEY,
        watcherX25519Pk: X25519,
        fundSats: 100_000n,
      },
      next: true,
      sleep: async () => undefined,
    });
  };
  const runner = (overrides: Partial<RoundRunnerOptions> = {}) =>
    new RoundRunner({
      store,
      attempts,
      near: near.near,
      backend,
      watcher: watcher.watcher,
      sources: chain.sources,
      openNext,
      now: () => clock.now,
      log: (level, msg, fields = {}) => logs.push({ level, msg, fields }),
      ...overrides,
    });
  /** Confirms the round's funding at `height`. */
  const confirm = (round: RoundRecord, height = 300) => {
    const id = round.funding_txid as string;
    backend.txs.set(id, { txid: id, confirmations: 1, block_height: height });
  };
  const current = async () => (await store.current()) as RoundRecord;
  const errors = () => logs.filter((l) => l.level === "error");
  return {
    mock,
    backend,
    wallet,
    near,
    store,
    attempts,
    watcher,
    chain,
    logs,
    errors,
    clock,
    opens,
    runner,
    confirm,
    current,
  };
}

/** A runner with round 1 open and its funding confirmed at 300. */
async function withRound(t: ReturnType<typeof setup>) {
  const runner = t.runner();
  await runner.tick();
  const round = await t.current();
  t.confirm(round);
  await runner.tick();
  return { runner, round: await t.current() };
}

async function serve(store: RoundStore, attempts: AttemptStore): Promise<string> {
  const server = createRoundServer(store, attempts);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("RoundRunner: end of round", () => {
  it("opens round 1 when there is no round", async () => {
    const t = setup();
    expect(await t.runner().tick()).toBe(true);
    expect(await t.current()).toMatchObject({ round: 1, status: "open" });
  });

  it("clawed back: one tick opens and funds round N+1, closes N; GET /round serves it once confirmed", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    const base = await serve(t.store, t.attempts);
    expect(((await (await fetch(`${base}/round`)).json()) as { round: number }).round).toBe(1);

    await t.watcher.watcher.requestClawback(round.vault_id as string);
    const broadcasts = t.backend.broadcasts.length;
    await runner.tick();

    const next = await t.current();
    expect(next).toMatchObject({ round: 2, status: "open", owner_account: `r2.${PARENT}` });
    expect(next.funding_txid).not.toBeNull();
    expect(t.backend.broadcasts).toHaveLength(broadcasts + 1);
    expect((await t.store.rounds()).map((r) => [r.round, r.status])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    // A Clawback needs no sweep.
    expect(await t.store.pendingSweeps()).toEqual([]);

    // Not served until the funding confirms.
    expect((await fetch(`${base}/round`)).status).toBe(404);
    t.confirm(next, 320);
    await runner.tick();
    const served = (await (await fetch(`${base}/round`)).json()) as Record<string, unknown>;
    expect(served).toEqual(publicRound(await t.current()));
    expect(served).toMatchObject({ round: 2, funding_height: 320 });
  });

  it("does not start a tick while one is running", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const runner = t.runner({
      openNext: async () => {
        calls++;
        await gate;
        throw new Error("stop here");
      },
    });
    const first = runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await runner.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(t.logs.some((l) => l.msg.startsWith("tick skipped"))).toBe(true);
  });

  it("a failed opening is retried as --next at most once per 10 minutes", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.near.failures.createOwnerAccount = new Error("RPC timeout");
    await runner.tick();
    expect(t.opens.calls).toBe(2);
    expect((await t.store.latest())?.failed_step).toBe("account");
    expect(t.errors().at(-1)?.msg).toBe("opening the next round failed");

    t.clock.now += 9 * MINUTE;
    await runner.tick();
    expect(t.opens.calls).toBe(2);

    delete t.near.failures.createOwnerAccount;
    t.clock.now += 1 * MINUTE + 1_000;
    await runner.tick();
    expect(t.opens.calls).toBe(3);
    // Round 2 failed at the account step; round 3 replaces round 1.
    expect((await t.store.rounds()).map((r) => [r.round, r.status])).toEqual([
      [1, "closed"],
      [2, "closed"],
      [3, "open"],
    ]);
  });

  it("Recovery empty: logs an error each tick and leaves the old round open", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.backend.utxos.set(t.wallet.address, []);
    await runner.tick();
    await runner.tick();
    const short = t
      .errors()
      .filter((l) => l.msg === "Recovery balance too low to open the next round");
    expect(short).toHaveLength(2);
    expect(t.opens.calls).toBe(3);
    expect(await t.current()).toMatchObject({ round: 1, status: "open" });
    expect((await t.store.rounds()).map((r) => r.round)).toEqual([1]);
  });

  it("rotation: opens N+1 near the deadline, asks the watcher to claw back N, sweeps until clawed back", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    const deadline = round.rotation_deadline_height as number;
    t.backend.tip = deadline - 145;
    await runner.tick();
    expect((await t.current()).round).toBe(1);

    t.watcher.state.down = true;
    t.backend.tip = deadline - 144;
    await runner.tick();
    expect((await t.current()).round).toBe(2);
    expect(await t.store.pendingSweeps()).toEqual([
      { round: 1, vault_id: round.vault_id, added_at: expect.any(String) },
    ]);
    expect(t.errors().map((l) => l.msg)).toContain("old Vault not swept yet; will retry next tick");

    t.watcher.state.down = false;
    await runner.tick();
    expect(t.watcher.requests).toEqual([round.vault_id]);
    expect((await t.mock.getVault(round.vault_id as string)).state).toBe("clawed_back");
    await runner.tick();
    expect(await t.store.pendingSweeps()).toEqual([]);
    expect(t.watcher.requests).toEqual([round.vault_id]);
    // Round 2 is not rotated: its deadline is not known yet.
    expect((await t.current()).round).toBe(2);
  });

  it("a sweep recorded for a round that is still open stays inert", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.backend.tip = (round.rotation_deadline_height as number) - 10;
    t.backend.utxos.set(t.wallet.address, []);
    await runner.tick();
    expect(await t.store.pendingSweeps()).toHaveLength(1);
    expect(t.watcher.requests).toEqual([]);
    expect((await t.current()).round).toBe(1);
  });
});

describe("RoundRunner: storage and key", () => {
  it("tops up 0.5 NEAR when storage is below 0.2 NEAR; a failure is logged and retried", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    expect(t.near.topUps).toEqual([]);
    const vaultId = round.vault_id as string;
    t.near.vaultPatches.set(vaultId, { storage_balance: (NEAR / 10n).toString() });
    t.near.failures.topUpStorage = new Error("RPC down");
    await runner.tick();
    expect(t.errors().map((l) => l.msg)).toContain("storage step failed; will retry next tick");
    delete t.near.failures.topUpStorage;
    await runner.tick();
    expect(t.near.topUps).toEqual([{ vaultId, yocto: STORAGE_TOP_UP_YOCTO }]);
    expect(STORAGE_TOP_UP_YOCTO).toBe(NEAR / 2n);
  });

  it("key spent: serves a fresh key, then deletes the old one and logs key_rotated", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    const oldPublic = round.near_function_call_public_key;
    t.near.setAllowance(round.owner_account, oldPublic, NEAR / 100n);

    t.near.failures.addFunctionCallKey = new Error("nonce");
    await runner.tick();
    let now = await t.current();
    expect(now.near_function_call_key).toBe(round.near_function_call_key);
    expect(now.next_function_call_public_key).toMatch(/^ed25519:/);
    expect(t.near.deleted).toEqual([]);
    const pending = now.next_function_call_public_key;

    delete t.near.failures.addFunctionCallKey;
    await runner.tick();
    now = await t.current();
    expect(now.near_function_call_public_key).toBe(pending);
    expect(now.near_function_call_key).not.toBe(round.near_function_call_key);
    expect(now.next_function_call_key).toBeNull();
    expect(now.retired_function_call_public_keys).toEqual([]);
    expect(t.near.deleted).toEqual([oldPublic]);
    expect(t.near.keys.get(`${round.owner_account} ${pending}`)).toBe(NEAR);
    expect(publicRound(now).near_function_call_key).toBe(now.near_function_call_key);
    expect(await t.attempts.entries()).toEqual([
      {
        type: "key_rotated",
        round: 1,
        time: expect.any(String),
        reason: "allowance_low",
        old_public_key: oldPublic,
        new_public_key: pending,
      },
    ]);

    // The fresh key is fine: nothing more happens.
    await runner.tick();
    expect((await t.current()).near_function_call_public_key).toBe(pending);
  });

  it("key gone: adds a fresh key and records key_missing", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.near.setAllowance(round.owner_account, round.near_function_call_public_key, null);
    await runner.tick();
    expect((await t.current()).near_function_call_public_key).not.toBe(
      round.near_function_call_public_key,
    );
    expect(t.near.deleted).toEqual([]);
    expect((await t.attempts.entries())[0]).toMatchObject({
      type: "key_rotated",
      reason: "key_missing",
    });
  });

  it("an old key that fails to delete is retried next tick", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.near.setAllowance(round.owner_account, round.near_function_call_public_key, 0n);
    t.near.failures.deleteKey = new Error("nonce");
    await runner.tick();
    expect((await t.current()).retired_function_call_public_keys).toEqual([
      round.near_function_call_public_key,
    ]);
    delete t.near.failures.deleteKey;
    await runner.tick();
    expect((await t.current()).retired_function_call_public_keys).toEqual([]);
    expect(t.near.deleted).toEqual([round.near_function_call_public_key]);
  });
});

describe("RoundRunner: rejected attempts", () => {
  it("logs a rejected call once with method and code; successful calls are skipped", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.chain.txs.push(
      {
        hash: "OK1",
        signer: round.owner_account,
        receiver: CONTRACT,
        method: "request_withdrawal",
        blockTimestampNs: "1767225600000000000",
      },
      {
        hash: "BAD1",
        signer: round.owner_account,
        receiver: CONTRACT,
        method: "spend_allowance",
        blockTimestampNs: "1767225660000000000",
        failure: "ERR_ALLOWANCE_LIMIT",
      },
    );
    await runner.tick();
    await runner.tick();
    expect(await t.attempts.entries()).toEqual([
      {
        type: "rejected",
        round: 1,
        tx_hash: "BAD1",
        block_timestamp: "1767225660000000000",
        time: "2026-01-01T00:01:00.000Z",
        method: "spend_allowance",
        code: "ERR_ALLOWANCE_LIMIT",
        failure: "ActionError.FunctionCallError.ExecutionError",
      },
    ]);
    // Seen hashes are not read again.
    expect(t.chain.statusCalls.filter((h) => h === "BAD1")).toHaveLength(1);
    expect(t.chain.statusCalls.filter((h) => h === "OK1")).toHaveLength(1);

    const base = await serve(t.store, t.attempts);
    const response = await fetch(`${base}/attempts`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await response.json()) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("a failure without an ERR_* code gives code null and the raw kind", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.chain.txs.push({
      hash: "GAS1",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "1767225600000000000",
      failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { HostError: { GasExceeded: {} } } },
        },
      },
    });
    await runner.tick();
    expect(await t.attempts.entries()).toMatchObject([
      {
        tx_hash: "GAS1",
        method: "refresh",
        code: null,
        failure: "ActionError.FunctionCallError.HostError.GasExceeded",
      },
    ]);
  });

  it("indexer down: the scan is skipped this tick, the other steps still run", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.chain.state.indexerDown = true;
    t.chain.txs.push({
      hash: "BAD1",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "1767225600000000000",
      failure: "ERR_STORAGE_BUDGET",
    });
    t.near.vaultPatches.set(round.vault_id as string, { storage_balance: "0" });
    await runner.tick();
    expect(await t.attempts.entries()).toEqual([]);
    expect(t.near.topUps).toHaveLength(1);
    expect(
      t.logs.some(
        (l) => l.level === "warn" && l.msg.startsWith("attempt scan: indexer unavailable"),
      ),
    ).toBe(true);
    t.chain.state.indexerDown = false;
    await runner.tick();
    expect(await t.attempts.entries()).toMatchObject([
      { tx_hash: "BAD1", code: "ERR_STORAGE_BUDGET" },
    ]);
  });

  it("scans the previous round too, so its last attempts are logged after it is replaced", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.chain.txs.push({
      hash: "LATE",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "request_withdrawal",
      blockTimestampNs: "1767225600000000000",
      failure: "ERR_CLAWED_BACK",
    });
    await runner.tick();
    expect((await t.current()).round).toBe(2);
    expect(await t.attempts.entries()).toMatchObject([{ round: 1, code: "ERR_CLAWED_BACK" }]);
  });

  it("restart mid-round: no duplicate round and no duplicate entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-run-"));
    dirs.push(dir);
    const files = () => ({
      store: new FileRoundStore(join(dir, "rounds.json")),
      attempts: new FileAttemptStore(join(dir, "attempts.json")),
    });
    const mock = new MockContractClient({ allowedNetworks: ["signet"] });
    const backend = new FakeBackend();
    const a = setup(files(), mock, backend);
    const { round } = await withRound(a);
    const tx = {
      hash: "BAD1",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "1767225600000000000",
      failure: "ERR_STORAGE_BUDGET",
    };
    a.chain.txs.push(tx);
    await a.runner().tick();
    expect(await a.attempts.entries()).toHaveLength(1);

    // A new process over the same files.
    const b = setup(files(), mock, backend);
    b.near.keys.clear();
    for (const [k, v] of a.near.keys) b.near.keys.set(k, v);
    b.chain.txs.push(tx);
    await b.runner().tick();
    expect(b.opens.calls).toBe(0);
    expect((await b.store.rounds()).map((r) => r.round)).toEqual([1]);
    expect(await b.attempts.entries()).toHaveLength(1);
    expect(b.chain.statusCalls).toEqual([]);
  });
});

describe("RoundRunner.start", () => {
  it("ticks repeatedly and stops", async () => {
    const t = setup();
    let scans = 0;
    const loop = t
      .runner({
        intervalMs: 1,
        sources: {
          ...t.chain.sources,
          signedBy: async (...args) => {
            scans++;
            return t.chain.sources.signedBy(...args);
          },
        },
      })
      .start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await loop.stop();
    const after = scans;
    expect(after).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scans).toBe(after);
    expect((await t.current()).round).toBe(1);
    // Later ticks found round 1 and did not open another.
    expect(t.opens.calls).toBe(1);
  });
});

const NOON = Date.parse("2026-11-03T12:00:00.000Z");
const msgs = (t: ReturnType<typeof setup>, level: LogLevel) =>
  t.logs.filter((l) => l.level === level).map((l) => l.msg);

describe("RoundRunner: top-up limits and Owner Account balance", () => {
  it("refills the Owner Account with 1 NEAR below 0.5 NEAR, at most once per 10 minutes", async () => {
    const t = setup();
    t.clock.now = NOON;
    const { runner, round } = await withRound(t);
    expect(t.near.transfers).toEqual([]);
    t.near.balances.set(round.owner_account, NEAR / 2n - 1n);
    await runner.tick();
    expect(t.near.transfers).toEqual([{ accountId: round.owner_account, yocto: NEAR }]);

    t.near.balances.set(round.owner_account, NEAR / 10n);
    t.clock.now += 9 * MINUTE;
    await runner.tick();
    expect(t.near.transfers).toHaveLength(1);
    t.clock.now += MINUTE;
    await runner.tick();
    expect(t.near.transfers).toHaveLength(2);
  });

  it("storage top-ups: one per 10 minutes per Vault, and at most 10 per UTC day overall", async () => {
    const t = setup();
    t.clock.now = NOON;
    const { runner, round } = await withRound(t);
    t.near.vaultPatches.set(round.vault_id as string, { storage_balance: "0" });
    await runner.tick();
    await runner.tick();
    expect(t.near.topUps).toHaveLength(1);
    t.clock.now += 10 * MINUTE;
    await runner.tick();
    expect(t.near.topUps).toHaveLength(2);

    // The cap is shared with Owner Account top-ups (and other Vaults).
    for (let i = 0; i < 8; i++) await t.store.addTopUp(`balance:x${i}`, t.clock.now);
    t.clock.now += 10 * MINUTE;
    await runner.tick();
    expect(t.near.topUps).toHaveLength(2);
    expect(msgs(t, "error")).toContain("daily top-up cap reached; skipping");

    // A new UTC day.
    t.clock.now = Date.parse("2026-11-04T00:05:00.000Z");
    await runner.tick();
    expect(t.near.topUps).toHaveLength(3);
  });
});

describe("RoundRunner: rotation safety", () => {
  it("past the hard deadline with no successor, asks the watcher to claw the round back", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.backend.utxos.set(t.wallet.address, []);
    t.backend.tip = round.rotation_deadline_height as number;
    t.watcher.state.down = true;
    await runner.tick();
    expect(msgs(t, "error")).toContain(
      "round past its rotation deadline and not clawed back; will retry",
    );
    expect((await t.current()).round).toBe(1);

    t.watcher.state.down = false;
    await runner.tick();
    expect(t.watcher.requests).toContain(round.vault_id);
    expect((await t.mock.getVault(round.vault_id as string)).state).toBe("clawed_back");

    // Clawed back: the normal next-round path applies once the Recovery Address is funded.
    t.backend.fund(t.wallet.address, 1_000_000);
    await runner.tick();
    expect((await t.current()).round).toBe(2);
  });

  it("a margin not below 80% of the Escape Timelock never rotates on margin", async () => {
    const t = setup();
    const first = await withRound(t);
    const window = Math.floor((first.round.escape_timelock_blocks * 4) / 5);
    const runner = t.runner({
      rotationMarginBlocks: window,
      nextEscapeTimelockBlocks: first.round.escape_timelock_blocks,
    });
    t.backend.tip = 301; // just after the funding confirmed at 300
    await runner.tick();
    await runner.tick();
    expect((await t.current()).round).toBe(1);
    const reported = msgs(t, "error").filter((m) =>
      m.startsWith("MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS is not below 80%"),
    );
    expect(reported).toHaveLength(1);

    // The hard deadline still ends the round (and checks the next round's margin).
    t.backend.tip = first.round.rotation_deadline_height as number;
    await runner.tick();
    expect((await t.current()).round).toBe(2);
    expect(
      msgs(t, "error").filter((m) =>
        m.startsWith("MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS is not below 80%"),
      ),
    ).toHaveLength(2);
  });
});

describe("RoundRunner: failed openings", () => {
  it("stops opening after 5 failed openings in a row until restart", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.near.failures.createOwnerAccount = new Error("RPC timeout");
    for (let i = 0; i < 6; i++) {
      t.clock.now += 11 * MINUTE;
      await runner.tick();
    }
    expect(t.opens.calls).toBe(1 + 5);
    expect(
      msgs(t, "error").filter((m) => m === "round opening disabled until restart"),
    ).toHaveLength(2);
    // Round 1 stays current; no further r<N> is created.
    expect((await t.store.rounds()).map((r) => r.round)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("restart: an unfinished opening throttles the new process until updated_at + 10 min", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-run-"));
    dirs.push(dir);
    const files = () => ({
      store: new FileRoundStore(join(dir, "rounds.json")),
      attempts: new FileAttemptStore(join(dir, "attempts.json")),
    });
    const mock = new MockContractClient({ allowedNetworks: ["signet"] });
    const backend = new FakeBackend();
    const a = setup(files(), mock, backend);
    const { round } = await withRound(a);
    await a.watcher.watcher.requestClawback(round.vault_id as string);
    a.near.failures.createOwnerAccount = new Error("RPC timeout");
    await a.runner().tick();
    const failed = (await a.store.latest()) as RoundRecord;
    expect(failed).toMatchObject({ round: 2, status: "opening", failed_step: "account" });

    const b = setup(files(), mock, backend);
    const runner = b.runner();
    b.clock.now = Date.parse(failed.updated_at) + 9 * MINUTE;
    await runner.tick();
    expect(b.opens.calls).toBe(0);
    b.clock.now = Date.parse(failed.updated_at) + 10 * MINUTE;
    await runner.tick();
    expect(b.opens.calls).toBe(1);
    expect((await b.current()).round).toBe(3);
  });

  it("a crash mid-opening (failed_step null) also counts for the throttle", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    await t.store.put({ ...round, round: 2, status: "opening", failed_step: null });
    await runner.tick();
    expect(t.opens.calls).toBe(1);
    t.clock.now += 10 * MINUTE + 1_000;
    await runner.tick();
    expect(t.opens.calls).toBe(2);
  });

  it("a failed opening whose funding never reached the network is not swept", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.backend.failBroadcast = "lost";
    await runner.tick();
    const failed = (await t.store.latest()) as RoundRecord;
    expect(failed).toMatchObject({ round: 2, status: "opening", failed_step: "funding" });
    expect(failed.funding_txid).not.toBeNull();
    expect(await t.store.pendingSweeps()).toEqual([]);
    expect(t.watcher.requests).not.toContain(failed.vault_id);
  });

  it("a failed opening whose funding is on the network is swept", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    t.backend.failBroadcast = "lost";
    await runner.tick();
    const failed = (await t.store.latest()) as RoundRecord;
    const txid = failed.funding_txid as string;
    // The broadcast did arrive after all (e.g. relayed by another node).
    t.backend.txs.set(txid, { txid, confirmations: 0, block_height: null });
    t.backend.failBroadcast = null;
    await runner.tick();
    expect(t.watcher.requests).toContain(failed.vault_id);
  });
});

describe("RoundRunner: retired rounds and scan errors", () => {
  it("deletes a clawed-back closed round's published key after its last scan, then stops scanning it", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    await t.watcher.watcher.requestClawback(round.vault_id as string);
    await runner.tick();
    const closed = (await t.store.rounds())[0] as RoundRecord;
    expect(closed).toMatchObject({ round: 1, status: "closed", published_key_deleted: true });
    expect(t.near.deleted).toContain(round.near_function_call_public_key);

    t.chain.txs.push({
      hash: "AFTER",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "1767225600000000000",
      failure: "ERR_CLAWED_BACK",
    });
    await runner.tick();
    expect(t.chain.statusCalls).not.toContain("AFTER");
  });

  it("logs a store failure during the scan at error, not as an indexer outage", async () => {
    const t = setup();
    const { runner, round } = await withRound(t);
    t.chain.txs.push({
      hash: "X",
      signer: round.owner_account,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "1767225600000000000",
      failure: "ERR_STORAGE_BUDGET",
    });
    t.attempts.addPending = async () => {
      throw new Error("disk full");
    };
    await runner.tick();
    expect(t.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "attempt scan failed; will retry next tick",
        fields: expect.objectContaining({ error: "disk full" }),
      }),
    );
  });
});
