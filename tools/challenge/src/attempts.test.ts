import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptSourceError,
  FileAttemptStore,
  InMemoryAttemptStore,
  MAX_ATTEMPT_ENTRIES,
  MAX_LOOKUPS_PER_TICK,
  nsToIso,
  scanRejectedAttempts,
  type RejectedAttempt,
} from "./attempts.js";
import { CONTRACT, fakeChainSources } from "./test-helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const OWNER = "r1.challenge.testnet";
const target = { round: 1, owner_account: OWNER, vault_contract: CONTRACT };
const quiet = () => undefined;

const rejected = (hash: string, second: number): RejectedAttempt => ({
  type: "rejected",
  round: 1,
  tx_hash: hash,
  block_timestamp: `${1_767_225_600 + second}000000000`,
  time: new Date((1_767_225_600 + second) * 1000).toISOString(),
  method: "refresh",
  code: "ERR_STORAGE_BUDGET",
  failure: "ActionError.FunctionCallError.ExecutionError",
});

describe("AttemptStore", () => {
  it("keeps entries newest first, dedupes by hash and keeps the newest 500", async () => {
    const store = new InMemoryAttemptStore();
    await store.record(1, ["A"], [rejected("A", 1)]);
    await store.record(1, ["A", "B"], [rejected("A", 1), rejected("B", 5)]);
    await store.add({
      type: "key_rotated",
      round: 1,
      time: new Date((1_767_225_600 + 3) * 1000).toISOString(),
      reason: "allowance_low",
      old_public_key: "ed25519:old",
      new_public_key: "ed25519:new",
    });
    expect(
      (await store.entries()).map((e) => (e.type === "rejected" ? e.tx_hash : e.type)),
    ).toEqual(["B", "key_rotated", "A"]);
    expect([...(await store.seen(1))]).toEqual(["A", "B"]);

    const many = Array.from({ length: MAX_ATTEMPT_ENTRIES + 10 }, (_, i) =>
      rejected(`H${i}`, i + 10),
    );
    await store.record(1, [], many);
    const entries = await store.entries();
    expect(entries).toHaveLength(MAX_ATTEMPT_ENTRIES);
    expect((entries[0] as RejectedAttempt).tx_hash).toBe(`H${MAX_ATTEMPT_ENTRIES + 9}`);
  });

  it("persists to a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-attempts-"));
    dirs.push(dir);
    const path = join(dir, "state", "attempts.json");
    await new FileAttemptStore(path).record(2, ["X"], [rejected("X", 1)]);
    const reread = new FileAttemptStore(path);
    expect(await reread.entries()).toHaveLength(1);
    expect(await reread.seen(2)).toEqual(new Set(["X"]));
    expect(await reread.seen(1)).toEqual(new Set());
  });
});

describe("scanRejectedAttempts", () => {
  it("retries a hash RPC cannot read yet and ignores calls to other contracts", async () => {
    const chain = fakeChainSources();
    const store = new InMemoryAttemptStore();
    chain.txs.push(
      {
        hash: "OTHER",
        signer: OWNER,
        receiver: "elsewhere.testnet",
        method: "x",
        blockTimestampNs: "1767225600000000000",
        failure: "ERR_UNAUTHORIZED",
      },
      {
        hash: "LAGGING",
        signer: OWNER,
        receiver: CONTRACT,
        method: "cancel",
        blockTimestampNs: "1767225601000000000",
        failure: "ERR_BAD_OP_STATE",
      },
    );
    chain.state.unreadable.add("LAGGING");
    expect(await scanRejectedAttempts(target, chain.sources, store, quiet)).toMatchObject({
      entries: 0,
      lookups: 2,
      listError: null,
    });
    expect(await store.seen(1)).toEqual(new Set(["OTHER"]));
    expect((await store.pending(1)).map((p) => [p.hash, p.tries])).toEqual([["LAGGING", 1]]);

    // Retried straight from the pending list, even with the indexer down.
    chain.state.unreadable.clear();
    chain.state.indexerDown = true;
    const second = await scanRejectedAttempts(target, chain.sources, store, quiet);
    expect(second.entries).toBe(1);
    expect(second.listError).toBeInstanceOf(AttemptSourceError);
    expect(await store.entries()).toMatchObject([
      { tx_hash: "LAGGING", method: "cancel", code: "ERR_BAD_OP_STATE" },
    ]);
    expect(await store.pending(1)).toEqual([]);

    chain.state.indexerDown = false;
    expect((await scanRejectedAttempts(target, chain.sources, store, quiet)).lookups).toBe(0);
    expect(chain.statusCalls).toEqual(["OTHER", "LAGGING", "LAGGING"]);
  });

  it("does at most 50 lookups per call; the rest stay pending for the next one", async () => {
    const chain = fakeChainSources();
    const store = new InMemoryAttemptStore();
    for (let i = 0; i < 60; i++) {
      chain.txs.push({
        hash: `F${i}`,
        signer: OWNER,
        receiver: CONTRACT,
        method: "refresh",
        blockTimestampNs: `${1_767_225_600 + i}000000000`,
        failure: "ERR_STORAGE_BUDGET",
      });
    }
    const first = await scanRejectedAttempts(target, chain.sources, store, quiet);
    expect(first).toMatchObject({ entries: MAX_LOOKUPS_PER_TICK, lookups: MAX_LOOKUPS_PER_TICK });
    expect(await store.pending(1)).toHaveLength(10);
    // Oldest first.
    expect(chain.statusCalls[0]).toBe("F0");
    expect((await scanRejectedAttempts(target, chain.sources, store, quiet)).lookups).toBe(10);
    expect(await store.entries()).toHaveLength(60);
    expect((await scanRejectedAttempts(target, chain.sources, store, quiet, 0)).lookups).toBe(0);
  });

  it("records an unreadable indexer timestamp with time null instead of throwing", async () => {
    const chain = fakeChainSources();
    const store = new InMemoryAttemptStore();
    chain.txs.push({
      hash: "ODD",
      signer: OWNER,
      receiver: CONTRACT,
      method: "refresh",
      blockTimestampNs: "not-a-number",
      failure: "ERR_STORAGE_BUDGET",
    });
    expect((await scanRejectedAttempts(target, chain.sources, store, quiet)).entries).toBe(1);
    expect(await store.entries()).toMatchObject([
      { tx_hash: "ODD", block_timestamp: "not-a-number", time: null },
    ]);
    expect(nsToIso("1767225600000000000")).toBe("2026-01-01T00:00:00.000Z");
    expect(nsToIso("9".repeat(30))).toBeNull();
    expect(nsToIso("-5")).toBeNull();
  });

  it("returns the indexer failure as listError", async () => {
    const chain = fakeChainSources();
    chain.state.indexerDown = true;
    const result = await scanRejectedAttempts(
      target,
      chain.sources,
      new InMemoryAttemptStore(),
      quiet,
    );
    expect(result.listError?.message).toMatch(/HTTP 503/);
    expect(result.lookups).toBe(0);
  });
});
