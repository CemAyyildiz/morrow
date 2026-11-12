import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_DEPOSIT,
  callContract,
  errorGloss,
  gasFor,
  readCallOutcome,
  readCspNonce,
  viewContract,
  type Wallet,
} from "./near";

const b64 = (value: unknown) => btoa(JSON.stringify(value));

function fakeWallet(answer: () => Promise<unknown>) {
  const sent: unknown[] = [];
  const wallet: Wallet = {
    manifest: { id: "w", name: "W" },
    getAccounts: async () => [{ accountId: "alice.testnet" }],
    signAndSendTransaction: async (params) => {
      sent.push(params);
      return answer();
    },
  };
  return { wallet, sent };
}

afterEach(() => vi.unstubAllGlobals());

describe("readCspNonce", () => {
  const doc = (content: string | null) => ({
    querySelector: () =>
      content === null ? null : ({ getAttribute: () => content } as unknown as Element),
  });

  it("reads a 16-byte base64 nonce and nothing else", () => {
    expect(readCspNonce(doc("AAECAwQFBgcICQoLDA0ODw=="))).toBe("AAECAwQFBgcICQoLDA0ODw==");
    expect(readCspNonce(doc(null))).toBeNull();
    expect(readCspNonce(doc("nope"))).toBeNull();
    expect(readCspNonce(doc('AAECAwQFBgcICQoLDA0ODw=="><script>'))).toBeNull();
  });
});

describe("contract calls through the wallet", () => {
  it("chooses gas per method", () => {
    expect(gasFor("create_vault")).toBe(100_000_000_000_000n);
    expect(gasFor("sign_input")).toBe(100_000_000_000_000n);
    expect(gasFor("begin_clawback")).toBe(30_000_000_000_000n);
    expect(CREATE_DEPOSIT).toBe(500_000_000_000_000_000_000_000n);
  });

  it("sends one FunctionCall and reads its return value and logs", async () => {
    const { wallet, sent } = fakeWallet(async () => ({
      status: { SuccessValue: b64("7") },
      transaction: { hash: "HASH" },
      transaction_outcome: { id: "HASH", outcome: { logs: [] } },
      receipts_outcome: [{ outcome: { logs: ["EVENT_JSON:{}"] } }],
    }));
    const outcome = await callContract(
      wallet,
      "vault.testnet",
      "create_vault",
      { a: 1 },
      {
        deposit: CREATE_DEPOSIT,
      },
    );
    expect(outcome).toEqual({ kind: "ok", value: "7", hash: "HASH", logs: ["EVENT_JSON:{}"] });
    expect(sent).toEqual([
      {
        receiverId: "vault.testnet",
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "create_vault",
              args: { a: 1 },
              gas: "100000000000000",
              deposit: "500000000000000000000000",
            },
          },
        ],
      },
    ]);
  });

  it("reads a contract failure as refused with its ERR_ code", () => {
    const failure = {
      ActionError: {
        index: 0,
        kind: {
          FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_UNAUTHORIZED" },
        },
      },
    };
    expect(readCallOutcome({ status: { Failure: failure } })).toMatchObject({
      kind: "refused",
      code: "ERR_UNAUTHORIZED",
      hash: null,
    });
    expect(readCallOutcome({ status: { SuccessValue: "" } })).toMatchObject({
      kind: "ok",
      value: null,
    });
    expect(readCallOutcome("HASH")).toEqual({ kind: "unreadable", hash: null });
    expect(readCallOutcome({ status: { SuccessValue: "%%%" } }).kind).toBe("unreadable");
  });

  it("tells a wallet rejection from a contract refusal the wallet threw", async () => {
    const closed = fakeWallet(async () => {
      throw new Error("User rejected");
    });
    expect(await callContract(closed.wallet, "c", "begin_clawback", {})).toEqual({
      kind: "rejected",
      message: "User rejected",
    });
    const panicked = fakeWallet(async () => {
      throw new Error("Smart contract panicked: ERR_NOT_EXECUTABLE");
    });
    expect(await callContract(panicked.wallet, "c", "begin_execute", {})).toMatchObject({
      kind: "refused",
      code: "ERR_NOT_EXECUTABLE",
    });
  });

  it("counts only a clear cancel as not sent; any other throw may have sent", async () => {
    for (const message of ["Failed to sign in", "Request rejected by user", "Wallet closed"]) {
      const cancelled = fakeWallet(async () => {
        throw new Error(message);
      });
      expect(await callContract(cancelled.wallet, "c", "create_vault", {})).toEqual({
        kind: "rejected",
        message,
      });
    }
    const failed = fakeWallet(async () => {
      throw new Error("Transaction timed out waiting for the result");
    });
    expect(await callContract(failed.wallet, "c", "create_vault", {})).toEqual({
      kind: "unreadable",
      hash: null,
    });
  });

  it("glosses known error codes only", () => {
    expect(errorGloss("ERR_NOT_EXECUTABLE")).toMatch(/Delay/);
    expect(errorGloss("ERR_MADE_UP")).toBeNull();
  });
});

describe("contract views over raw RPC", () => {
  const signal = new AbortController().signal;

  it("decodes the call_function bytes", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ result: { result: [...new TextEncoder().encode('{"vault_id":"7"}')] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await viewContract("https://rpc", "c", "get_vault", { vault_id: "7" }, signal)).toEqual({
      kind: "ok",
      value: { vault_id: "7" },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.params).toMatchObject({
      request_type: "call_function",
      finality: "final",
      account_id: "c",
      method_name: "get_vault",
      args_base64: btoa('{"vault_id":"7"}'),
    });
  });

  it("reads a panicking view as its ERR_ code, and no answer as unreachable", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { data: "Smart contract panicked: ERR_VAULT_NOT_FOUND" } }),
    );
    expect(await viewContract("https://rpc", "c", "get_vault", {}, signal)).toEqual({
      kind: "error",
      code: "ERR_VAULT_NOT_FOUND",
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network");
    });
    expect(await viewContract("https://rpc", "c", "get_vault", {}, signal)).toEqual({
      kind: "unreachable",
    });
  });
});
