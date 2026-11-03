import { parseNearKey } from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import {
  akNonceOf,
  nearPort,
  rpcErrorKind,
  sendBatch,
  sendCall,
  type CallPlan,
  type NearRpcCall,
  type RpcAnswer,
} from "./near.js";

const KEY = parseNearKey(
  "ed25519:66m7p6tWp1rAfxZSpZsSKMee8gQwbaUHo94TFer32vkovBffNHHtMeZKVMGqj4Gz533H6qt6QhdUPLBWp8MEp13k",
);
const PLAN: CallPlan = {
  signerId: "r1.challenge",
  receiverId: "vault.challenge",
  method: "request_withdrawal",
  args: { vault_id: "1" },
};
/** base58 of 32 zero bytes: a valid block hash for `decodeBlockHash`. */
const BLOCK_HASH = "1".repeat(32);
const base64 = (text: string) => Buffer.from(text).toString("base64");

/** The nonce of a signed transaction: borsh signer_id (u32 len + bytes), key (1 + 32), u64 LE. */
function signedNonce(params: unknown): bigint {
  const bytes = Buffer.from((params as { signed_tx_base64: string }).signed_tx_base64, "base64");
  const signerLen = bytes.readUInt32LE(0);
  return bytes.readBigUInt64LE(4 + signerLen + 33);
}

/** A scripted RPC: a queue of answers per method. */
function fakeRpc(script: Partial<Record<string, RpcAnswer[]>>): {
  rpc: NearRpcCall;
  calls: string[];
  sent: bigint[];
} {
  const queues: Record<string, RpcAnswer[]> = {};
  for (const [method, answers] of Object.entries(script)) queues[method] = [...(answers ?? [])];
  const calls: string[] = [];
  const sent: bigint[] = [];
  const rpc: NearRpcCall = async (method, params) => {
    calls.push(method);
    if (method === "send_tx") sent.push(signedNonce(params));
    const queue = queues[method];
    const next = queue?.shift();
    if (!next) throw new Error(`no scripted answer for ${method} (#${calls.length})`);
    return next;
  };
  return { rpc, calls, sent };
}

const accessOk = (nonce = 5): RpcAnswer => ({
  kind: "result",
  result: { nonce, permission: { FunctionCall: { allowance: "1000000000000000000000000" } } },
});
const blockOk: RpcAnswer = { kind: "result", result: { header: { hash: BLOCK_HASH, height: 10 } } };
const sendAccepted = (value: string): RpcAnswer => ({
  kind: "result",
  result: { status: { SuccessValue: base64(JSON.stringify(value)) }, receipts_outcome: [] },
});

describe("rpcErrorKind", () => {
  it("classes the errors the run acts on", () => {
    expect(rpcErrorKind({ InvalidNonce: { ak_nonce: 9 } })).toBe("nonce");
    expect(rpcErrorKind("NotEnoughAllowance")).toBe("allowance");
    expect(rpcErrorKind("access key ed25519:x does not exist while viewing")).toBe("key_missing");
    expect(rpcErrorKind("TIMEOUT_ERROR")).toBe("timeout");
    expect(rpcErrorKind("something else")).toBe("other");
  });
});

describe("akNonceOf", () => {
  it("finds ak_nonce wherever it is nested", () => {
    expect(akNonceOf({ InvalidNonce: { ak_nonce: 42 } })).toBe(42);
    expect(akNonceOf({ cause: { info: { InvalidNonce: { ak_nonce: 7 } } } })).toBe(7);
    expect(akNonceOf({ nope: true })).toBeNull();
  });
});

describe("sendCall", () => {
  it("reads an accepted call and its return value", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk()],
      block: [blockOk],
      send_tx: [sendAccepted("7")],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.value).toBe("7");
  });

  it("maps a contract panic to the ERR_* code", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk()],
      block: [blockOk],
      send_tx: [
        {
          kind: "result",
          result: {
            status: {
              Failure: {
                ActionError: {
                  index: 0,
                  kind: {
                    FunctionCallError: {
                      ExecutionError: "Smart contract panicked: ERR_CLAWED_BACK",
                    },
                  },
                },
              },
            },
            transaction: { actions: [{ FunctionCall: { method_name: "request_withdrawal" } }] },
            receipts: [],
            receipts_outcome: [],
          },
        },
      ],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.code).toBe("ERR_CLAWED_BACK");
  });

  it("retries once on InvalidNonce, then succeeds with max(view, ak_nonce)+1", async () => {
    const { rpc, calls, sent } = fakeRpc({
      query: [accessOk(3), accessOk(3)],
      block: [blockOk, blockOk],
      send_tx: [{ kind: "error", error: { InvalidNonce: { ak_nonce: 99 } } }, sendAccepted("8")],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result.kind).toBe("accepted");
    expect(calls.filter((c) => c === "send_tx")).toHaveLength(2);
    expect(sent).toEqual([4n, 100n]); // view 3 + 1, then max(3, 99) + 1
  });

  it("without ak_nonce the retry still moves past the nonce it just used", async () => {
    const { rpc, sent } = fakeRpc({
      query: [accessOk(3), accessOk(3)],
      block: [blockOk, blockOk],
      send_tx: [{ kind: "error", error: "InvalidNonce" }, sendAccepted("8")],
    });
    expect((await sendCall(rpc, KEY, PLAN)).kind).toBe("accepted");
    expect(sent).toEqual([4n, 5n]);
  });

  it("gives up after InvalidNonce twice (not included)", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk(3), accessOk(3)],
      block: [blockOk, blockOk],
      send_tx: [
        { kind: "error", error: { InvalidNonce: { ak_nonce: 99 } } },
        { kind: "error", error: { InvalidNonce: { ak_nonce: 100 } } },
      ],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result).toMatchObject({ kind: "not_included", reason: "nonce" });
  });

  it("reports a gas-allowance error as not included", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk()],
      block: [blockOk],
      send_tx: [{ kind: "error", error: "NotEnoughAllowance" }],
    });
    expect(await sendCall(rpc, KEY, PLAN)).toMatchObject({
      kind: "not_included",
      reason: "allowance",
    });
  });

  it("reports a missing access key before anything is signed", async () => {
    const { rpc, calls } = fakeRpc({
      query: [{ kind: "error", error: "AccessKeyNotFound" }],
    });
    expect(await sendCall(rpc, KEY, PLAN)).toMatchObject({
      kind: "not_included",
      reason: "key_missing",
    });
    expect(calls).not.toContain("send_tx");
  });

  it("reports an invalid transaction as not included (never on chain)", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk()],
      block: [blockOk],
      send_tx: [
        { kind: "error", error: { cause: { name: "INVALID_TRANSACTION" }, data: "Expired" } },
      ],
    });
    expect(await sendCall(rpc, KEY, PLAN)).toMatchObject({
      kind: "not_included",
      reason: "invalid",
    });
  });

  it("is unreadable when the node does not answer", async () => {
    const { rpc } = fakeRpc({
      query: [{ kind: "unreachable", detail: "ECONNRESET" }],
    });
    expect(await sendCall(rpc, KEY, PLAN)).toMatchObject({ kind: "unreadable", hash: null });
  });

  it("is unreadable when send_tx forwards then times out (may have landed)", async () => {
    const { rpc } = fakeRpc({
      query: [accessOk()],
      block: [blockOk],
      send_tx: [{ kind: "unreachable", detail: "timeout after send" }],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result.kind).toBe("unreadable");
    if (result.kind === "unreadable") expect(result.hash).not.toBeNull();
  });
});

describe("sendBatch", () => {
  it("signs consecutive nonces from one view and sends them all", async () => {
    const { rpc, calls, sent } = fakeRpc({
      query: [accessOk(10)],
      block: [blockOk],
      send_tx: [sendAccepted("1"), sendAccepted("2"), sendAccepted("3")],
    });
    const results = await sendBatch(rpc, KEY, [PLAN, PLAN, PLAN]);
    expect(results.map((r) => r.kind)).toEqual(["accepted", "accepted", "accepted"]);
    expect(calls.filter((c) => c === "query")).toHaveLength(1);
    expect(sent).toEqual([11n, 12n, 13n]);
  });

  it("retries a sibling that met InvalidNonce on its own, above every nonce used", async () => {
    const { rpc, sent } = fakeRpc({
      query: [accessOk(10), accessOk(12)],
      block: [blockOk, blockOk],
      send_tx: [
        { kind: "error", error: { InvalidNonce: { ak_nonce: 12 } } },
        sendAccepted("2"),
        sendAccepted("4"),
      ],
    });
    const results = await sendBatch(rpc, KEY, [PLAN, PLAN]);
    expect(results.map((r) => r.kind)).toEqual(["accepted", "accepted"]);
    expect(sent).toEqual([11n, 12n, 13n]);
  });
});

describe("nearPort.accessKey", () => {
  const port = (result: unknown, error?: unknown) =>
    nearPort({
      rpcUrl: "http://rpc.test",
      vaultContract: "vault.challenge",
      fetchFn: (async () =>
        new Response(JSON.stringify(error === undefined ? { result } : { error }), {
          status: 200,
        })) as typeof fetch,
    });

  it("reads the allowance as a bigint", async () => {
    const state = await port({
      nonce: 7,
      permission: { FunctionCall: { allowance: "50000000000000000000000" } },
    }).accessKey("r1.challenge", "ed25519:x");
    expect(state).toEqual({
      exists: true,
      nonce: 7,
      allowanceYocto: 50_000_000_000_000_000_000_000n,
    });
  });

  it("reads a full-access key as no allowance limit", async () => {
    expect(await port({ nonce: 1, permission: "FullAccess" }).accessKey("a", "k")).toEqual({
      exists: true,
      nonce: 1,
      allowanceYocto: null,
    });
  });

  it("reads a missing key as gone", async () => {
    expect(
      await port(undefined, { cause: { name: "UNKNOWN_ACCESS_KEY" } }).accessKey("a", "k"),
    ).toEqual({
      exists: false,
    });
    expect(await port(undefined, "AccessKeyNotFound").accessKey("a", "k")).toEqual({
      exists: false,
    });
  });

  it("reads a non-numeric allowance as unreachable, never a crash", async () => {
    expect(
      await port({ nonce: 1, permission: { FunctionCall: { allowance: "lots" } } }).accessKey(
        "a",
        "k",
      ),
    ).toBe("unreachable");
  });
});
