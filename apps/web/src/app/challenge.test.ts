import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absoluteTime,
  attemptRows,
  challengeData,
  confirmedOutpoints,
  coreBtcNetwork,
  fetchAttempts,
  fetchRound,
  fetchTipHeight,
  fetchVaultUtxos,
  formatBtc,
  formatDuration,
  hourly,
  keysFile,
  neededVaults,
  parseAttempts,
  parseRound,
  signerFrom,
  utxoSats,
  vaultFacts,
  viewResult,
  type AttemptsFeed,
  type FeedEntry,
  type FeedInputs,
  type RowContext,
} from "./challenge";
import type { ChallengeKeys } from "./data";
import { poll } from "./live";

/** Local wall-clock times, so the tests hold in any time zone. */
const NOW = new Date(2026, 10, 3, 9, 30).getTime();
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).getTime();
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const ROUND: ChallengeKeys = {
  round: 7,
  vault_contract: "vault.morrow.testnet",
  near_network: "testnet",
  btc_network: "signet",
  vault_id: "42",
  owner_account: "r7.challenge.testnet",
  owner_key: `02${"11".repeat(32)}`,
  owner_key_secret: "22".repeat(32),
  near_function_call_key: "ed25519:secret",
  vault_address: "tb1qvault",
  escape_timelock_blocks: 1000,
  funding_txid: "aa".repeat(32),
  funding_height: 290_944,
  rotation_deadline_height: 291_744,
};

const clawedBack: FeedEntry = {
  type: "withdrawal",
  round: 7,
  n: 1,
  seq: "10",
  vault_id: "42",
  op_id: "5",
  amount_sats: "50000",
  requested_at: ns(at(3, 8, 0, 0)),
  executable_at: ns(at(4, 8)),
  outcome: "clawed_back",
  outcome_at: ns(at(3, 8, 0, 41)),
  clawback_txid: "bb".repeat(32),
  clawback_broadcast: true,
  tx_hash: "REQHASH",
};

const pending: FeedEntry = {
  ...clawedBack,
  n: 3,
  seq: "14",
  op_id: "7",
  requested_at: ns(at(3, 6, 12)),
  executable_at: ns(at(4, 6, 12)),
  outcome: "pending",
  outcome_at: null,
  clawback_txid: null,
  clawback_broadcast: false,
  tx_hash: null,
};

const early: FeedEntry = {
  type: "rejected",
  round: 7,
  n: 2,
  tx_hash: "EARLYHASH",
  block_timestamp: ns(at(3, 8, 5)),
  method: "begin_execute",
  code: "ERR_NOT_EXECUTABLE",
  failure: "ActionError.FunctionCallError.ExecutionError",
};

const ctx: RowContext = {
  round: 7,
  now: NOW,
  network: { btc: "signet", near: "testnet" },
  ownerOf: (vaultId) => (vaultId === "42" ? "r7.challenge.testnet" : null),
  fresh: new Set(),
};

const feed = (
  entries: FeedEntry[],
  summary: Partial<AttemptsFeed["summary"]> = {},
): AttemptsFeed => ({
  entries,
  summary: {
    round: 7,
    attempts_round: entries.length,
    attempts_total: entries.length + 10,
    sats_taken_total: 0,
    last_attempt_at: new Date(at(3, 8, 5)).toISOString(),
    ...summary,
  },
});

const inputs = (overrides: Partial<FeedInputs> = {}): FeedInputs => ({
  round: ROUND,
  attempts: feed([early, clawedBack]),
  fresh: new Set(),
  balanceSats: 1_000_000,
  tip: 291_600,
  vaults: {
    "42": { delayNs: ns(24 * 3_600_000), ownerAccount: "r7.challenge.testnet", watcherPk: null },
  },
  coSigner: { threshold: 11, total: 16 },
  ...overrides,
});

const config = { network: { btc: "signet", near: "testnet" } as const, bountyUrl: null };

describe("parseRound", () => {
  it("keeps exactly the published round fields", () => {
    expect(
      parseRound({ ...ROUND, owner_account_full_access_key: "ed25519:operator", extra: 1 }),
    ).toEqual(ROUND);
  });

  it.each([
    null,
    { ...ROUND, round: 0 },
    { ...ROUND, owner_key: "" },
    { ...ROUND, vault_id: 42 },
    { ...ROUND, rotation_deadline_height: "291744" },
  ])("rejects %j", (body) => {
    expect(parseRound(body)).toBeNull();
  });
});

describe("parseAttempts", () => {
  it("keeps attempts, drops key rotations and unreadable entries", () => {
    const body = {
      entries: [
        early,
        { type: "key_rotated", round: 7, time: "x", reason: "allowance_low" },
        { ...clawedBack, n: "1" },
        clawedBack,
      ],
      summary: feed([]).summary,
    };
    expect(parseAttempts(body)?.entries).toEqual([early, clawedBack]);
  });

  it("needs a summary", () => {
    expect(parseAttempts({ entries: [] })).toBeNull();
    expect(
      parseAttempts({ entries: [], summary: { ...feed([]).summary, attempts_total: -1 } }),
    ).toBeNull();
  });
});

describe("display", () => {
  it("times are HH:MM today and carry the date otherwise", () => {
    expect(absoluteTime(at(3, 6, 5), NOW)).toBe("06:05");
    expect(absoluteTime(at(4, 6, 12), NOW)).toBe("4 Nov 06:12");
    expect(absoluteTime(new Date(2027, 0, 2, 3, 4).getTime(), NOW)).toBe("2 Jan 2027 03:04");
  });

  it("durations", () => {
    expect(formatDuration(24 * 3_600_000)).toBe("24 h");
    expect(formatDuration(18 * 3_600_000 + 59 * 60_000 + 30_000)).toBe("18 h 59 m");
    expect(formatDuration(45 * 60_000)).toBe("45 m");
    expect(formatDuration(30_000)).toBe("30 s");
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(7 * 86_400_000)).toBe("7 d");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 d 4 h");
  });

  it("amounts and networks", () => {
    expect(formatBtc(1_000_000)).toBe("0.01000000");
    expect(formatBtc(2_100_000_000_000_000)).toBe("21000000.00000000");
    expect(coreBtcNetwork("testnet")).toBe("testnet4");
    expect(coreBtcNetwork("signet")).toBe("signet");
  });
});

describe("attemptRows", () => {
  it("clawback: number, time, action, outcome in seconds, NEAR and Bitcoin links", () => {
    expect(attemptRows([clawedBack], ctx)).toEqual([
      {
        key: "7-1",
        n: 1,
        at: "08:00",
        action: "Withdrawal Request",
        outcome: { tone: "ok", text: "Clawed back in 41 s" },
        links: {
          near: {
            href: "https://testnet.nearblocks.io/txns/REQHASH",
            text: "NEAR",
            label: "NEAR transaction of attempt 1",
          },
          bitcoin: {
            href: `https://mempool.space/signet/tx/${"bb".repeat(32)}`,
            text: "Bitcoin",
            label: "Bitcoin transaction of attempt 1",
          },
        },
        fresh: false,
      },
    ]);
  });

  it("no Bitcoin link before the broadcast; the Owner Account until the hash is known", () => {
    const [row] = attemptRows([{ ...clawedBack, clawback_broadcast: false, tx_hash: null }], ctx);
    expect(row?.links).toEqual({
      near: {
        href: "https://testnet.nearblocks.io/address/r7.challenge.testnet",
        text: "NEAR",
        label: "Owner Account of attempt 1 on NEAR",
      },
      bitcoin: null,
    });
  });

  it("outcomes and actions", () => {
    const rows = attemptRows(
      [
        early,
        { ...early, n: 4, method: "spend_allowance", code: null, failure: "ActionError.X" },
        { ...early, n: 5, method: null },
        pending,
        { ...pending, n: 6, outcome: "cancelled" },
        { ...pending, n: 8, outcome: "signed" },
        {
          type: "policy_change",
          round: 6,
          n: 9,
          seq: "3",
          vault_id: "41",
          change_id: "2",
          proposed_at: ns(at(2, 23)),
          outcome: "vetoed",
          tx_hash: "PCHASH",
        },
      ],
      ctx,
    );
    expect(rows.map((r) => [r.n, r.action, r.outcome.tone, r.outcome.text])).toEqual([
      [2, "Early Execute", "alarm", "Rejected ERR_NOT_EXECUTABLE"],
      [4, "spend_allowance", "alarm", "Rejected ActionError.X"],
      [5, "Contract call", "alarm", "Rejected ERR_NOT_EXECUTABLE"],
      [3, "Withdrawal Request", "neutral", "Pending"],
      [6, "Withdrawal Request", "neutral", "Cancelled"],
      [8, "Withdrawal Request", "alarm", "Signed"],
      [9, "Policy Change", "ok", "Vetoed"],
    ]);
    // A row of an earlier round carries its round; the current round's rows do not.
    expect(rows.at(-1)).toMatchObject({ round: 6, at: "2 Nov 23:00" });
    expect(rows[0]).not.toHaveProperty("round");
  });

  it("marks fresh rows and has no links on the mock contract", () => {
    const rows = attemptRows([early, clawedBack], {
      ...ctx,
      network: { btc: "regtest", near: "mock" },
      fresh: new Set(["7-1"]),
    });
    expect(rows.map((r) => r.fresh)).toEqual([false, true]);
    expect(rows.map((r) => r.links)).toEqual([
      { near: null, bitcoin: null },
      { near: null, bitcoin: null },
    ]);
  });
});

describe("hourly", () => {
  it("counts this round's attempts per hour over the last 24 h, oldest first", () => {
    const hours = hourly(
      [
        early,
        clawedBack,
        pending,
        { ...early, round: 6 },
        { ...early, block_timestamp: ns(at(1, 9)) },
      ],
      7,
      NOW,
    );
    expect(hours).toHaveLength(24);
    // 08:05 and 08:00 are within the hour before 09:30 minus one: index 22.
    expect(hours[22]).toBe(2);
    expect(hours[20]).toBe(1);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("challengeData", () => {
  it("a served round with one clawed-back withdrawal", () => {
    const data = challengeData(inputs(), config, NOW);
    expect(data).toMatchObject({
      round: 7,
      keysPublished: true,
      // No request pending: now + Delay, nothing elapsed.
      withdrawal: { time: "09:30", day: "4 Nov", requestedAt: null, remaining: "24 h", elapsed: 0 },
      attempts: { count: 2, total: 12, satsOut: 0, lastAt: "08:05" },
      vault: { amount: "0.01000000", unit: "sBTC", delay: "24 h" },
      satsTaken: 0,
      coSigner: { threshold: 11, total: 16 },
      rotation: { height: 291_744, at: "4 Nov 09:30" },
      coins: "Signet test coins · not real bitcoin",
      bountyUrl: null,
      keys: ROUND,
      pending: null,
    });
    expect(data.log?.map((row) => [row.n, row.action, row.outcome.text])).toEqual([
      [2, "Early Execute", "Rejected ERR_NOT_EXECUTABLE"],
      [1, "Withdrawal Request", "Clawed back in 41 s"],
    ]);
  });

  it("the hero follows the earliest pending request", () => {
    const later = { ...pending, n: 4, executable_at: ns(at(4, 7)) };
    const data = challengeData(
      inputs({ attempts: feed([later, pending, clawedBack]) }),
      config,
      NOW,
    );
    expect(data.withdrawal).toEqual({
      time: "06:12",
      day: "4 Nov",
      requestedAt: "06:12",
      remaining: "20 h 42 m",
      elapsed: (NOW - at(3, 6, 12)) / (24 * 3_600_000),
    });
    expect(data.pending).toEqual({ n: 3, opId: "7", executableAt: "4 Nov 06:12" });
  });

  it("each part is null until its own answer arrives; nothing is invented", () => {
    const data = challengeData(
      inputs({ attempts: null, balanceSats: null, tip: null, vaults: {}, coSigner: null }),
      config,
      NOW,
    );
    expect(data).toMatchObject({
      withdrawal: null,
      attempts: null,
      vault: { amount: null, unit: "sBTC", delay: null },
      satsTaken: null,
      coSigner: null,
      rotation: { height: 291_744, at: null },
      log: null,
      pending: null,
    });
    // With the attempts but not the Delay, a pending request still gives the hero.
    const partial = challengeData(inputs({ vaults: {}, attempts: feed([pending]) }), config, NOW);
    expect(partial.withdrawal?.time).toBe("06:12");
    expect(challengeData(inputs({ vaults: {} }), config, NOW).withdrawal).toBeNull();
  });

  it("shows the bounty link only when set and the real sats taken", () => {
    const data = challengeData(
      inputs({ attempts: feed([clawedBack], { sats_taken_total: 1234 }) }),
      { ...config, bountyUrl: "https://bounty.example.org" },
      NOW,
    );
    expect(data.bountyUrl).toBe("https://bounty.example.org");
    expect(data.satsTaken).toBe(1234);
    expect(data.attempts?.satsOut).toBe(1234);
  });
});

describe("neededVaults", () => {
  it("is the round's vault plus vaults of rows without a hash", () => {
    expect(neededVaults(ROUND, feed([clawedBack, { ...pending, vault_id: "41" }, early]))).toEqual([
      "41",
      "42",
    ]);
    expect(neededVaults(null, null)).toEqual([]);
  });
});

describe("NEAR and Bitcoin answers", () => {
  const encode = (value: unknown) => ({
    jsonrpc: "2.0",
    id: "morrow-web",
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] },
  });

  it("reads a call_function result", () => {
    expect(viewResult(encode({ a: 1 }))).toEqual({ a: 1 });
    expect(viewResult({ error: { name: "HANDLER_ERROR" } })).toBeNull();
    expect(viewResult({ result: { result: [300] } })).toBeNull();
  });

  it("reads the Delay and Owner Account of get_vault", () => {
    expect(
      vaultFacts({ owner_account: "r7.challenge.testnet", policy: { delay_ns: "86400000000000" } }),
    ).toEqual({
      delayNs: "86400000000000",
      ownerAccount: "r7.challenge.testnet",
      watcherPk: null,
    });
    expect(vaultFacts({ owner_account: "x", policy: {} })).toBeNull();
    const pk = "ab".repeat(32);
    expect(
      vaultFacts({ owner_account: "x", policy: { delay_ns: "1", watcher_x25519_pk: pk } }),
    ).toEqual({ delayNs: "1", ownerAccount: "x", watcherPk: pk });
    expect(
      vaultFacts({ owner_account: "x", policy: { delay_ns: "1", watcher_x25519_pk: "ab" } })
        ?.watcherPk,
    ).toBeNull();
  });

  it("reads the MPC threshold from the signer's state view", () => {
    const participants = {
      next_id: 3,
      participants: [
        ["a", 0, {}],
        ["b", 1, {}],
        ["c", 2, {}],
      ],
    };
    expect(signerFrom({ Running: { parameters: { threshold: 2, participants } } })).toEqual({
      threshold: 2,
      total: 3,
    });
    expect(
      signerFrom({
        Resharing: { previous_running_state: { parameters: { threshold: 2, participants } } },
      }),
    ).toEqual({ threshold: 2, total: 3 });
    expect(signerFrom({ Initializing: {} })).toBeNull();
    expect(signerFrom({ Running: { parameters: { threshold: 9, participants } } })).toBeNull();
  });

  it("sums an Esplora UTXO list", () => {
    expect(utxoSats([{ value: 600_000 }, { value: 400_000 }])).toBe(1_000_000);
    expect(utxoSats([])).toBe(0);
    expect(utxoSats([{ value: "1" }])).toBeNull();
    expect(utxoSats({})).toBeNull();
  });

  it("keeps the confirmed coins of an Esplora UTXO list as outpoints", () => {
    const txid = "f0".repeat(32);
    expect(
      confirmedOutpoints([
        { txid, vout: 1, value: 600_000, status: { confirmed: true, block_height: 9 } },
        { txid: "e1".repeat(32), vout: 0, value: 400_000, status: { confirmed: false } },
      ]),
    ).toEqual([{ txid, vout: 1, value_sats: "600000" }]);
    expect(confirmedOutpoints([])).toEqual([]);
    expect(confirmedOutpoints([{ txid: "zz", vout: 0, value: 1, status: {} }])).toBeNull();
    expect(confirmedOutpoints([{ txid, vout: -1, value: 1, status: {} }])).toBeNull();
    expect(confirmedOutpoints({})).toBeNull();
  });
});

describe("fetches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("/round: 200 is the round, 404 none, anything else an error", async () => {
    const answers = [
      new Response(JSON.stringify(ROUND), { status: 200 }),
      new Response("{}", { status: 404 }),
      new Response("{}", { status: 503 }),
      new Response("not json", { status: 200 }),
    ];
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return answers.shift() as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(await fetchRound("https://c.example.org/base/", signal)).toEqual({
      kind: "round",
      round: ROUND,
    });
    expect(await fetchRound("https://c.example.org", signal)).toEqual({ kind: "none" });
    expect(await fetchRound("https://c.example.org", signal)).toEqual({ kind: "error" });
    expect(await fetchRound("https://c.example.org", signal)).toEqual({ kind: "error" });
    expect(urls[0]).toBe("https://c.example.org/base/round");
  });

  it("/attempts and the tip height: null when unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network"))),
    );
    const signal = new AbortController().signal;
    expect(await fetchAttempts("https://c.example.org", signal)).toBeNull();
    expect(await fetchTipHeight("https://b.example.org", signal)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("291600\n")),
    );
    expect(await fetchTipHeight("https://b.example.org", signal)).toBe(291_600);
  });

  it("the Vault's coins: unreadable outpoints keep the balance, with none to spend", async () => {
    const signal = new AbortController().signal;
    const txid = "f0".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([{ txid, vout: 0, value: 7_000, status: { confirmed: true } }]),
      ),
    );
    expect(await fetchVaultUtxos("https://b.example.org", "tb1qv", signal)).toEqual({
      sats: 7_000,
      outpoints: [{ txid, vout: 0, value_sats: "7000" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ txid: "zz", vout: 0, value: 7_000, status: {} }])),
    );
    expect(await fetchVaultUtxos("https://b.example.org", "tb1qv", signal)).toEqual({
      sats: 7_000,
      outpoints: [],
    });
  });
});

describe("keysFile", () => {
  it("is the public round plus a short how-to", () => {
    const file = keysFile(ROUND);
    expect(file.filename).toBe("morrow-challenge-round-7.json");
    const body = JSON.parse(file.text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...Object.keys(ROUND), "how_to"].sort());
    expect(body.how_to).toMatch(/Delay/);
  });
});

describe("poll", () => {
  afterEach(() => vi.useRealTimers());

  it("never stacks checks and aborts the one in flight on cleanup", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let release: (value: number) => void = () => undefined;
    const check = vi.fn(
      (signal: AbortSignal) =>
        new Promise<number>((resolve) => {
          signals.push(signal);
          release = resolve;
        }),
    );
    const applied: number[] = [];
    const stop = poll(check, (value) => applied.push(value), 10_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    // Still pending: no second request.
    expect(check).toHaveBeenCalledTimes(1);
    release(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(applied).toEqual([1]);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    expect(signals.at(-1)?.aborted).toBe(true);
    release(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([1]);
  });
});
