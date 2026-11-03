import { describe, expect, it } from "vitest";
import type { AttemptEntry } from "../attempts.js";
import { fetchFeed, fetchRoundSource } from "./live.js";
import { logViews } from "./run.js";

const json = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
const down = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

const ENTRIES = [
  {
    type: "rejected",
    round: 1,
    n: 1,
    tx_hash: "h1",
    block_timestamp: "0",
    time: null,
    method: "begin_clawback",
    code: "ERR_UNAUTHORIZED",
    failure: "ActionError",
  },
  {
    type: "withdrawal",
    round: 1,
    n: 2,
    seq: "5",
    vault_id: "1",
    op_id: "7",
    amount_sats: "1",
    destination: "tb1q",
    requested_at: "0",
    executable_at: "0",
    time: null,
    outcome: "clawed_back",
    outcome_at: "1",
    outcome_time: null,
    clawback_op_id: "8",
    clawback_txid: "ab".repeat(32),
    clawback_broadcast: true,
    tx_hash: null,
  },
  {
    type: "policy_change",
    round: 1,
    n: 3,
    seq: "6",
    vault_id: "1",
    change_id: "7",
    changes: {},
    proposed_at: "0",
    effective_at: "0",
    time: null,
    outcome: "vetoed",
    outcome_at: null,
    outcome_time: null,
    tx_hash: "h3",
  },
  {
    type: "key_rotated",
    round: 1,
    time: "t",
    reason: "allowance_low",
    old_public_key: "a",
    new_public_key: "b",
  },
] as unknown as AttemptEntry[];

describe("logViews", () => {
  it("keeps the matching fields per entry type and drops key rotations", () => {
    const views = logViews(ENTRIES);
    expect(views).toHaveLength(3);
    expect(views[0]).toMatchObject({
      type: "rejected",
      n: 1,
      tx_hash: "h1",
      code: "ERR_UNAUTHORIZED",
    });
    expect(views[1]).toMatchObject({
      type: "withdrawal",
      op_id: "7",
      vault_id: "1",
      clawback_op_id: "8",
      clawback_broadcast: true,
    });
    expect(views[2]).toMatchObject({ type: "policy_change", op_id: "7", tx_hash: "h3" });
  });
});

describe("fetchFeed", () => {
  it("returns views for a 200", async () => {
    expect(await fetchFeed("http://c", json(200, { entries: ENTRIES })).entries()).toHaveLength(3);
  });
  it("throws on an HTTP error, a bad body or no network, so the run retries", async () => {
    await expect(
      fetchFeed("http://c", json(503, { error: "unavailable" })).entries(),
    ).rejects.toThrow(/HTTP 503 unavailable/);
    await expect(fetchFeed("http://c", json(200, { nope: 1 })).entries()).rejects.toThrow();
    await expect(fetchFeed("http://c", down).entries()).rejects.toThrow(/fetch failed/);
  });
});

describe("fetchRoundSource", () => {
  it("serves the round and remembers its Vault Contract", async () => {
    const { source, contract } = fetchRoundSource(
      "http://c",
      json(200, { round: 3, vault_contract: "vault.testnet" }),
    );
    expect((await source.current())?.round).toBe(3);
    expect(contract()).toBe("vault.testnet");
  });
  it("throws with the HTTP status and the server's error, so the run can report it", async () => {
    const { source } = fetchRoundSource(
      "http://c",
      json(404, { error: "round 3 funding is not confirmed yet" }),
    );
    await expect(source.current()).rejects.toThrow(/HTTP 404 round 3 funding is not confirmed/);
    await expect(fetchRoundSource("http://c", down).source.current()).rejects.toThrow(
      /fetch failed/,
    );
  });
});
