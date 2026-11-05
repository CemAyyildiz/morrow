import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, KeyType, PublicKey, decodeSignedTransaction } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KEY_ENV,
  describePermission,
  isFullAccess,
  loadSigningKey,
  nearReader,
  nearSender,
} from "./rpc.js";

describe("isFullAccess", () => {
  it("counts FullAccess and GasKeyFullAccess as full access", () => {
    expect(isFullAccess("FullAccess")).toBe(true);
    expect(isFullAccess({ GasKeyFullAccess: { balance: "0", num_nonces: 2 } })).toBe(true);
  });

  it("does not count function-call keys, plain or gas", () => {
    expect(isFullAccess({ FunctionCall: { receiver_id: "x", method_names: [] } })).toBe(false);
    expect(isFullAccess({ GasKeyFunctionCall: { receiver_id: "x", method_names: [] } })).toBe(
      false,
    );
  });

  it("counts a permission it does not recognise as full access", () => {
    expect(isFullAccess({ SomeFutureKind: {} })).toBe(true);
    expect(isFullAccess("Other")).toBe(true);
    expect(isFullAccess(null)).toBe(true);
  });
});

describe("loadSigningKey", () => {
  const key = KeyPair.fromRandom("ed25519");
  const secret = key.toString();

  function credentials(content: unknown) {
    const home = mkdtempSync(join(tmpdir(), "morrow-deploy-home-"));
    mkdirSync(join(home, ".near-credentials", "testnet"), { recursive: true });
    writeFileSync(
      join(home, ".near-credentials", "testnet", "x.testnet.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return home;
  }

  it("prefers MORROW_DEPLOY_PRIVATE_KEY", () => {
    const loaded = loadSigningKey("x.testnet", "testnet", { [KEY_ENV]: secret }, "/nowhere");
    expect(loaded.getPublicKey().toString()).toBe(key.getPublicKey().toString());
  });

  it("reads the near-api-js credential file", () => {
    const home = credentials({ account_id: "x.testnet", private_key: secret });
    const loaded = loadSigningKey("x.testnet", "testnet", {}, home);
    expect(loaded.getPublicKey().toString()).toBe(key.getPublicKey().toString());
  });

  it("refuses a credential file for another account", () => {
    const home = credentials({ account_id: "y.testnet", private_key: secret });
    expect(() => loadSigningKey("x.testnet", "testnet", {}, home)).toThrow(
      /is for y.testnet, not x.testnet/,
    );
  });

  it.each([["null"], ["[]"], ["42"], ['"ed25519:x"']])(
    "refuses a credential file holding %s with a usage error",
    (content) => {
      const home = credentials(content);
      expect(() => loadSigningKey("x.testnet", "testnet", {}, home)).toThrow(
        /x\.testnet\.json does not hold a JSON object$/,
      );
    },
  );

  it("names where it looked when there is no key", () => {
    expect(() => loadSigningKey("x.testnet", "testnet", {}, "/nowhere")).toThrow(
      `No key for x.testnet: set ${KEY_ENV} or create /nowhere/.near-credentials/testnet/x.testnet.json`,
    );
  });

  it("never quotes a bad key in its error", () => {
    const bad = "ed25519:notARealKeyButSecretLooking";
    let message = "";
    try {
      loadSigningKey("x.testnet", "testnet", { [KEY_ENV]: bad }, "/nowhere");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${KEY_ENV} is not a valid NEAR private key`);
    const home = credentials({ private_key: bad });
    expect(() => loadSigningKey("x.testnet", "testnet", {}, home)).toThrow(
      /x\.testnet\.json is not a valid NEAR private key$/,
    );
  });
});

describe("describePermission", () => {
  it("summarises each key kind on one line", () => {
    expect(describePermission("FullAccess")).toBe("FullAccess");
    expect(describePermission({ GasKeyFullAccess: { balance: "0", num_nonces: 1 } })).toBe(
      "GasKeyFullAccess",
    );
    expect(
      describePermission({
        FunctionCall: { receiver_id: "v.testnet", method_names: ["a", "b"], allowance: null },
      }),
    ).toBe("FunctionCall receiver v.testnet, methods a,b");
    expect(describePermission({ Other: 1 })).toBe('{"Other":1}');
  });
});

type RpcRequest = { method: string; params: Record<string, unknown> };

/** A JSON-RPC stub: answers by method (and query request_type) and records every request. */
function stubRpc(answers: Record<string, unknown>) {
  const requests: RpcRequest[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest;
    requests.push(body);
    const key = body.method === "query" ? `query:${String(body.params.request_type)}` : body.method;
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected RPC ${key}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", ...(answer as object) }));
  }) as typeof fetch;
  return { requests, fetchFn };
}

const CONFIG = {
  signer_account: "v1.signer-prod.testnet",
  allowed_networks: ["signet"],
  creator_allowlist: [],
  version: "0.1.0",
};
const bytes = (value: unknown) => [...Buffer.from(JSON.stringify(value))];

describe("nearReader", () => {
  const answers = {
    block: { result: { header: { height: 4242, hash: "h" } } },
    "query:view_account": {
      result: { amount: "5000000000000000000000000", code_hash: "Hash1", storage_usage: 300 },
    },
    "query:view_access_key_list": {
      result: {
        keys: [
          { public_key: "ed25519:A", access_key: { nonce: 1, permission: "FullAccess" } },
          {
            public_key: "ed25519:B",
            access_key: {
              nonce: 2,
              permission: { FunctionCall: { receiver_id: "v", method_names: [] } },
            },
          },
        ],
      },
    },
    "query:call_function": { result: { result: bytes(CONFIG), logs: [] } },
  };

  it("reads account, keys and get_config at one final block", async () => {
    const { requests, fetchFn } = stubRpc(answers);
    const snapshot = await nearReader("http://rpc", fetchFn).snapshot("v.testnet");
    expect(snapshot).toEqual({
      blockHeight: 4242,
      account: { amount: 5n * 10n ** 24n, codeHash: "Hash1", storageUsage: 300 },
      keys: [
        { publicKey: "ed25519:A", permission: "FullAccess" },
        {
          publicKey: "ed25519:B",
          permission: { FunctionCall: { receiver_id: "v", method_names: [] } },
        },
      ],
      config: CONFIG,
      configError: null,
    });
    expect(requests[0]).toMatchObject({ method: "block", params: { finality: "final" } });
    const queries = requests.slice(1);
    expect(queries.map((q) => q.params)).toEqual([
      { request_type: "view_account", account_id: "v.testnet", block_id: 4242 },
      { request_type: "view_access_key_list", account_id: "v.testnet", block_id: 4242 },
      {
        request_type: "call_function",
        account_id: "v.testnet",
        method_name: "get_config",
        args_base64: Buffer.from("{}").toString("base64"),
        block_id: 4242,
      },
    ]);
  });

  it("reports a failing get_config without failing the snapshot", async () => {
    const { fetchFn } = stubRpc({
      ...answers,
      "query:call_function": {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "CONTRACT_EXECUTION_ERROR" },
          data: "MethodResolveError(MethodNotFound)",
        },
      },
    });
    const snapshot = await nearReader("http://rpc", fetchFn).snapshot("v.testnet");
    expect(snapshot.config).toBeUndefined();
    expect(snapshot.configError).toBe(
      "CONTRACT_EXECUTION_ERROR: MethodResolveError(MethodNotFound)",
    );
  });

  it("answers null for an account that does not exist", async () => {
    const { requests, fetchFn } = stubRpc({
      ...answers,
      "query:view_account": {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_ACCOUNT" },
          data: "account nobody.testnet does not exist while viewing",
        },
      },
    });
    const reader = nearReader("http://rpc", fetchFn);
    expect(await reader.account("nobody.testnet")).toBeNull();
    expect(requests[0]!.params).toEqual({
      request_type: "view_account",
      account_id: "nobody.testnet",
      finality: "final",
    });
    expect((await reader.snapshot("nobody.testnet")).account).toBeNull();
  });

  it("passes on other RPC errors, an HTTP failure and an in-result query error", async () => {
    const internal = stubRpc({ block: { error: { name: "INTERNAL_ERROR", message: "busy" } } });
    await expect(nearReader("http://rpc", internal.fetchFn).snapshot("v")).rejects.toThrow(
      "INTERNAL_ERROR: busy",
    );
    const http = (async () => new Response("", { status: 503 })) as typeof fetch;
    await expect(nearReader("http://rpc", http).networkId()).rejects.toThrow(
      "http://rpc: HTTP 503",
    );
    const old = stubRpc({ "query:view_account": { result: { error: "wasm execution failed" } } });
    await expect(nearReader("http://rpc", old.fetchFn).account("v")).rejects.toThrow(
      "wasm execution failed",
    );
  });

  it("reads the chain id and the storage price", async () => {
    const { requests, fetchFn } = stubRpc({
      status: { result: { chain_id: "mainnet" } },
      EXPERIMENTAL_protocol_config: {
        result: { runtime_config: { storage_amount_per_byte: "10000000000000000000" } },
      },
    });
    const reader = nearReader("http://rpc", fetchFn);
    expect(await reader.networkId()).toBe("mainnet");
    expect(await reader.storagePricePerByte()).toBe(10n ** 19n);
    expect(requests[1]).toMatchObject({ params: { finality: "final" } });
  });
});

/** Decoded borsh keys are plain objects: rebuild the PublicKey to print it. */
const keyString = (decoded: unknown) =>
  new PublicKey({
    keyType: KeyType.ED25519,
    data: Uint8Array.from((decoded as { ed25519Key: { data: ArrayLike<number> } }).ed25519Key.data),
  }).toString();

describe("nearSender", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs one transaction to the account itself with the mapped actions", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest;
      let result: unknown;
      if (body.method === "query") {
        result = {
          nonce: 7,
          permission: "FullAccess",
          block_height: 1,
          block_hash: "11111111111111111111111111111111",
        };
      } else if (body.method === "block") {
        result = { header: { hash: "11111111111111111111111111111111", height: 1 } };
      } else if (body.method === "send_tx") {
        sent.push(String(body.params.signed_tx_base64));
        result = {
          final_execution_status: "EXECUTED_OPTIMISTIC",
          status: { SuccessValue: "" },
          transaction: { hash: "TxHashFromRpc" },
          transaction_outcome: {
            id: "TxHashFromRpc",
            outcome: {
              logs: [],
              receipt_ids: [],
              gas_burnt: 0,
              tokens_burnt: "0",
              executor_id: "v.testnet",
              status: { SuccessValue: "" },
            },
          },
          receipts_outcome: [],
        };
      } else {
        throw new Error(`unexpected RPC ${body.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }));
    });
    const sender = nearSender("http://rpc", "v.testnet", key);
    expect(sender.publicKey).toBe(key.getPublicKey().toString());
    const hash = await sender.send([
      { kind: "deployContract", code: new Uint8Array([0, 97, 115, 109]) },
      { kind: "functionCall", method: "new", args: { a: 1 }, gas: 30n * 10n ** 12n, deposit: 0n },
      { kind: "deleteKey", publicKey: other },
    ]);
    expect(hash).toBe("TxHashFromRpc");
    expect(sent).toHaveLength(1);
    const { transaction } = decodeSignedTransaction(Buffer.from(sent[0]!, "base64"));
    expect(transaction.signerId).toBe("v.testnet");
    expect(transaction.receiverId).toBe("v.testnet");
    expect(keyString(transaction.publicKey)).toBe(key.getPublicKey().toString());
    const [deployAction, call, del] = transaction.actions;
    expect([...deployAction!.deployContract!.code]).toEqual([0, 97, 115, 109]);
    expect(call!.functionCall!.methodName).toBe("new");
    expect(JSON.parse(Buffer.from(call!.functionCall!.args).toString())).toEqual({ a: 1 });
    expect(BigInt(call!.functionCall!.gas)).toBe(30n * 10n ** 12n);
    expect(BigInt(call!.functionCall!.deposit)).toBe(0n);
    expect(keyString(del!.deleteKey!.publicKey)).toBe(other);
  });
});
