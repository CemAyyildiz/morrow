import { parseNearKey } from "@morrow/core-ts/browser";
import { describe, expect, it } from "vitest";
import type { FeedEntry, WithdrawalEntry } from "./challenge";
import type { ChallengeKeys } from "./data";
import {
  EMPTY_TRY,
  FEE_RATE_SAT_VB,
  akNonceOf,
  executeTarget,
  planCall,
  readOutcome,
  rpcErrorKind,
  runCall,
  tryReducer,
  tryView,
  type NearRpcCall,
  type RpcAnswer,
  type TryInputs,
  type TryOutcome,
  type TryState,
} from "./try";

/** seed = 32 × 0x07 (computed once with @noble/curves). */
const SECRET =
  "ed25519:99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM";
const PUBLIC = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const KEY = parseNearKey(SECRET);
const BLOCK_HASH = "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ";
const WATCHER_PK = "9f".repeat(32);
const DESTINATION = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const NOW = new Date(2026, 10, 3, 9, 30).getTime();
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const KEYS: ChallengeKeys = {
  round: 7,
  vault_contract: "vault.morrow.testnet",
  near_network: "testnet",
  btc_network: "signet",
  vault_id: "42",
  owner_account: "r7.challenge.testnet",
  owner_key: `02${"11".repeat(32)}`,
  owner_key_secret: "22".repeat(32),
  near_function_call_key: SECRET,
  vault_address: "tb1qvault",
  escape_timelock_blocks: 1000,
  funding_txid: "aa".repeat(32),
  funding_height: 290_944,
  rotation_deadline_height: 291_744,
};

const OUTPOINTS = [{ txid: "aa".repeat(32), vout: 0, value_sats: "1000000" }];

function inputs(over: Partial<TryInputs> = {}): TryInputs {
  return {
    keys: KEYS,
    key: KEY,
    btc: "signet",
    near: "testnet",
    rpcUrl: "https://rpc.example",
    outpoints: OUTPOINTS,
    balanceSats: 1_000_000,
    watcherPk: WATCHER_PK,
    entries: [],
    ...over,
  };
}

const ready: TryState = tryReducer(EMPTY_TRY, {
  type: "reset",
  sessionId: "7:key",
  randomDestination: DESTINATION,
});

function pendingEntry(over: Partial<WithdrawalEntry> = {}): WithdrawalEntry {
  return {
    type: "withdrawal",
    round: 7,
    n: 3,
    seq: "30",
    vault_id: "42",
    op_id: "12",
    amount_sats: "50000",
    requested_at: ns(NOW - 6 * 3_600_000),
    executable_at: ns(NOW + 18 * 3_600_000),
    outcome: "pending",
    outcome_at: null,
    clawback_txid: null,
    clawback_broadcast: false,
    tx_hash: null,
    ...over,
  };
}

const b64 = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

interface Sent {
  method: string;
  args: Record<string, unknown>;
  nonce: bigint;
  valid: boolean;
  publicKey: Uint8Array;
}

/** Reads the parts of a signed FunctionCall transaction the tests check (WebCrypto verifies). */
async function decodeSigned(base64: string): Promise<Sent> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const body = bytes.slice(0, bytes.length - 65);
  const signature = bytes.slice(bytes.length - 64);
  const view = new DataView(body.buffer);
  let at = 0;
  const str = () => {
    const n = view.getUint32(at, true);
    const text = new TextDecoder().decode(body.slice(at + 4, at + 4 + n));
    at += 4 + n;
    return text;
  };
  str(); // signer
  at += 1;
  const publicKey = body.slice(at, at + 32);
  at += 32;
  const nonce = view.getBigUint64(at, true);
  at += 8;
  str(); // receiver
  at += 32 + 4 + 1;
  const method = str();
  const args = JSON.parse(str()) as Record<string, unknown>;
  const digest = await crypto.subtle.digest("SHA-256", body);
  const verifier = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", verifier, signature, digest);
  return { method, args, nonce, valid, publicKey };
}

const success = (value: unknown, logs: string[] = []) => ({
  status: { SuccessValue: b64(value) },
  transaction: {
    hash: "H",
    signer_id: KEYS.owner_account,
    receiver_id: KEYS.vault_contract,
    actions: [],
  },
  transaction_outcome: {
    id: "T",
    block_hash: "B",
    outcome: {
      executor_id: KEYS.owner_account,
      logs: [],
      receipt_ids: ["R"],
      status: { SuccessReceiptId: "R" },
    },
  },
  receipts_outcome: [
    {
      id: "R",
      block_hash: "B",
      outcome: {
        executor_id: KEYS.vault_contract,
        logs,
        receipt_ids: [],
        status: { SuccessValue: b64(value) },
      },
    },
  ],
});

const panic = (code: string) => {
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } },
    },
  };
  return {
    status: { Failure: failure },
    transaction: {
      hash: "H",
      signer_id: KEYS.owner_account,
      receiver_id: KEYS.vault_contract,
      actions: [],
    },
    transaction_outcome: {
      id: "T",
      block_hash: "B",
      outcome: {
        executor_id: KEYS.owner_account,
        logs: [],
        receipt_ids: ["R"],
        status: { SuccessReceiptId: "R" },
      },
    },
    receipts_outcome: [
      {
        id: "R",
        block_hash: "B",
        outcome: {
          executor_id: KEYS.vault_contract,
          logs: [],
          receipt_ids: [],
          status: { Failure: failure },
        },
      },
    ],
  };
};

const REQUESTED_LOG = `EVENT_JSON:${JSON.stringify({
  standard: "morrow",
  version: "1.0.0",
  event: "withdrawal_requested",
  data: [{ vault_id: "42", payload: { op_id: "501", executable_at: ns(NOW + 24 * 3_600_000) } }],
})}`;

/** A fake NEAR RPC: access key nonce, final block, and `send_tx` answered by `onSend`. */
function fakeRpc(
  onSend: (sent: Sent, count: number) => RpcAnswer,
  over: Partial<Record<string, RpcAnswer>> = {},
) {
  const calls: string[] = [];
  const sent: Sent[] = [];
  const nonce = 40;
  const rpc: NearRpcCall = async (method, params) => {
    const p = params as Record<string, unknown>;
    const name = method === "query" ? String(p.request_type) : method;
    calls.push(name);
    if (over[name]) return over[name] as RpcAnswer;
    if (name === "view_access_key") {
      expect(p.public_key).toBe(PUBLIC);
      expect(p.account_id).toBe(KEYS.owner_account);
      return { kind: "result", result: { nonce, permission: {}, block_hash: BLOCK_HASH } };
    }
    if (name === "block") return { kind: "result", result: { header: { hash: BLOCK_HASH } } };
    if (name === "send_tx") {
      expect(p.wait_until).toBe("EXECUTED_OPTIMISTIC");
      const tx = await decodeSigned(String(p.signed_tx_base64));
      sent.push(tx);
      return onSend(tx, sent.length);
    }
    return { kind: "unreachable" };
  };
  return { rpc, calls, sent };
}

async function attempt(
  action: "request" | "execute",
  rpc: NearRpcCall,
  state: TryState = ready,
  ins: TryInputs = inputs(),
): Promise<{ outcome: TryOutcome; state: TryState; hashes: string[] }> {
  const planned = planCall(action, state.destination, state, ins);
  if (!planned.ok) throw new Error(`not planned: ${planned.problem}`);
  let next = tryReducer(state, { type: "start", id: 1, action, at: NOW });
  const hashes: string[] = [];
  const outcome = await runCall(rpc, KEY, action, planned.plan, (hash) => {
    hashes.push(hash);
    next = tryReducer(next, { type: "signed", id: 1, hash });
  });
  next = tryReducer(next, { type: "settled", id: 1, outcome });
  return { outcome, state: next, hashes };
}

describe("Try with these keys: full balance", () => {
  it("signs one valid request_withdrawal of every confirmed coin and reads it as accepted", async () => {
    const { rpc, sent } = fakeRpc(() => ({
      kind: "result",
      result: success("501", [REQUESTED_LOG]),
    }));
    const { outcome, state, hashes } = await attempt("request", rpc);
    expect(sent).toHaveLength(1);
    const tx = sent[0]!;
    expect(tx.valid).toBe(true);
    // Signed by the published key.
    expect([...tx.publicKey]).toEqual([...KEY.publicKey]);
    expect(tx.nonce).toBe(41n);
    expect(tx.method).toBe("request_withdrawal");
    expect(tx.args).toMatchObject({
      vault_id: "42",
      // The input total minus the fee bound 2 × (60 + 250 × 1) sats.
      amount_sats: "999380",
      destination: DESTINATION,
      fee_rate_sat_vb: FEE_RATE_SAT_VB,
      utxos: OUTPOINTS,
    });
    expect(tx.args.envelope).toMatch(/^[0-9a-f]{160}$/);
    expect(hashes).toHaveLength(1);
    expect(outcome).toEqual({
      kind: "accepted",
      opId: "501",
      executableAt: ns(NOW + 24 * 3_600_000),
    });
    expect(state.ownOpId).toBe("501");

    // Steps 1–2 lit, MPC not reached, Bitcoin counting.
    const view = tryView(state, inputs(), NOW + 7_000);
    expect(view.steps.map((s) => s.state)).toEqual(["done", "done", "unreached", "pending"]);
    expect(view.steps[0]?.detail).toMatch(/^request_withdrawal · \w{6}…\w{4}$/);
    expect(view.steps[1]?.detail).toBe("Accepted · executable at 4 Nov 09:30");
    expect(view.steps[2]?.detail).toBe("the contract asks the MPC network only after the Delay");
    expect(view.steps[3]?.detail).toBe("Waiting for the guardian · 7 s");
    expect(view.waiting).toBe(true);
    expect(view.links.near?.href).toBe(`https://testnet.nearblocks.io/txns/${hashes[0]}`);
    expect(view.links.bitcoin).toBeNull();
    expect(view.announcement).toBe("Contract rule: Accepted · executable at 4 Nov 09:30");
    // The own request holds the coins: another one would only meet ERR_OUTPOINT_RESERVED.
    expect(view.request).toEqual({
      enabled: false,
      reason: "Your request holds the coins until it is clawed back.",
    });
    expect(view.execute).toMatchObject({ enabled: true, target: "501" });

    // The feed's entry for the op turns step 4 into the Clawback once it is broadcast.
    const clawed = pendingEntry({
      op_id: "501",
      n: 4,
      requested_at: ns(NOW),
      outcome: "clawed_back",
      outcome_at: ns(NOW + 41_000),
      clawback_txid: "c1".repeat(32),
    });
    const notYet = tryView(state, inputs({ entries: [clawed] }), NOW + 45_000);
    expect(notYet.steps[3]?.state).toBe("pending");
    const done = tryView(
      state,
      inputs({ entries: [{ ...clawed, clawback_broadcast: true }] }),
      NOW + 50_000,
    );
    expect(done.steps[3]).toEqual({
      title: "Bitcoin",
      detail: "Clawed back in 41 s · c1c1c1…c1c1",
      state: "ok",
    });
    expect(done.waiting).toBe(false);
    expect(done.links.bitcoin?.href).toBe(`https://mempool.space/signet/tx/${"c1".repeat(32)}`);
    expect(done.announcement).toBe("Bitcoin: Clawed back in 41 s · c1c1c1…c1c1");
    expect(done.request.enabled).toBe(true);
  });

  it("takes the op id from the EVENT_JSON log when the return value is unreadable", () => {
    expect(readOutcome(success(null, [REQUESTED_LOG]), KEYS.vault_contract, "request")).toEqual({
      kind: "accepted",
      opId: "501",
      executableAt: ns(NOW + 24 * 3_600_000),
    });
  });

  it("RPC down: could not reach NEAR, nothing signed, the button comes back", async () => {
    const { rpc, sent } = fakeRpc(() => ({ kind: "unreachable" }), {
      view_access_key: { kind: "unreachable" },
    });
    const { outcome, state, hashes } = await attempt("request", rpc);
    expect(outcome).toEqual({ kind: "unreachable" });
    expect(sent).toHaveLength(0);
    expect(hashes).toHaveLength(0);
    const view = tryView(state, inputs(), NOW);
    expect(view.notice).toEqual({ tone: "alarm", text: "Could not reach NEAR. Nothing was sent." });
    expect(view.request.enabled).toBe(true);
    expect(view.steps.map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(view.links.near).toBeNull();
  });

  it("a result that cannot be read leaves the steps pending and says so", async () => {
    const { rpc } = fakeRpc(() => ({ kind: "unreachable" }));
    const { outcome, state } = await attempt("request", rpc);
    expect(outcome).toEqual({ kind: "unreadable" });
    const view = tryView(state, inputs(), NOW);
    expect(view.steps.map((s) => s.state)).toEqual(["done", "pending", "pending", "pending"]);
    expect(view.notice?.text).toMatch(/may have been sent, but its result could not be read/);
    expect(readOutcome({ status: { SuccessReceiptId: "x" } }, "c", "request")).toEqual({
      kind: "unreadable",
    });
    expect(readOutcome("nope", "c", "request")).toEqual({ kind: "unreadable" });
  });

  it("UTXO reserved: refused with ERR_OUTPOINT_RESERVED, stops at step 2", async () => {
    const { rpc } = fakeRpc(() => ({ kind: "result", result: panic("ERR_OUTPOINT_RESERVED") }));
    const { outcome, state } = await attempt("request", rpc);
    expect(outcome).toMatchObject({ kind: "refused", code: "ERR_OUTPOINT_RESERVED" });
    const view = tryView(state, inputs(), NOW);
    expect(view.steps.map((s) => s.state)).toEqual(["done", "refused", "unreached", "unreached"]);
    expect(view.steps[1]?.detail).toBe(
      "Refused · ERR_OUTPOINT_RESERVED · One of these coins is already used by another operation.",
    );
    expect(view.waiting).toBe(false);
    expect(state.ownOpId).toBeNull();
  });

  it("a refusal without a code shows the raw failure kind", () => {
    const outcome = readOutcome(
      {
        ...panic("x"),
        status: {
          Failure: {
            ActionError: {
              index: 0,
              kind: { FunctionCallError: { HostError: { GasExceeded: null } } },
            },
          },
        },
        receipts_outcome: [],
      },
      KEYS.vault_contract,
      "request",
    );
    expect(outcome).toEqual({
      kind: "refused",
      code: null,
      failure: "ActionError.FunctionCallError.HostError.GasExceeded",
      onChain: true,
    });
  });

  it("bad destination: inline error and nothing is signed", () => {
    for (const [destination, problem] of [
      ["not an address", "malformed"],
      ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "network"],
      ["", "malformed"],
    ] as const) {
      const planned = planCall("request", destination, ready, inputs());
      expect(planned).toEqual({ ok: false, problem });
      const state = tryReducer(ready, { type: "refuse-destination", problem });
      expect(tryView(state, inputs(), NOW).destinationError).toMatch(/Nothing was signed/);
      // Editing the address clears the error.
      expect(tryReducer(state, { type: "destination", value: "x" }).destinationProblem).toBeNull();
    }
  });

  it("nonce race: one retry with a fresh nonce; a second InvalidNonce is shown", async () => {
    const invalidNonce = {
      kind: "error" as const,
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "INVALID_TRANSACTION" },
        data: {
          TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 41, ak_nonce: 43 } } },
        },
      },
    };
    const once = fakeRpc((_, count) =>
      count === 1 ? invalidNonce : { kind: "result", result: success("501", [REQUESTED_LOG]) },
    );
    const first = await attempt("request", once.rpc);
    expect(first.outcome.kind).toBe("accepted");
    // `final` still says 40: the retry signs above the ak_nonce the error named (43).
    expect(once.sent.map((s) => s.nonce)).toEqual([41n, 44n]);
    expect(once.calls.filter((c) => c === "view_access_key")).toHaveLength(2);
    expect(once.sent.every((s) => s.valid)).toBe(true);

    const twice = fakeRpc(() => invalidNonce);
    const second = await attempt("request", twice.rpc);
    expect(second.outcome).toEqual({ kind: "nonce" });
    expect(twice.sent).toHaveLength(2);
    const view = tryView(second.state, inputs(), NOW);
    expect(view.notice?.tone).toBe("alarm");
    expect(view.request.enabled).toBe(true);
  });

  it("key spent: a fresh key is being published; disabled until the session is replaced", async () => {
    for (const answer of [
      {
        send: {
          kind: "error",
          error: {
            data: {
              TxExecutionError: {
                InvalidTxError: { InvalidAccessKeyError: { NotEnoughAllowance: {} } },
              },
            },
          },
        } as RpcAnswer,
      },
      {
        view: {
          kind: "error",
          error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} } },
        } as RpcAnswer,
      },
    ]) {
      const { rpc } = fakeRpc(
        () => answer.send ?? { kind: "unreachable" },
        answer.view ? { view_access_key: answer.view } : {},
      );
      const { outcome, state } = await attempt("request", rpc);
      expect(outcome).toEqual({ kind: "spent" });
      expect(state.spent).toBe(true);
      const view = tryView(state, inputs(), NOW);
      // Said once, as the buttons' reason (and read out).
      expect(view.notice).toBeNull();
      expect(view.request).toEqual({
        enabled: false,
        reason: expect.stringMatching(/A fresh key is being published/),
      });
      expect(view.announcement).toBe(view.request.reason);
      expect(view.execute.enabled).toBe(false);
      const replaced = tryReducer(state, {
        type: "reset",
        sessionId: "7:new",
        randomDestination: DESTINATION,
      });
      expect(tryView(replaced, inputs(), NOW).request.enabled).toBe(true);
    }
    expect(rpcErrorKind({ name: "x", cause: { name: "TIMEOUT_ERROR" } })).toBe("timeout");
    expect(rpcErrorKind({ AccessKeyNotFound: {} })).toBe("spent");
    expect(rpcErrorKind("access key ed25519:abc does not exist while viewing")).toBe("spent");
    expect(
      rpcErrorKind({
        name: "HANDLER_ERROR",
        cause: { name: "UNKNOWN_ACCOUNT", info: {} },
        data: "account r7.challenge.testnet does not exist while viewing",
      }),
    ).toBe("other");
  });

  it("no UTXO: the full-balance request is disabled with a reason", () => {
    expect(tryView(ready, inputs({ outpoints: [], balanceSats: 0 }), NOW).request).toEqual({
      enabled: false,
      reason: "The vault holds no coins. A new round opens after each Clawback.",
    });
    expect(tryView(ready, inputs({ outpoints: [], balanceSats: 5_000 }), NOW).request.reason).toBe(
      "The coins are not confirmed yet.",
    );
    const dust = [{ txid: "aa".repeat(32), vout: 0, value_sats: "620" }];
    expect(tryView(ready, inputs({ outpoints: dust }), NOW).request.reason).toBe(
      "The vault's coins do not cover the fee of a withdrawal.",
    );
    expect(planCall("request", DESTINATION, ready, inputs({ outpoints: dust }))).toEqual({
      ok: false,
      problem: "unavailable",
    });
    expect(tryView(ready, inputs({ outpoints: null }), NOW).request.reason).toBe(
      "Reading the vault's coins.",
    );
    expect(tryView(ready, inputs({ watcherPk: undefined }), NOW).request.enabled).toBe(false);
    expect(tryView(ready, inputs({ key: null }), NOW).request.reason).toBe(
      "The published key cannot be read.",
    );
    expect(tryView(ready, inputs({ near: "mock" }), NOW).request.enabled).toBe(false);
    expect(planCall("request", DESTINATION, ready, inputs({ outpoints: [] }))).toEqual({
      ok: false,
      problem: "unavailable",
    });
  });

  it("sends every confirmed coin even beyond five: the contract answers truthfully", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      txid: "ab".repeat(32),
      vout: i,
      value_sats: "100000",
    }));
    const planned = planCall("request", DESTINATION, ready, inputs({ outpoints: six }));
    // 600,000 − 2 × (60 + 250 × 6).
    expect(planned.ok && planned.plan.args).toMatchObject({ amount_sats: "596880", utxos: six });
  });

  it("send_tx timeout: may have been sent, step 1 done with its NEAR link", async () => {
    const { rpc } = fakeRpc(() => ({
      kind: "error",
      error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} } },
    }));
    const { outcome, state, hashes } = await attempt("request", rpc);
    expect(outcome).toEqual({ kind: "unreadable" });
    const view = tryView(state, inputs(), NOW);
    expect(view.steps.map((s) => s.state)).toEqual(["done", "pending", "pending", "pending"]);
    expect(view.links.near?.href).toBe(`https://testnet.nearblocks.io/txns/${hashes[0]}`);
    expect(view.notice?.text).toMatch(/^The transaction may have been sent/);
    expect(view.waiting).toBe(false);
  });

  it("an internal error after forwarding is unreadable, not refused", async () => {
    const { rpc } = fakeRpc(() => ({
      kind: "error",
      error: { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR", info: {} } },
    }));
    expect((await attempt("request", rpc)).outcome).toEqual({ kind: "unreadable" });
  });

  it("an invalid transaction is refused before it ran: not sent, no link, a notice", async () => {
    const { rpc } = fakeRpc(() => ({
      kind: "error",
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "INVALID_TRANSACTION", info: {} },
        data: { TxExecutionError: { InvalidTxError: { Expired: null } } },
      },
    }));
    const { outcome, state } = await attempt("request", rpc);
    expect(outcome).toEqual({
      kind: "refused",
      code: null,
      failure: "TxExecutionError.InvalidTxError.Expired",
      onChain: false,
    });
    const view = tryView(state, inputs(), NOW);
    expect(view.steps[0]).toMatchObject({
      state: "pending",
      detail: "request_withdrawal · not sent",
    });
    expect(view.links.near).toBeNull();
    expect(view.notice).toEqual({
      tone: "alarm",
      text: "NEAR refused the transaction before it ran · TxExecutionError.InvalidTxError.Expired",
    });
    expect(view.announcement).toBe(view.notice?.text);
    expect(view.request.enabled).toBe(true);
  });

  it("an unreadable request is reconciled from the feed by its transaction hash", async () => {
    const { rpc } = fakeRpc(() => ({ kind: "unreachable" }));
    const { state, hashes } = await attempt("request", rpc);
    const entry = pendingEntry({ op_id: "777", n: 9, tx_hash: hashes[0] as string });
    const view = tryView(state, inputs({ entries: [entry] }), NOW + 3_000);
    expect(view.notice).toBeNull();
    expect(view.steps.map((s) => s.state)).toEqual(["done", "done", "unreached", "pending"]);
    expect(view.steps[3]?.detail).toBe("Waiting for the guardian · 3 s");
    expect(view.execute.target).toBe("777");
    expect(view.request.reason).toBe("Your request holds the coins until it is clawed back.");
    const clawed = { ...entry, outcome: "clawed_back" as const, outcome_at: entry.requested_at };
    const later = tryView(
      state,
      inputs({
        entries: [{ ...clawed, clawback_txid: "c1".repeat(32), clawback_broadcast: true }],
      }),
      NOW,
    );
    expect(later.steps[3]?.state).toBe("ok");
  });

  it("an accepted request without an op id does not count forever", () => {
    const state = tryReducer(
      tryReducer(ready, { type: "start", id: 1, action: "request", at: NOW }),
      {
        type: "settled",
        id: 1,
        outcome: { kind: "accepted", opId: null, executableAt: null },
      },
    );
    const view = tryView(state, inputs(), NOW + 60_000);
    expect(view.waiting).toBe(false);
    expect(view.steps[3]).toMatchObject({
      state: "pending",
      detail: expect.stringMatching(/op id/),
    });
  });
});

describe("Try with these keys: Early Execute", () => {
  it("refused with ERR_NOT_EXECUTABLE on the newest pending feed request", async () => {
    const entries: FeedEntry[] = [
      pendingEntry({ op_id: "14", n: 5, outcome: "clawed_back" }),
      pendingEntry({ op_id: "13", n: 4 }),
      pendingEntry({ op_id: "12", n: 3 }),
    ];
    const ins = inputs({ entries });
    const { rpc, sent } = fakeRpc(() => ({ kind: "result", result: panic("ERR_NOT_EXECUTABLE") }));
    const { outcome, state } = await attempt("execute", rpc, ready, ins);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("begin_execute");
    expect(sent[0]?.args).toMatchObject({ op_id: "13" });
    expect(sent[0]?.args.envelope).toMatch(/^[0-9a-f]{160}$/);
    expect(outcome).toMatchObject({ kind: "refused", code: "ERR_NOT_EXECUTABLE" });
    const view = tryView(state, ins, NOW);
    expect(view.steps.map((s) => s.state)).toEqual(["done", "refused", "unreached", "unreached"]);
    expect(view.steps[1]?.detail).toMatch(
      /^Refused · ERR_NOT_EXECUTABLE · The Delay has not passed/,
    );
    expect(view.announcement).toMatch(/^Contract rule: Refused · ERR_NOT_EXECUTABLE/);
  });

  it("an accepted Execute says so and waits on the MPC step, with no endless counter", async () => {
    const ins = inputs({ entries: [pendingEntry()] });
    const { rpc } = fakeRpc(() => ({ kind: "result", result: success({ op_id: "12" }) }));
    const { outcome, state } = await attempt("execute", rpc, ready, ins);
    expect(outcome).toEqual({ kind: "accepted", opId: null, executableAt: null });
    const view = tryView(state, ins, NOW + 90_000);
    expect(view.steps[1]?.detail).toBe("Accepted · the contract took the early execute");
    expect(view.steps[2]).toMatchObject({
      state: "pending",
      detail: "the contract asks the MPC network to co-sign",
    });
    expect(view.steps[3]?.state).toBe("pending");
    expect(view.waiting).toBe(false);
  });

  it("targets this session's own pending request first", () => {
    const own = { ...ready, ownOpId: "501" };
    const entries = [pendingEntry({ op_id: "13" })];
    expect(executeTarget(own, inputs({ entries }))).toBe("501");
    // Once the feed shows it clawed back, the newest pending one is next.
    const clawed = [pendingEntry({ op_id: "501", outcome: "clawed_back" }), ...entries];
    expect(executeTarget(own, inputs({ entries: clawed }))).toBe("13");
  });

  it("no pending request: disabled with a reason", () => {
    const entries = [
      pendingEntry({ outcome: "clawed_back" }),
      pendingEntry({ round: 6, op_id: "2" }),
    ];
    const view = tryView(ready, inputs({ entries }), NOW);
    expect(view.execute).toEqual({
      enabled: false,
      reason: "No withdrawal request is pending. Request the full balance first.",
      target: null,
    });
    expect(planCall("execute", "", ready, inputs({ entries }))).toEqual({
      ok: false,
      problem: "unavailable",
    });
  });
});

describe("Try session state", () => {
  it("runs one attempt at a time and ignores answers from a replaced session", () => {
    let state = tryReducer(ready, { type: "start", id: 1, action: "request", at: NOW });
    expect(tryReducer(state, { type: "start", id: 2, action: "execute", at: NOW })).toBe(state);
    expect(tryView(state, inputs(), NOW).request.enabled).toBe(false);
    expect(tryView(state, inputs(), NOW).busy).toBe(true);
    state = tryReducer(state, { type: "reset", sessionId: "8:key", randomDestination: "tb1qnew" });
    const after = tryReducer(state, {
      type: "settled",
      id: 1,
      outcome: { kind: "accepted", opId: "9", executableAt: null },
    });
    expect(after).toBe(state);
    expect(after.destination).toBe("tb1qnew");
  });

  it("marks the destination as random only while it is the address made here", () => {
    expect(tryView(ready, inputs(), NOW).isRandom).toBe(true);
    const edited = tryReducer(ready, { type: "destination", value: "tb1qother" });
    expect(tryView(edited, inputs(), NOW).isRandom).toBe(false);
  });

  it("before any attempt the steps wait, and nothing is announced", () => {
    const view = tryView(ready, inputs(), NOW);
    expect(view.started).toBe(false);
    expect(view.steps.map((s) => s.title)).toEqual([
      "Request",
      "Contract rule",
      "MPC co-signature",
      "Bitcoin",
    ]);
    expect(view.steps.every((s) => s.state === "pending")).toBe(true);
    expect(view.announcement).toBe("");
  });

  it("reads ak_nonce wherever the node puts it", () => {
    expect(
      akNonceOf({
        data: {
          TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } } },
        },
      }),
    ).toBe(9);
    expect(akNonceOf({ cause: { info: { InvalidNonce: { ak_nonce: 3 } } } })).toBe(3);
    expect(akNonceOf({ name: "x" })).toBeNull();
  });
});
