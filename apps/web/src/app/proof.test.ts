import { afterEach, describe, expect, it, vi } from "vitest";
import {
  p2wshAddress,
  vaultScriptTemplate,
  type Guardian,
  type PolicyChange,
  type Vault,
} from "@morrow/core-ts/browser";
import {
  EVENTS_PAGE,
  MAX_EVENT_PAGES,
  canonicalVaultId,
  changeLine,
  changeSummary,
  codeHashFrom,
  advanceScan,
  firstCursorAtOrAfter,
  newScan,
  formatAmount,
  fullAccessKeysFrom,
  guarantees,
  hasWatcher,
  isDue,
  parseEvents,
  parseKit,
  parseVault,
  pendingFrom,
  policyRows,
  proofRpc,
  readKit,
  readProof,
  recompute,
  recomputeAnnouncement,
  residualRisk,
  stateNotice,
  rpcAnswer,
  trustStatements,
  watcherLine,
  withdrawalLine,
  type EventPage,
  type ProofEvent,
  type ProofFacts,
  type ProofKit,
  type ProofRpc,
  type Scan,
  type RpcAnswer,
  type StatementFacts,
} from "./proof";
import { resolveRoute } from "./routes";
import { heldAfter } from "./useProof";
import { copy } from "@/copy";

/** Local wall-clock times, so the tests hold in any time zone. */
const NOW = new Date(2026, 10, 12, 9, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const HOUR_NS = 3_600_000_000_000n;

const RECOVERY = "tb1qrecoveryhomeaddress000000000000000000";
const NEW_RECOVERY = "tb1qnewrecoveryaddress0000000000000000000";
const TRUSTED: Guardian = {
  guardian_key: `02${"aa".repeat(32)}`,
  guardian_account: "alice.testnet",
  kind: "trusted_contact",
};
const WATCHER: Guardian = {
  guardian_key: `03${"bb".repeat(32)}`,
  guardian_account: "watcher.morrow.testnet",
  kind: "auto_clawback",
};

/** Vault #7 of the matrix: 24 h / 7 d / 26,280 blocks, a Trusted Contact and a watcher. */
function vault(overrides: Partial<Vault> = {}, policy: Partial<Vault["policy"]> = {}): Vault {
  return {
    vault_id: "7",
    owner_account: "owner.testnet",
    owner_key: `02${"11".repeat(32)}`,
    policy: {
      delay_ns: (24n * HOUR_NS).toString(),
      policy_change_delay_ns: (7n * 24n * HOUR_NS).toString(),
      escape_timelock_blocks: 26_280,
      recovery_address: RECOVERY,
      allowance_limit_sats: "100000",
      fee_cap_sats: "20000",
      fast_approval: false,
      fast_approval_floor_ns: HOUR_NS.toString(),
      guardians: [TRUSTED, WATCHER],
      btc_network: "signet",
      watcher_x25519_pk: "cc".repeat(32),
      ...policy,
    },
    state: "active",
    cosigner_pubkeys: { vault: `02${"dd".repeat(32)}`, allowance: `03${"ee".repeat(32)}` },
    addresses: { vault: "tb1qvaultaddress", allowance: "tb1qallowanceaddress" },
    storage_balance: "5000000000000000000000",
    created_at: ns(at(10, 8)),
    pending_change: null,
    ...overrides,
  };
}

const CHANGE: PolicyChange = {
  change_id: "4",
  vault_id: "7",
  changes: { recovery_address: NEW_RECOVERY },
  proposed_at: ns(at(4, 9)),
  effective_at: ns(at(11, 9)),
  state: "pending",
  vetoed_by: null,
};

const FACTS: StatementFacts = {
  now: NOW,
  contractId: "vault.morrow.testnet",
  coSigner: "v1.signer-prod.testnet",
  codeHash: "9fQfdZ8sTLoJ8JKXqi4hpcXpDa5k5Ky3HQeQyh4Bh8WG",
  withdrawals: [],
  clawedBack: null,
  caughtUp: true,
};

let seqs = 0;
function event(kind: string, data: Record<string, unknown>, time = at(11, 10), vaultId = "7") {
  seqs += 1;
  return { seq: String(seqs), block_timestamp: ns(time), vault_id: vaultId, kind, data };
}

const requested = (opId: string, amount = "60000", executable = at(13, 14, 2)) =>
  event("withdrawal_requested", {
    op_id: opId,
    amount_sats: amount,
    destination: "tb1qthief",
    executable_at: ns(executable),
    utxos: [],
    envelope: "00".repeat(80),
  });

describe("get_vault", () => {
  it("reads the contract's Vault view", () => {
    const view = vault({ pending_change: CHANGE });
    expect(parseVault(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(parseVault({ ...view, addresses: null, cosigner_pubkeys: null })?.addresses).toBeNull();
  });

  it("refuses other shapes", () => {
    const view = vault();
    expect(parseVault(null)).toBeNull();
    expect(parseVault({ ...view, state: "open" })).toBeNull();
    expect(parseVault({ ...view, created_at: 7 })).toBeNull();
    expect(parseVault({ ...view, policy: { ...view.policy, delay_ns: 1 } })).toBeNull();
    expect(
      parseVault({
        ...view,
        policy: { ...view.policy, guardians: [{ ...TRUSTED, kind: "friend" }] },
      }),
    ).toBeNull();
    expect(parseVault({ ...view, pending_change: { ...CHANGE, state: "maybe" } })).toBeNull();
  });
});

describe("RPC answers", () => {
  it("tells a contract error (a missing Vault) from a node that does not answer", () => {
    expect(rpcAnswer({ result: { block_height: 1 } })).toEqual({
      kind: "ok",
      value: { block_height: 1 },
    });
    expect(
      rpcAnswer({
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "CONTRACT_EXECUTION_ERROR", info: {} },
          data: "Smart contract panicked: ERR_VAULT_NOT_FOUND",
        },
      }).kind,
    ).toBe("error");
    expect(rpcAnswer({ result: { error: "wasm execution failed: ERR_VAULT_NOT_FOUND" } })).toEqual({
      kind: "error",
      text: "wasm execution failed: ERR_VAULT_NOT_FOUND",
    });
    expect(
      rpcAnswer({ error: { name: "INTERNAL_ERROR", cause: { name: "TIMEOUT_ERROR" } } }),
    ).toEqual({ kind: "unreachable" });
    expect(rpcAnswer("nope")).toEqual({ kind: "unreachable" });
    expect(rpcAnswer({ id: 1 })).toEqual({ kind: "unreachable" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends final view calls and queries to the RPC, and treats a failed fetch as unreachable", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const value = [...new TextEncoder().encode(JSON.stringify({ ok: 1 }))];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: value } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rpc = proofRpc(
      "https://rpc.example.org",
      "vault.morrow.testnet",
      new AbortController().signal,
    );
    expect(await rpc.view("get_vault", { vault_id: "7" })).toEqual({
      kind: "ok",
      value: { ok: 1 },
    });
    await rpc.query({ request_type: "view_account", account_id: "vault.morrow.testnet" });
    expect(bodies).toEqual([
      {
        jsonrpc: "2.0",
        id: "morrow-web",
        method: "query",
        params: {
          finality: "final",
          request_type: "call_function",
          account_id: "vault.morrow.testnet",
          method_name: "get_vault",
          args_base64: btoa('{"vault_id":"7"}'),
        },
      },
      {
        jsonrpc: "2.0",
        id: "morrow-web",
        method: "query",
        params: {
          finality: "final",
          request_type: "view_account",
          account_id: "vault.morrow.testnet",
        },
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await rpc.view("get_vault", { vault_id: "7" })).toEqual({ kind: "unreachable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    expect(await rpc.query({ request_type: "view_account" })).toEqual({ kind: "unreachable" });
  });
});

describe("view_account and view_access_key_list", () => {
  it("reads the code_hash", () => {
    expect(codeHashFrom({ code_hash: FACTS.codeHash, amount: "1" })).toBe(FACTS.codeHash);
    expect(codeHashFrom({ code_hash: "not base58 0OIl" })).toBeNull();
    expect(codeHashFrom(null)).toBeNull();
  });

  const fn = { access_key: { nonce: 1, permission: { FunctionCall: { allowance: null } } } };
  const full = { access_key: { nonce: 1, permission: "FullAccess" } };

  it("counts full-access keys: none is locked", () => {
    expect(fullAccessKeysFrom({ keys: [fn] })).toBe(0);
    expect(fullAccessKeysFrom({ keys: [] })).toBe(0);
    expect(fullAccessKeysFrom({ keys: [fn, full] })).toBe(1);
    expect(fullAccessKeysFrom({ keys: [{ access_key: { permission: "Other" } }] })).toBeNull();
    expect(fullAccessKeysFrom({})).toBeNull();
  });

  it("words the lock state", () => {
    expect(copy.proof.locked).toBe("Locked: no full-access keys");
    expect(copy.proof.unlocked(1)).toBe("Unlocked: 1 full-access key");
    expect(copy.proof.unlocked(2)).toBe("Unlocked: 2 full-access keys");
  });
});

describe("the event scan", () => {
  /** A contract-global log: `before` events of Vault 42, then Vault 7's from `created`. */
  function log(before: number, mine: ProofEvent[], after = 0): ProofEvent[] {
    const all: ProofEvent[] = [];
    for (let i = 0; i < before; i++) {
      all.push({
        seq: "0",
        block_timestamp: ns(at(1, 0) + i),
        vault_id: "42",
        kind: "storage_topped_up",
        data: { amount_yocto: "1" },
      });
    }
    all.push(...mine);
    for (let i = 0; i < after; i++) {
      all.push({
        seq: "0",
        block_timestamp: ns(at(12, 8) + i),
        vault_id: "42",
        kind: "storage_topped_up",
        data: { amount_yocto: "1" },
      });
    }
    return all.map((e, i) => ({ ...e, seq: String(i + 1) }));
  }

  /** `events_since` over `all`: `seq > cursor`, at most `limit`, counting calls. */
  function pageOver(all: ProofEvent[]) {
    const calls: [bigint, number][] = [];
    const page: EventPage = async (cursor, limit) => {
      calls.push([cursor, limit]);
      return all.filter((e) => BigInt(e.seq) > cursor).slice(0, limit);
    };
    return { page, calls };
  }

  const created = BigInt(ns(at(10, 8)));

  it("finds the first seq at or after created_at by binary search", async () => {
    const mine = [event("vault_created", { owner_account: "o" }, at(10, 8))];
    for (const before of [0, 1, 2, 3, 130, 1000]) {
      const { page, calls } = pageOver(log(before, mine));
      expect(await firstCursorAtOrAfter(page, created)).toBe(BigInt(before));
      expect(calls.length).toBeLessThan(2 * Math.log2(before + 2) + 4);
      expect(calls.every(([, limit]) => limit === 1)).toBe(true);
    }
    // Past the end: nothing at or after.
    const { page } = pageOver(log(5, []));
    expect(await firstCursorAtOrAfter(page, created)).toBe(5n);
  });

  it("folds only this Vault's events, in pages of 100, and catches up on a short page", async () => {
    const mine = [event("vault_created", {}, at(10, 8)), requested("3")];
    const all = log(130, mine, 250);
    const { page, calls } = pageOver(all);
    const scan = newScan("7", ns(at(10, 8)));
    scan.cursor = 130n;
    await advanceScan(page, scan);
    expect([...scan.open.keys()]).toEqual(["3"]);
    expect(scan).toMatchObject({ caughtUp: true, read: 252, cursor: 382n });
    expect(calls.map(([cursor, limit]) => [Number(cursor), limit])).toEqual([
      [130, EVENTS_PAGE],
      [230, EVENTS_PAGE],
      [330, EVENTS_PAGE],
    ]);
  });

  it("reads at most 50 pages per refresh and resumes from the cursor, newest events last", async () => {
    // The pending request is the newest event: it must not be the one left out.
    const all = log(0, [], MAX_EVENT_PAGES * EVENTS_PAGE + 5);
    all.push({ ...requested("3"), seq: String(all.length + 1) });
    const { page } = pageOver(all);
    const scan = newScan("7", ns(at(1, 0)));
    await advanceScan(page, scan);
    expect(scan).toMatchObject({ caughtUp: false, read: MAX_EVENT_PAGES * EVENTS_PAGE });
    expect(scan.open.size).toBe(0);
    await advanceScan(page, scan);
    expect(scan).toMatchObject({ caughtUp: true, read: all.length });
    expect([...scan.open.keys()]).toEqual(["3"]);
    // Nothing new: the next refresh reads one short page and stays caught up.
    await advanceScan(page, scan);
    expect(scan).toMatchObject({ caughtUp: true, read: all.length });
  });

  it("skips other Vaults' events unread and this Vault's malformed data", async () => {
    const all = [
      {
        seq: "1",
        block_timestamp: ns(at(10, 8)),
        vault_id: "42",
        kind: "x",
        data: "not an object",
      },
      { seq: "2", block_timestamp: ns(at(10, 9)), vault_id: "7", kind: "op_signed", data: null },
      { ...requested("3"), seq: "3" },
      { seq: "4", block_timestamp: ns(at(11, 11)), vault_id: "7", kind: "op_voided", data: [3] },
    ];
    const { page } = pageOver(all);
    const scan = newScan("7", ns(at(10, 8)));
    await advanceScan(page, scan);
    expect([...scan.open.keys()]).toEqual(["3"]);
    expect(parseEvents(all)).toHaveLength(4);
  });

  it("reads events_since entries and refuses other shapes", () => {
    const e = requested("3");
    expect(parseEvents([e])).toEqual([e]);
    expect(parseEvents([{ ...e, seq: 3 }])).toBeNull();
    expect(parseEvents({})).toBeNull();
  });
});

describe("pending ops from events", () => {
  it("lists a request with no later terminal event", () => {
    const { withdrawals, clawedBack } = pendingFrom([requested("3")]);
    expect(withdrawals).toHaveLength(1);
    expect(withdrawalLine(withdrawals[0]!, "signet", NOW)).toBe(
      "Withdrawal #3 · 0.0006 sBTC · executable 13 Nov 14:02",
    );
    expect(withdrawals[0]!.destination).toBe("tb1qthief");
    expect(clawedBack).toBeNull();
  });

  it("takes executable_at from a later fast_approved", () => {
    const { withdrawals } = pendingFrom([
      requested("3"),
      event("fast_approved", { op_id: "3", by: "alice.testnet", executable_at: ns(at(12, 15)) }),
    ]);
    expect(withdrawalLine(withdrawals[0]!, "signet", NOW)).toBe(
      "Withdrawal #3 · 0.0006 sBTC · executable 15:00",
    );
  });

  it("keeps a Frozen request until it is signed", () => {
    const frozen = pendingFrom([
      requested("3"),
      event("op_frozen", { op_id: "3", kind: "withdrawal", envelope: null, fee_sats: "300" }),
    ]);
    expect(frozen.withdrawals.map((op) => [op.opId, op.frozen])).toEqual([["3", true]]);
  });

  it.each([
    ["op_voided", { op_id: "3", by_op_id: "9" }],
    ["withdrawal_cancelled", { op_id: "3", by: "owner.testnet" }],
    ["op_signed", { op_id: "3" }],
  ])("drops a request settled by %s", (kind, data) => {
    const { withdrawals } = pendingFrom([requested("3"), requested("5"), event(kind, data)]);
    expect(withdrawals.map((op) => op.opId)).toEqual(["5"]);
  });

  it("reads the Clawback from vault_clawed_back", () => {
    const { clawedBack } = pendingFrom([
      event(
        "vault_clawed_back",
        { op_id: "9", by: "watcher", recovery_address: RECOVERY },
        at(12, 3, 4),
      ),
    ]);
    expect(clawedBack).toEqual({ recoveryAddress: RECOVERY, at: ns(at(12, 3, 4)) });
    expect(copy.proof.clawedBack(RECOVERY, "03:04")).toBe(`Sent home to ${RECOVERY} · 03:04`);
  });
});

describe("display", () => {
  it("formats amounts without trailing zeros, in the Vault's unit", () => {
    expect(formatAmount("60000", "signet")).toBe("0.0006 sBTC");
    expect(formatAmount("100000000", "bitcoin")).toBe("1 BTC");
    expect(formatAmount("0", "testnet4")).toBe("0 tBTC");
    expect(formatAmount("123456789", "regtest")).toBe("1.23456789 rBTC");
  });

  it("shows every Policy row with the Vault's values", () => {
    expect(policyRows(vault().policy).map((row) => [row.label, row.value])).toEqual([
      ["Delay", "24 h"],
      ["Policy Change Delay", "7 d"],
      ["Escape Timelock", "26,280 blocks"],
      ["Recovery Address", RECOVERY],
      ["Allowance limit", "0.001 sBTC per 24 h"],
      ["Fee Cap", "0.0002 sBTC"],
      ["Fast Approval", "Off"],
      ["Watcher key", "cc".repeat(32)],
    ]);
    expect(policyRows(vault({}, { fast_approval: true }).policy)[6]!.value).toBe("On · Floor 1 h");
  });

  it("words the pending Policy Change with its absolute effective time", () => {
    expect(changeLine(CHANGE, "signet", NOW)).toBe(
      `Policy Change #4 · Recovery Address → ${NEW_RECOVERY} · effective 11 Nov 09:00`,
    );
    expect(
      changeSummary(
        {
          delay_ns: (48n * HOUR_NS).toString(),
          fast_approval: true,
          fast_approval_floor_ns: HOUR_NS.toString(),
          fee_cap_sats: "5000",
        },
        "signet",
      ),
    ).toBe(
      "Delay → 48 h · Fee Cap → 0.00005 sBTC · Fast Approval → on · Fast Approval Floor → 1 h",
    );
  });

  it("puts the deployment watcher's heartbeat in its own line, alarm after 5 min or unreachable", () => {
    expect(watcherLine({ kind: "seen", minutes: 2, stale: false })).toEqual({
      text: "Deployment watcher last seen 2 min ago",
      alarm: false,
    });
    expect(watcherLine({ kind: "seen", minutes: 7, stale: true }).alarm).toBe(true);
    expect(watcherLine({ kind: "unreachable" })).toEqual({
      text: "Deployment watcher unreachable",
      alarm: true,
    });
    expect(watcherLine({ kind: "none" }).alarm).toBe(true);
    expect(watcherLine({ kind: "checking" }).alarm).toBe(false);
  });

  it("shows the watcher line only for a Vault with an Auto-Clawback Guardian", () => {
    expect(hasWatcher(vault())).toBe(true);
    expect(hasWatcher(vault({}, { guardians: [TRUSTED] }))).toBe(false);
  });

  it("lists the watcher key in full among the Policy rows", () => {
    expect(policyRows(vault().policy).at(-1)).toEqual({
      label: "Watcher key",
      value: "cc".repeat(32),
      mono: true,
    });
  });
});

describe("statements", () => {
  const ids = (list: { id: string }[]) => list.map((s) => s.id);
  const text = (list: { id: string; text: string }[], id: string) =>
    list.find((s) => s.id === id)?.text;

  it("an active Vault with an Auto-Clawback Guardian, Fast Approval off: G-1..G-4, T-1..T-4, T-6", () => {
    const v = vault();
    const g = guarantees(v, FACTS);
    const t = trustStatements(v, FACTS);
    expect(ids(g)).toEqual(["G-1", "G-2", "G-3", "G-4"]);
    expect(ids(t)).toEqual(["T-1", "T-2", "T-3", "T-4", "T-6"]);
    expect(residualRisk(v)).toBeNull();

    expect(text(g, "G-1")).toBe(
      "A withdrawal waits 24 h. Before a coin's Escape Timelock of 26,280 blocks matures, no bitcoin leaves the Vault Address sooner than 24 h after its Withdrawal Request, except back to the Vault Address (Refresh) or to the Recovery Address (Clawback). A thief holding both the Owner Key and the Owner Account still waits 24 h. The Spending Allowance pays up to 0.001 sBTC per 24 h without the Delay.",
    );
    expect(text(g, "G-2")).toBe(
      `Until a withdrawal executes, any of the 2 Guardians (alice.testnet, watcher.morrow.testnet) can send the whole Vault to the Recovery Address. Clawback pays only ${RECOVERY}.`,
    );
    expect(text(g, "G-3")).toBe(
      "The Co-signer cannot spend alone on any path. If NEAR or the Co-signer stops, the Owner Key alone can spend each coin 26,280 blocks (about 182 d 12 h) after it confirmed, using only Bitcoin.",
    );
    expect(text(g, "G-4")).toBe(
      `No Policy field changes sooner than 7 d after it is proposed, and the Guardians and the Escape Timelock never change for this Vault. Every Guardian is alerted and can veto. A Clawback during a pending change pays the Recovery Address in effect, ${RECOVERY}.`,
    );
    expect(text(t, "T-1")).toBe(
      "The NEAR MPC network behind the configured signer v1.signer-prod.testnet signs only what vault.morrow.testnet requests, and stays live. If it stops, G-3 still holds through the Escape Path, and G-1 and G-2 pause until it recovers.",
    );
    expect(text(t, "T-2")).toBe(
      `The code deployed at vault.morrow.testnet is correct. It is open source, and its code_hash ${FACTS.codeHash} is read from NEAR: build contracts/vault from the public repository and compare.`,
    );
    expect(t.find((s) => s.id === "T-2")?.link).toEqual({
      href: "https://github.com/CemAyyildiz/morrow",
      text: "Source: github.com/CemAyyildiz/morrow",
    });
    expect(text(t, "T-3")).toBe(
      "A Guardian and the NEAR MPC network do not collude. If one of the 2 Guardians (alice.testnet, watcher.morrow.testnet) and the network behind the configured signer v1.signer-prod.testnet do, they can sign a Clawback Path spend to any address, because Bitcoin script cannot restrict destinations. This is the one theft path.",
    );
    expect(text(t, "T-4")).toBe(`The Owner keeps the private key of ${RECOVERY} safe and offline.`);
    expect(text(t, "T-6")).toBe(
      `The Guardian Watcher holding the key of watcher.morrow.testnet stays live and uncompromised. If it is down, alerts and duress Clawbacks stop, but G-1 still holds and human Guardians can still claw back; the Deployment watcher line on this page shows when it was last seen. If it is compromised, it can claw back to ${RECOVERY} only: theft also needs the MPC network (T-3).`,
    );
  });

  it("T-1 names the configured Co-signer and makes no threshold claim", () => {
    const t1 = text(trustStatements(vault(), { ...FACTS, coSigner: "v1.signer" }), "T-1");
    expect(t1).toContain("the configured signer v1.signer ");
    expect(t1).not.toMatch(/\d+ of \d+|threshold/);
  });

  it("without an Auto-Clawback Guardian: no T-6, and the plain residual-risk sentence", () => {
    const v = vault({}, { guardians: [TRUSTED] });
    expect(ids(trustStatements(v, FACTS))).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    expect(residualRisk(v)).toBe(
      "This Vault has no Auto-Clawback Guardian, so a Recovery Address change is stopped only by a Guardian veto within 7 d.",
    );
  });

  it("with Fast Approval on: T-5 with the Floor, and G-1 says so", () => {
    const v = vault({}, { fast_approval: true });
    const t = trustStatements(v, FACTS);
    expect(ids(t)).toEqual(["T-1", "T-2", "T-3", "T-4", "T-5", "T-6"]);
    expect(text(t, "T-5")).toBe(
      "Fast Approval is on. A Trusted Contact (alice.testnet) does not collude with, or get fooled by, a thief who holds the Owner Key and the Owner Account. If one does, the theft completes after the Fast Approval Floor of 1 h instead of 24 h.",
    );
    expect(text(guarantees(v, FACTS), "G-1")).toContain(
      "Fast Approval is on: a Trusted Contact can shorten the wait to the Fast Approval Floor of 1 h.",
    );
  });

  it("with Fast Approval on and no Trusted Contact, T-5 says it cannot be used", () => {
    const v = vault({}, { fast_approval: true, guardians: [WATCHER] });
    expect(text(trustStatements(v, FACTS), "T-5")).toBe(
      "Fast Approval is on, but this Vault has no Trusted Contact, so it cannot be used.",
    );
    expect(text(guarantees(v, FACTS), "G-1")).not.toContain("Fast Approval");
  });

  it("a clawed-back Vault gets the closed-Vault statement, not G-1..G-4", () => {
    const v = vault({ state: "clawed_back" });
    const clawedBack = { recoveryAddress: RECOVERY, at: ns(at(12, 3, 4)) };
    expect(guarantees(v, { ...FACTS, clawedBack })).toEqual([
      {
        id: "Closed",
        title: "Sent home",
        text: `This Vault was sent home to ${RECOVERY} at 03:04; no other spend can be co-signed.`,
      },
    ]);
    expect(text(guarantees(v, FACTS), "Closed")).toBe(
      `This Vault was sent home to ${RECOVERY}; no other spend can be co-signed.`,
    );
    expect(stateNotice(v)).toBeNull();
  });

  it("a Vault whose keys are still being derived has no guarantees, only a notice", () => {
    const v = vault({ state: "pending_keys", addresses: null, cosigner_pubkeys: null });
    expect(guarantees(v, FACTS)).toEqual([]);
    expect(stateNotice(v)).toBe(
      "This Vault is not active yet: its Co-signer keys are still being derived, so it holds nothing and no guarantee applies to it yet.",
    );
    expect(stateNotice(vault())).toBeNull();
  });

  it("follows the Vault's values: a changed field changes the sentence", () => {
    const v = vault(
      {},
      {
        delay_ns: (48n * HOUR_NS).toString(),
        allowance_limit_sats: "0",
        escape_timelock_blocks: 1000,
        guardians: [WATCHER],
      },
    );
    const g = guarantees(v, FACTS);
    expect(text(g, "G-1")).toMatch(
      /^A withdrawal waits 48 h\. Before a coin's Escape Timelock of 1,000 blocks/,
    );
    expect(text(g, "G-1")).toContain(
      "The Spending Allowance is 0, so every spend waits the Delay.",
    );
    expect(text(g, "G-2")).toContain("any of the 1 Guardian (watcher.morrow.testnet)");
    expect(text(g, "G-3")).toContain("1,000 blocks (about 6 d 22 h)");
  });

  it("states the earliest pending executable_at and the pending change's effective time", () => {
    const { withdrawals } = pendingFrom([
      requested("3", "60000", at(13, 14, 2)),
      requested("5", "1000", at(13, 9, 30)),
    ]);
    const g = guarantees(vault({ pending_change: CHANGE }), { ...FACTS, withdrawals });
    expect(text(g, "G-1")).toMatch(/No pending withdrawal can be signed before 13 Nov 09:30\.$/);
    expect(text(g, "G-4")).toMatch(/Policy Change #4 cannot take effect before 11 Nov 09:00\.$/);
  });

  it("counts only future times of Pending ops; a passed one is executable now", () => {
    const { withdrawals } = pendingFrom([
      requested("3", "60000", at(13, 14, 2)),
      requested("5", "1000", at(12, 8)),
      requested("6", "1000", at(12, 7)),
      event("op_frozen", { op_id: "6", kind: "withdrawal", envelope: null, fee_sats: "1" }),
    ]);
    const g1 = guarantees(vault(), { ...FACTS, withdrawals }).find((s) => s.id === "G-1");
    expect(g1?.alert).toBe("Withdrawal #5 is executable now.");
    expect(g1?.text).not.toContain("can be signed before");
    expect(isDue(withdrawals[1]!, NOW)).toBe(true);
    // A Frozen op is being co-signed: not counted either way.
    expect(isDue(withdrawals[2]!, NOW)).toBe(false);
    const future = guarantees(vault(), {
      ...FACTS,
      withdrawals: [withdrawals[0]!, withdrawals[2]!],
    });
    expect(text(future, "G-1")).toMatch(/signed before 13 Nov 14:02\.$/);
  });

  it("claims nothing about pending requests while the history is still being read", () => {
    const { withdrawals } = pendingFrom([requested("5", "1000", at(12, 8)), requested("3")]);
    const g1 = guarantees(vault(), { ...FACTS, withdrawals, caughtUp: false })[0]!;
    expect(g1.alert).toBeUndefined();
    expect(g1.text).not.toContain("can be signed before");
    expect(copy.proof.reading(5000)).toBe("Reading the history · 5,000 events read");
  });

  it("always states T-3, and T-2 without a readable code_hash", () => {
    for (const guardians of [[TRUSTED], [WATCHER], [TRUSTED, WATCHER]]) {
      expect(ids(trustStatements(vault({}, { guardians }), FACTS))).toContain("T-3");
    }
    expect(text(trustStatements(vault(), { ...FACTS, codeHash: null }), "T-2")).toBe(
      "The code deployed at vault.morrow.testnet is correct. It is open source, but its code_hash could not be read on this refresh to compare with a build of contracts/vault.",
    );
  });
});

describe("one refresh", () => {
  /** A fake contract over `events`, answering `get_vault` with `view` (or the error). */
  function fakeRpc(
    view: Vault | "missing" | "down" | "other-error" | "no-account",
    events: ProofEvent[],
    keys: unknown[] = [{ access_key: { permission: { FunctionCall: {} } } }],
  ) {
    const calls: string[] = [];
    const rpc: ProofRpc = {
      async query(params): Promise<RpcAnswer<Record<string, unknown>>> {
        calls.push(String(params.request_type));
        if (view === "down") return { kind: "unreachable" };
        if (view === "no-account") return { kind: "error", text: "UNKNOWN_ACCOUNT" };
        if (params.request_type === "view_account") {
          return { kind: "ok", value: { code_hash: FACTS.codeHash } };
        }
        return { kind: "ok", value: { keys } };
      },
      async view(method, args): Promise<RpcAnswer<unknown>> {
        calls.push(method);
        if (view === "down") return { kind: "unreachable" };
        if (method === "get_vault") {
          if (view === "missing") {
            return { kind: "error", text: "Smart contract panicked: ERR_VAULT_NOT_FOUND" };
          }
          if (view === "other-error") {
            return { kind: "error", text: "MethodNotFound: get_vault" };
          }
          if (view === "no-account")
            return { kind: "error", text: '{"cause":{"name":"UNKNOWN_ACCOUNT"}}' };
          return { kind: "ok", value: JSON.parse(JSON.stringify(view)) };
        }
        const cursor = BigInt(String(args.cursor));
        return {
          kind: "ok",
          value: events.filter((e) => BigInt(e.seq) > cursor).slice(0, Number(args.limit)),
        };
      },
    };
    return { rpc, calls };
  }

  const history = () => {
    seqs = 0;
    return [
      event("vault_created", {}, at(1, 0), "42"),
      event("vault_created", {}, at(10, 8)),
      requested("3"),
      requested("2"),
      event(
        "withdrawal_requested",
        { op_id: "8", amount_sats: "1", executable_at: "1" },
        at(11, 11),
        "42",
      ),
      event("op_voided", { op_id: "2", by_op_id: "9" }),
    ];
  };

  it("reads the Vault, its pending ops, the code_hash and the lock", async () => {
    const { rpc } = fakeRpc(vault({ pending_change: CHANGE }), history());
    const answer = await readProof(rpc, "vault.morrow.testnet", "7");
    expect(answer.kind).toBe("ok");
    if (answer.kind !== "ok") return;
    expect(answer.facts.withdrawals.map((op) => op.opId)).toEqual(["3"]);
    expect(answer.facts.codeHash).toBe(FACTS.codeHash);
    expect(answer.facts.fullAccessKeys).toBe(0);
    expect(answer.facts.history).toEqual({ caughtUp: true, read: 5 });
    expect(answer.facts.vault.pending_change?.change_id).toBe("4");
  });

  it("counts an unlocked contract's full-access keys", async () => {
    const { rpc } = fakeRpc(vault(), history(), [{ access_key: { permission: "FullAccess" } }]);
    const answer = await readProof(rpc, "vault.morrow.testnet", "7");
    expect(answer.kind === "ok" && answer.facts.fullAccessKeys).toBe(1);
  });

  it("reads on from the kept cursor: the binary search runs once per Vault", async () => {
    const { rpc, calls } = fakeRpc(vault(), history());
    const holder = { current: null };
    await readProof(rpc, "vault.morrow.testnet", "7", holder);
    const first = calls.filter((c) => c === "events_since").length;
    calls.length = 0;
    await readProof(rpc, "vault.morrow.testnet", "7", holder);
    expect(calls.filter((c) => c === "events_since")).toHaveLength(1);
    expect(first).toBeGreaterThan(1);
    expect(holder).toMatchObject({ current: { vaultId: "7", cursor: 6n, caughtUp: true } });
    // Another Vault starts its own scan.
    const other = fakeRpc(vault({ vault_id: "8" }), history());
    const answer = await readProof(other.rpc, "vault.morrow.testnet", "8", holder);
    expect(answer.kind === "ok" && answer.facts.withdrawals).toEqual([]);
    expect(holder).toMatchObject({ current: { vaultId: "8" } });
  });

  it("over more than 5,000 events: reading on each refresh until caught up", async () => {
    seqs = 0;
    const events: ProofEvent[] = [event("vault_created", {}, at(10, 8))];
    for (let i = 0; i < 2 * MAX_EVENT_PAGES * EVENTS_PAGE + 50; i++) {
      events.push({ ...event("storage_topped_up", { amount_yocto: "1" }, at(10, 9), "42") });
    }
    events.push(requested("3"));
    const { rpc } = fakeRpc(vault(), events);
    const holder = { current: null };
    const read = async () => {
      const answer = await readProof(rpc, "vault.morrow.testnet", "7", holder);
      if (answer.kind !== "ok") throw new Error(answer.kind);
      return answer.facts;
    };
    const first = await read();
    expect(first.history).toEqual({ caughtUp: false, read: 5000 });
    expect(first.withdrawals).toEqual([]);
    expect((await read()).history).toEqual({ caughtUp: false, read: 10_000 });
    const third = await read();
    expect(third.history).toEqual({ caughtUp: true, read: events.length });
    expect(third.withdrawals.map((op) => op.opId)).toEqual(["3"]);
  });

  it("a failed refresh keeps the scan as it was: no page is folded twice", async () => {
    const { rpc } = fakeRpc(vault(), history());
    const holder: { current: Scan | null } = { current: null };
    await readProof(rpc, "vault.morrow.testnet", "7", holder);
    const kept = holder.current;
    const down: ProofRpc = { ...rpc, query: async () => ({ kind: "unreachable" }) };
    expect(await readProof(down, "vault.morrow.testnet", "7", holder)).toEqual({
      kind: "unreachable",
    });
    expect(holder.current).toBe(kept);
  });

  it("a contract that is not a Vault Contract is misconfigured, not a missing Vault", async () => {
    for (const view of ["other-error", "no-account"] as const) {
      expect(await readProof(fakeRpc(view, []).rpc, "c", "7")).toEqual({ kind: "misconfigured" });
    }
    const odd = fakeRpc(vault(), history());
    const notAVault: ProofRpc = {
      ...odd.rpc,
      view: async (method, args) =>
        method === "get_vault" ? { kind: "ok", value: { hello: 1 } } : odd.rpc.view(method, args),
    };
    expect(await readProof(notAVault, "c", "7")).toEqual({ kind: "misconfigured" });
    const noEvents: ProofRpc = {
      ...odd.rpc,
      view: async (method, args) =>
        method === "events_since"
          ? { kind: "error", text: "MethodNotFound" }
          : odd.rpc.view(method, args),
    };
    expect(await readProof(noEvents, "c", "7")).toEqual({ kind: "misconfigured" });
    expect(copy.proof.misconfigured("c.testnet")).toBe(
      "The contract c.testnet did not answer as a Vault Contract",
    );
  });

  it("reads a malformed access key list as lock status unknown", async () => {
    const { rpc } = fakeRpc(vault(), history(), [{ access_key: { permission: "Odd" } }]);
    const answer = await readProof(rpc, "vault.morrow.testnet", "7");
    expect(answer.kind === "ok" && answer.facts.fullAccessKeys).toBeNull();
    expect(copy.proof.lockUnknown).toBe("Lock status could not be read");
  });

  it("an unknown Vault is missing, with its error code verbatim", async () => {
    const { rpc } = fakeRpc("missing", []);
    expect(await readProof(rpc, "vault.morrow.testnet", "999")).toEqual({
      kind: "missing",
      code: "ERR_VAULT_NOT_FOUND",
    });
    expect(copy.proof.missing("999", "vault.morrow.testnet")).toBe(
      "No Vault #999 on vault.morrow.testnet",
    );
  });

  it("an RPC that does not answer is unreachable, mid-scan too", async () => {
    expect(await readProof(fakeRpc("down", []).rpc, "c", "7")).toEqual({ kind: "unreachable" });
    const { rpc } = fakeRpc(vault(), history());
    const flaky: ProofRpc = {
      query: rpc.query,
      view: async (method, args) =>
        method === "events_since" ? { kind: "unreachable" } : rpc.view(method, args),
    };
    expect(await readProof(flaky, "c", "7")).toEqual({ kind: "unreachable" });
  });

  it("keeps the last data after any failure, marked stale with its read time", () => {
    const facts = { vault: vault() } as ProofFacts;
    const ok = heldAfter(null, "7", { kind: "ok", facts }, NOW);
    expect(ok.state).toEqual({ kind: "ok", facts, readAt: NOW, now: NOW, stale: null });
    expect(heldAfter(ok, "7", { kind: "unreachable" }, NOW + 1).state).toEqual({
      kind: "ok",
      facts,
      readAt: NOW,
      now: NOW + 1,
      stale: "unreachable",
    });
    for (const answer of [
      { kind: "missing", code: "ERR_VAULT_NOT_FOUND" },
      { kind: "misconfigured" },
    ] as const) {
      expect(heldAfter(ok, "7", answer, NOW + 1).state).toMatchObject({
        kind: "ok",
        stale: answer.kind,
      });
    }
    expect(copy.proof.stale.unreachable("09:30")).toContain("last read 09:30");
    expect(heldAfter(null, "7", { kind: "unreachable" }, NOW).state).toEqual({
      kind: "unreachable",
    });
    expect(heldAfter(null, "7", { kind: "misconfigured" }, NOW).state).toEqual({
      kind: "misconfigured",
    });
    // Another Vault's data is never kept for this one.
    expect(heldAfter(ok, "8", { kind: "unreachable" }, NOW).state).toEqual({ kind: "unreachable" });
  });
});

describe("routes", () => {
  it("resolves /proof/<digits> to the Proof item with the Vault id", () => {
    const resolved = resolveRoute("/proof/7");
    expect(resolved.kind === "nav" && [resolved.route.id, resolved.vaultId]).toEqual([
      "proof",
      "7",
    ]);
    // A padded id is rewritten to the canonical address.
    expect(resolveRoute("/proof/007/")).toEqual({ kind: "redirect", to: "/proof/7" });
    const bare = resolveRoute("/proof");
    expect(bare.kind === "nav" && [bare.route.id, bare.vaultId]).toEqual(["proof", undefined]);
  });

  it.each(["/proof/abc", "/proof/7/extra", "/proof/-1", "/proof/99999999999999999999"])(
    "%s is not found",
    (path) => expect(resolveRoute(path).kind).toBe("not-found"),
  );

  it("takes only u64 ids", () => {
    expect(canonicalVaultId("18446744073709551615")).toBe("18446744073709551615");
    expect(canonicalVaultId("18446744073709551616")).toBeNull();
    expect(canonicalVaultId("7a")).toBeNull();
    expect(canonicalVaultId("")).toBeNull();
  });
});

describe("the address recompute", () => {
  // contracts/vault/src/core/script.rs `builds_the_three_guardian_script_byte_for_byte`: the
  // script and its signet address, computed independently with bitcoinjs-lib.
  const OWNER = `02${"11".repeat(32)}`;
  const COSIGNER = `03${"aa".repeat(32)}`;
  const ALLOWANCE_COSIGNER = `03${"ee".repeat(32)}`;
  const GUARDIAN_KEYS = [`02${"22".repeat(32)}`, `02${"33".repeat(32)}`, `02${"44".repeat(32)}`];
  const SCRIPT =
    "6321021111111111111111111111111111111111111111111111111111111111111111ad2103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac67632103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad5121022222222222222222222222222222222222222222222222222222222222222222210233333333333333333333333333333333333333333333333333333333333333332102444444444444444444444444444444444444444444444444444444444444444453ae6702a866b27521021111111111111111111111111111111111111111111111111111111111111111ac6868";
  const ADDRESS = "tb1qjzz9rvff0n247nl76zcwwylrjkej02l4pa8l5he6zzyn9kagp3aq2u9zku";
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const ALLOWANCE_SCRIPT = hex(
    vaultScriptTemplate(OWNER, ALLOWANCE_COSIGNER, GUARDIAN_KEYS, 26_280).script,
  );
  const ALLOWANCE_ADDRESS = p2wshAddress(
    vaultScriptTemplate(OWNER, ALLOWANCE_COSIGNER, GUARDIAN_KEYS, 26_280).script,
    "signet",
  );
  const accounts = ["alice.testnet", "bob.testnet", "watcher.morrow.testnet"];
  const VAULT = vault(
    {
      owner_key: OWNER,
      cosigner_pubkeys: { vault: COSIGNER, allowance: ALLOWANCE_COSIGNER },
      addresses: { vault: ADDRESS, allowance: ALLOWANCE_ADDRESS },
    },
    {
      guardians: GUARDIAN_KEYS.map((guardian_key, i) => ({
        guardian_key,
        guardian_account: accounts[i]!,
        kind: i === 2 ? "auto_clawback" : "trusted_contact",
      })),
    },
  );
  const KIT: ProofKit = {
    kit_version: 1,
    btc_network: "signet",
    vault_script_hex: SCRIPT,
    allowance_script_hex: ALLOWANCE_SCRIPT,
    addresses: { vault: ADDRESS, allowance: ALLOWANCE_ADDRESS },
    escape_timelock_blocks: 26_280,
    cosigner_pubkeys: { vault: COSIGNER, allowance: ALLOWANCE_COSIGNER },
  };
  const R = copy.proof.recompute;

  it("reads the get_vault_kit view and refuses other shapes", () => {
    const view = { ...KIT, witness_templates: [{ path: "withdrawal", slots: [] }] };
    expect(parseKit(view)).toEqual(KIT);
    for (const bad of [
      null,
      { ...view, kit_version: 2 },
      { ...view, btc_network: "litecoin" },
      { ...view, vault_script_hex: "abc" },
      { ...view, allowance_script_hex: "" },
      { ...view, vault_script_hex: "ZZ" },
      { ...view, escape_timelock_blocks: "26280" },
      { ...view, addresses: null },
      { ...view, cosigner_pubkeys: { vault: "xyz", allowance: COSIGNER } },
    ]) {
      expect(parseKit(bad)).toBeNull();
    }
  });

  it("reads get_vault_kit once over the RPC; any failure is one failed answer", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const rpc = (answer: RpcAnswer<unknown>): ProofRpc => ({
      query: async () => ({ kind: "unreachable" }),
      view: async (method, args) => {
        calls.push([method, args]);
        return answer;
      },
    });
    expect(await readKit(rpc({ kind: "ok", value: KIT }), "7")).toEqual({ kind: "ok", kit: KIT });
    expect(calls).toEqual([["get_vault_kit", { vault_id: "7" }]]);
    for (const answer of [
      { kind: "unreachable" },
      { kind: "error", text: "Smart contract panicked: ERR_VAULT_NOT_ACTIVE" },
      { kind: "ok", value: { kit_version: 1 } },
    ] as RpcAnswer<unknown>[]) {
      expect(await readKit(rpc(answer), "7")).toEqual({ kind: "failed" });
    }
  });

  it("recomputes the funded Vault Address and finds the script the template", () => {
    const result = recompute(KIT, VAULT)!;
    expect(result.address).toBe(ADDRESS);
    expect(result.funded).toBe(ADDRESS);
    expect(result.addressMatch).toBe(true);
    expect(result.scriptCheck).toEqual({ ok: true });
    expect(hex(result.bytes)).toBe(SCRIPT);
    expect(result.rows.some((row) => row.differs || row.flipped)).toBe(false);
  });

  it("decodes one row per element with its offset, role and path", () => {
    const rows = recompute(KIT, VAULT)!.rows;
    expect(rows).toHaveLength(23);
    expect(rows.map((row) => [row.offset, row.name, row.role, row.path, row.branch])).toEqual([
      [0, "OP_IF", null, "withdrawal", "IF"],
      [1, "OP_PUSHBYTES_33", "Owner key", "withdrawal", null],
      [35, "OP_CHECKSIGVERIFY", null, "withdrawal", null],
      [36, "OP_PUSHBYTES_33", "Co-signer key", "withdrawal", null],
      [70, "OP_CHECKSIG", null, "withdrawal", null],
      [71, "OP_ELSE", null, "clawback", "ELSE IF"],
      [72, "OP_IF", null, "clawback", "ELSE IF"],
      [73, "OP_PUSHBYTES_33", "Co-signer key", "clawback", null],
      [107, "OP_CHECKSIGVERIFY", null, "clawback", null],
      [108, "OP_1", "1 Guardian signature needed", "clawback", null],
      [109, "OP_PUSHBYTES_33", "Guardian key 1 · alice.testnet", "clawback", null],
      [143, "OP_PUSHBYTES_33", "Guardian key 2 · bob.testnet", "clawback", null],
      [177, "OP_PUSHBYTES_33", "Guardian key 3 · watcher.morrow.testnet", "clawback", null],
      [211, "OP_3", "3 Guardian keys in all", "clawback", null],
      [212, "OP_CHECKMULTISIG", null, "clawback", null],
      [213, "OP_ELSE", null, "escape", "ELSE"],
      [214, "OP_PUSHBYTES_2", "Escape Timelock · 26,280 blocks", "escape", null],
      [217, "OP_CHECKSEQUENCEVERIFY", null, "escape", null],
      [218, "OP_DROP", null, "escape", null],
      [219, "OP_PUSHBYTES_33", "Owner key", "escape", null],
      [253, "OP_CHECKSIG", null, "escape", null],
      [254, "OP_ENDIF", null, null, "ENDIF"],
      [255, "OP_ENDIF", null, null, "ENDIF"],
    ]);
    // Keys in full, numbers decoded.
    expect(rows[1]!.data).toBe(OWNER);
    expect(rows[16]!.data).toBe("a866");
    expect([rows[9]!.number, rows[13]!.number, rows[16]!.number]).toEqual([1, 3, 26_280]);
    expect(rows[2]!.data).toBeNull();
  });

  it("Flip a byte: the Owner key's last byte XOR 0x01, both checks red, the row marked", () => {
    const clean = recompute(KIT, VAULT)!;
    expect(clean.flipTarget).toBe(34);
    const result = recompute(KIT, VAULT, [clean.flipTarget])!;
    expect(result.bytes[34]).toBe(0x11 ^ 0x01);
    expect(result.address).not.toBe(ADDRESS);
    expect(result.address).toBe(p2wshAddress(result.bytes, "signet"));
    expect(result.addressMatch).toBe(false);
    expect(result.scriptCheck).toEqual({ ok: false, element: "Owner key differs", at: 1 });
    const marked = result.rows.filter((row) => row.flipped);
    expect(marked.map((row) => [row.offset, row.role, row.differs])).toEqual([
      [1, "Owner key", true],
    ]);
    expect(result.rows.filter((row) => row.differs)).toHaveLength(1);
    // Reset: no flips, green again.
    expect(recompute(KIT, VAULT, [])!.addressMatch).toBe(true);
  });

  it("a clicked byte (40, in the Co-signer key) is flipped and recomputed", () => {
    const result = recompute(KIT, VAULT, [40])!;
    expect(result.bytes[40]).toBe(0xaa ^ 0x01);
    expect(result.addressMatch).toBe(false);
    expect(result.scriptCheck).toEqual({ ok: false, element: "Co-signer key differs", at: 36 });
    // The flipped bytes are a set; offsets outside the script are ignored.
    expect(recompute(KIT, VAULT, [40, 40])!.flipped).toEqual([40]);
    expect(recompute(KIT, VAULT, [-1, 999])!.flipped).toEqual([]);
  });

  it("a flipped push length shifts the bytes: labels stop where they no longer line up", () => {
    const result = recompute(KIT, VAULT, [1])!; // 0x21 → 0x20
    expect(result.addressMatch).toBe(false);
    expect(result.scriptCheck.ok).toBe(false);
    expect(result.rows[1]!.name).toBe("OP_PUSHBYTES_32");
    expect(result.rows[2]!.role).toBeNull();
  });

  it("a tampered kit: another Owner key in the script fails the script check by name", () => {
    const other = vaultScriptTemplate(`03${"99".repeat(32)}`, COSIGNER, GUARDIAN_KEYS, 26_280);
    const tampered = { ...KIT, vault_script_hex: hex(other.script) };
    const result = recompute(tampered, VAULT)!;
    expect(result.scriptCheck).toEqual({ ok: false, element: "Owner key differs", at: 1 });
    // The address is checked against get_vault's: it does not match either.
    expect(result.addressMatch).toBe(false);
    // A kit whose address matches its own tampered script still fails the address check
    // against get_vault, and the script check names the element.
    const wrongGuardians = vault(
      { ...VAULT, addresses: { vault: p2wshAddress(other.script, "signet"), allowance: "x" } },
      { guardians: VAULT.policy.guardians },
    );
    const funded = recompute(tampered, wrongGuardians)!;
    expect(funded.addressMatch).toBe(true);
    expect(funded.scriptCheck.ok).toBe(false);
  });

  it("names a different timelock, a reordered Guardian list and a missing element", () => {
    const later = vaultScriptTemplate(OWNER, COSIGNER, GUARDIAN_KEYS, 4_320);
    expect(recompute({ ...KIT, vault_script_hex: hex(later.script) }, VAULT)!.scriptCheck).toEqual({
      ok: false,
      element: "Escape Timelock · 26,280 blocks differs",
      at: 214,
    });
    const swapped = vaultScriptTemplate(OWNER, COSIGNER, [...GUARDIAN_KEYS].reverse(), 26_280);
    expect(
      recompute({ ...KIT, vault_script_hex: hex(swapped.script) }, VAULT)!.scriptCheck,
    ).toEqual({ ok: false, element: "Guardian key 1 · alice.testnet differs", at: 109 });
    const short = { ...KIT, vault_script_hex: SCRIPT.slice(0, -2) };
    expect(recompute(short, VAULT)!.scriptCheck).toEqual({
      ok: false,
      element: "OP_ENDIF is missing",
      at: 255,
    });
    const long = { ...KIT, vault_script_hex: `${SCRIPT}ac` };
    expect(recompute(long, VAULT)!.scriptCheck).toEqual({
      ok: false,
      element: "OP_CHECKSIG is more than the template has",
      at: 256,
    });
    const badKey = vault({ ...VAULT, owner_key: "abc" }, VAULT.policy);
    expect(recompute(KIT, badKey)!.scriptCheck).toEqual({
      ok: false,
      element: R.unreadableKeys,
      at: null,
    });
  });

  it("recomputes the Allowance Address with the allowance Co-signer key", () => {
    const result = recompute(KIT, VAULT, [], "allowance")!;
    expect(result.address).toBe(ALLOWANCE_ADDRESS);
    expect(result.funded).toBe(ALLOWANCE_ADDRESS);
    expect(result.addressMatch).toBe(true);
    expect(result.scriptCheck).toEqual({ ok: true });
    expect(result.rows[3]!.data).toBe(ALLOWANCE_COSIGNER);
    // The vault script checked as the allowance one: the Co-signer key differs.
    const swapped = recompute({ ...KIT, allowance_script_hex: SCRIPT }, VAULT, [], "allowance")!;
    expect(swapped.scriptCheck).toEqual({ ok: false, element: "Co-signer key differs", at: 36 });
    expect(swapped.addressMatch).toBe(false);
  });

  it.each([
    ["signet", "tb1q"],
    ["testnet4", "tb1q"],
    ["regtest", "bcrt1q"],
    ["bitcoin", "bc1q"],
  ] as const)("encodes the %s address with its HRP", (network, prefix) => {
    const result = recompute({ ...KIT, btc_network: network }, VAULT)!;
    expect(result.address.startsWith(prefix)).toBe(true);
    expect(result.address).toBe(p2wshAddress(result.bytes, network));
  });

  it("claims nothing without an address to check against", () => {
    expect(recompute(KIT, vault({ addresses: null }))).toBeNull();
  });

  it("words the live-region line of a recompute, a flip and a reset", () => {
    const clean = recompute(KIT, VAULT)!;
    expect(recomputeAnnouncement(clean, { kind: "recompute" })).toBe(
      "Vault Address recomputed: the recomputed address matches the funded Vault Address. Script check: the script encodes the keys and timelock get_vault states.",
    );
    const flipped = recompute(KIT, VAULT, [34])!;
    expect(recomputeAnnouncement(flipped, { kind: "flip", at: 34 })).toBe(
      "Byte 34 flipped: the recomputed address does not match the funded Vault Address. Script check: Owner key differs.",
    );
    expect(recomputeAnnouncement(clean, { kind: "reset" })).toMatch(/^Reset to the published/);
    const allowance = recompute(KIT, VAULT, [], "allowance")!;
    expect(recomputeAnnouncement(allowance, { kind: "recompute" })).toMatch(
      /^Allowance Address recomputed: .* funded Allowance Address/,
    );
  });
});
