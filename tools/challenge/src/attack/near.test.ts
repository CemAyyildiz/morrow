import { parseNearKey } from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import {
  akNonceOf,
  rpcErrorKind,
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

/** A scripted RPC: a queue of answers per method. */
function fakeRpc(script: Partial<Record<string, RpcAnswer[]>>): {
  rpc: NearRpcCall;
  calls: string[];
} {
  const queues: Record<string, RpcAnswer[]> = {};
  for (const [method, answers] of Object.entries(script)) queues[method] = [...(answers ?? [])];
  const calls: string[] = [];
  const rpc: NearRpcCall = async (method) => {
    calls.push(method);
    const queue = queues[method];
    const next = queue?.shift();
    if (!next) throw new Error(`no scripted answer for ${method} (#${calls.length})`);
    return next;
  };
  return { rpc, calls };
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
    const { rpc, calls } = fakeRpc({
      query: [accessOk(3), accessOk(3)],
      block: [blockOk, blockOk],
      send_tx: [{ kind: "error", error: { InvalidNonce: { ak_nonce: 99 } } }, sendAccepted("8")],
    });
    const result = await sendCall(rpc, KEY, PLAN);
    expect(result.kind).toBe("accepted");
    expect(calls.filter((c) => c === "send_tx")).toHaveLength(2);
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
