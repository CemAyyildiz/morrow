import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MorrowEvent } from "@morrow/core-ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptSourceError,
  FileAttemptStore,
  InMemoryAttemptStore,
  MAX_ATTEMPT_ENTRIES,
  MAX_LOOKUPS_PER_TICK,
  MAX_TX_HASHES,
  loggedIdentities,
  nsToIso,
  scanRejectedAttempts,
  type NewRejectedAttempt,
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

const rejected = (hash: string, second: number): NewRejectedAttempt => ({
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

const event = (
  seq: number,
  kind: string,
  data: Record<string, unknown>,
  vault = "1",
  second = seq,
) =>
  ({
    seq: String(seq),
    block_timestamp: `${1_767_225_600 + second}000000000`,
    vault_id: vault,
    kind,
    data,
  }) as unknown as MorrowEvent;

const requested = (seq: number, opId: string, amount = "50000", second = seq) =>
  event(
    seq,
    "withdrawal_requested",
    {
      op_id: opId,
      amount_sats: amount,
      destination: "tb1qdest",
      executable_at: `${1_767_312_000 + second}000000000`,
      utxos: [],
      envelope: "ab".repeat(80),
    },
    "1",
    second,
  );

describe("AttemptStore: events", () => {
  const roundOf = (vaultId: string) => (vaultId === "1" ? 3 : null);

  it("numbers attempts per round in discovery order and follows each to its outcome", async () => {
    const store = new InMemoryAttemptStore();
    const page = [
      requested(1, "10"),
      requested(2, "11", "70000"),
      event(3, "vault_created", { owner_account: "x" }),
      event(4, "op_voided", { op_id: "10", by_op_id: "12" }, "1", 45),
      event(5, "op_signed", { op_id: "11" }),
      event(6, "policy_change_proposed", {
        change_id: "4",
        changes: { delay_ns: "60000000000" },
        effective_at: "1767400000000000000",
        envelope: "ab".repeat(80),
      }),
      event(7, "policy_change_vetoed", { change_id: "4", by: "guardian.testnet" }),
      event(8, "mystery_kind", { op_id: "10" }),
      requested(9, "13"),
      event(10, "withdrawal_cancelled", { op_id: "13", by: "owner" }),
      // Another Vault's events are skipped.
      event(11, "withdrawal_requested", { op_id: "99" }, "7"),
    ];
    const applied = await store.applyEvents(page, roundOf);
    expect(applied.cursor).toBe("11");
    expect(applied.opened.map((e) => [e.type, e.n])).toEqual([
      ["withdrawal", 1],
      ["withdrawal", 2],
      ["policy_change", 3],
      ["withdrawal", 4],
    ]);
    const entries = await store.entries();
    const byN = (n: number) => entries.find((e) => "n" in e && e.n === n);
    expect(byN(1)).toMatchObject({
      type: "withdrawal",
      round: 3,
      seq: "1",
      op_id: "10",
      outcome: "clawed_back",
      requested_at: "1767225601000000000",
      outcome_at: "1767225645000000000",
      clawback_op_id: "12",
      clawback_txid: null,
      clawback_broadcast: false,
      tx_hash: null,
      time: "2026-01-01T00:00:01.000Z",
    });
    expect(byN(2)).toMatchObject({ outcome: "signed", amount_sats: "70000" });
    expect(byN(3)).toMatchObject({ type: "policy_change", change_id: "4", outcome: "vetoed" });
    expect(byN(4)).toMatchObject({ outcome: "cancelled" });
    expect(entries).toHaveLength(4);
    expect(await store.summary(3)).toEqual({
      round: 3,
      attempts_round: 4,
      attempts_total: 4,
      sats_taken_total: 70_000,
      last_attempt_at: "2026-01-01T00:00:09.000Z",
    });

    // A re-read page changes nothing: no duplicate, no new number, no second count.
    const again = await store.applyEvents(page, roundOf);
    expect(again.opened).toEqual([]);
    expect(await store.entries()).toEqual(entries);
    expect((await store.summary(3)).attempts_total).toBe(4);
    expect(await store.cursor()).toBe("11");
  });

  it("policy changes end withdrawn or applied; a settled outcome never changes", async () => {
    const store = new InMemoryAttemptStore();
    const proposal = (seq: number, id: string) =>
      event(seq, "policy_change_proposed", { change_id: id, changes: {}, effective_at: "1" });
    await store.applyEvents(
      [
        proposal(1, "1"),
        event(2, "policy_change_withdrawn", { change_id: "1" }),
        proposal(3, "2"),
        event(4, "policy_change_applied", { change_id: "2" }),
        event(5, "policy_change_vetoed", { change_id: "2", by: "g" }),
      ],
      roundOf,
    );
    expect((await store.entries()).map((e) => ("outcome" in e ? e.outcome : null))).toEqual([
      "applied",
      "withdrawn",
    ]);
  });

  it("rejected calls get the next number; key rotations get none and do not count", async () => {
    const store = new InMemoryAttemptStore();
    await store.applyEvents([requested(1, "10")], roundOf);
    await store.record(3, ["R"], [{ ...rejected("R", 30), round: 3 }]);
    await store.add({
      type: "key_rotated",
      round: 3,
      time: new Date((1_767_225_600 + 40) * 1000).toISOString(),
      reason: "allowance_low",
      old_public_key: "ed25519:old",
      new_public_key: "ed25519:new",
    });
    await store.applyEvents([requested(2, "11", "1", 50)], roundOf);
    const entries = await store.entries();
    expect(entries.map((e) => [e.type, "n" in e ? e.n : null])).toEqual([
      ["withdrawal", 3],
      ["key_rotated", null],
      ["rejected", 2],
      ["withdrawal", 1],
    ]);
    expect((await store.summary(3)).attempts_round).toBe(3);
    expect((await store.summary(4)).attempts_round).toBe(0);
    expect((await store.summary(null)).attempts_round).toBe(0);
  });

  it("counters are persisted, never derived from the trimmed entries", async () => {
    const store = new InMemoryAttemptStore();
    const many = Array.from({ length: MAX_ATTEMPT_ENTRIES + 10 }, (_, i) => rejected(`H${i}`, i));
    await store.record(1, [], many);
    expect(await store.entries()).toHaveLength(MAX_ATTEMPT_ENTRIES);
    expect(await store.summary(1)).toMatchObject({
      attempts_round: MAX_ATTEMPT_ENTRIES + 10,
      attempts_total: MAX_ATTEMPT_ENTRIES + 10,
    });
  });

  it("fills tx_hash from logged identities in either order and keeps at most 5,000", async () => {
    const store = new InMemoryAttemptStore();
    await store.addTxHashes([["withdrawal_requested:1:10", "HASH10"]]);
    await store.applyEvents([requested(1, "10"), requested(2, "11")], roundOf);
    expect((await store.entries()).map((e) => (e.type === "withdrawal" ? e.tx_hash : ""))).toEqual([
      null,
      "HASH10",
    ]);
    await store.addTxHashes([["withdrawal_requested:1:11", "HASH11"]]);
    expect((await store.entries()).map((e) => (e.type === "withdrawal" ? e.tx_hash : ""))).toEqual([
      "HASH11",
      "HASH10",
    ]);

    const flood = Array.from(
      { length: MAX_TX_HASHES + 5 },
      (_, i) => [`withdrawal_requested:9:${i}`, `F${i}`] as const,
    );
    await store.addTxHashes(flood);
    // The oldest identities are dropped first: an op seen later no longer finds its hash.
    await store.applyEvents(
      [
        event(3, "withdrawal_requested", { op_id: "0" }, "9"),
        event(4, "withdrawal_requested", { op_id: `${MAX_TX_HASHES + 4}` }, "9"),
      ],
      (vaultId) => (vaultId === "9" ? 3 : null),
    );
    const latest = (await store.entries()).filter(
      (e) => e.type === "withdrawal" && e.vault_id === "9",
    );
    expect(latest.map((e) => (e.type === "withdrawal" ? [e.op_id, e.tx_hash] : []))).toEqual([
      [`${MAX_TX_HASHES + 4}`, `F${MAX_TX_HASHES + 4}`],
      ["0", null],
    ]);
  });

  it("restart: a file store keeps entries, numbers, counters and the cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-attempts-"));
    dirs.push(dir);
    const path = join(dir, "attempts.json");
    await new FileAttemptStore(path).applyEvents(
      [requested(1, "10"), event(2, "op_voided", { op_id: "10", by_op_id: "12" })],
      roundOf,
    );
    const reread = new FileAttemptStore(path);
    expect(await reread.cursor()).toBe("2");
    expect(await reread.applyEvents([requested(3, "11")], roundOf)).toMatchObject({
      opened: [{ n: 2, op_id: "11" }],
      cursor: "3",
    });
    expect((await reread.summary(3)).attempts_total).toBe(2);
  });
});

describe("loggedIdentities", () => {
  it("reads the attempt-opening events of the Vault Contract's EVENT_JSON logs", () => {
    const chain = fakeChainSources();
    chain.txs.push({
      hash: "T",
      signer: OWNER,
      receiver: CONTRACT,
      method: "request_withdrawal",
      blockTimestampNs: "1",
      logs: [
        "not an event",
        "EVENT_JSON:{broken",
        `EVENT_JSON:{"standard":"morrow","version":"1.0.0","event":"withdrawal_requested","data":[{"vault_id":"29","payload":{"op_id":"25","amount_sats":"1"}}]}`,
        `EVENT_JSON:{"standard":"morrow","version":"1.0.0","event":"policy_change_proposed","data":[{"vault_id":"29","payload":{"change_id":"3"}}]}`,
        `EVENT_JSON:{"standard":"morrow","version":"1.0.0","event":"input_signed","data":[{"vault_id":"29","payload":{"op_id":"25","input_index":0}}]}`,
        `EVENT_JSON:{"standard":"other","version":"1.0.0","event":"withdrawal_requested","data":[{"vault_id":"29","payload":{"op_id":"26"}}]}`,
      ],
    });
    return chain.sources.txStatus("T", OWNER).then((tx) => {
      expect(loggedIdentities(tx, CONTRACT)).toEqual([
        "withdrawal_requested:29:25",
        "policy_change_proposed:29:3",
      ]);
      expect(loggedIdentities(tx, "elsewhere.testnet")).toEqual([]);
    });
  });

  it("the scanner maps a successful call's logged events to its hash", async () => {
    const chain = fakeChainSources();
    const store = new InMemoryAttemptStore();
    await store.applyEvents([requested(1, "25")], () => 1);
    chain.txs.push({
      hash: "OKTX",
      signer: OWNER,
      receiver: CONTRACT,
      method: "request_withdrawal",
      blockTimestampNs: "1767225600000000000",
      logs: [
        `EVENT_JSON:{"standard":"morrow","version":"1.0.0","event":"withdrawal_requested","data":[{"vault_id":"1","payload":{"op_id":"25"}}]}`,
      ],
    });
    expect((await scanRejectedAttempts(target, chain.sources, store, quiet)).entries).toBe(0);
    expect(await store.entries()).toMatchObject([{ type: "withdrawal", tx_hash: "OKTX" }]);
  });
});
