import { describe, expect, it, vi } from "vitest";
import { failureKind, txFailure } from "./failure.js";
import { FastNearLocator, type RpcTxStatus } from "./ports.js";
import { TESTNET_CONTRACT, refusedTx } from "./test-fixtures.js";

describe("txFailure", () => {
  it("reads the contract's ERR_* code, failure kind and method from the failing receipt", () => {
    const tx = refusedTx({
      hash: "H1",
      method: "begin_execute",
      args: { op_id: "3" },
      panic: "ERR_CLAWED_BACK",
    });
    expect(txFailure(tx, TESTNET_CONTRACT)).toEqual({
      code: "ERR_CLAWED_BACK",
      failure: "ActionError.FunctionCallError.ExecutionError",
      method: "begin_execute",
    });
  });

  it("gives code null and the raw kind for a failure without an ERR_* code (gas)", () => {
    const tx = refusedTx({ hash: "H2", method: "refresh", args: {}, panic: "x" });
    const gas = {
      ActionError: { index: 0, kind: { FunctionCallError: { HostError: { GasExceeded: {} } } } },
    };
    tx.status = { Failure: gas };
    tx.receipts_outcome[0]!.outcome.status = { Failure: gas };
    expect(txFailure(tx, TESTNET_CONTRACT)).toEqual({
      code: null,
      failure: "ActionError.FunctionCallError.HostError.GasExceeded",
      method: "refresh",
    });
  });

  it("is null for a successful transaction", () => {
    const tx = refusedTx({ hash: "H3", method: "refresh", args: {}, panic: "x" });
    const ok: RpcTxStatus = {
      ...tx,
      status: { SuccessValue: "" },
      receipts_outcome: tx.receipts_outcome.map((o) => ({
        ...o,
        outcome: { ...o.outcome, status: { SuccessValue: "" } },
      })),
    };
    expect(txFailure(ok, TESTNET_CONTRACT)).toBeNull();
  });

  it("is null when an intermediate receipt failed but the transaction succeeded", () => {
    const tx = refusedTx({
      hash: "H4",
      method: "sign_input",
      args: {},
      panic: "ERR_SIGNER_FAILED",
    });
    // The contract receipt failed (and was handled); the final status is a success.
    tx.status = { SuccessValue: "" };
    expect(txFailure(tx, TESTNET_CONTRACT)).toBeNull();
  });

  it("names invalid-transaction kinds without descending into their fields", () => {
    expect(
      failureKind({
        InvalidTxError: {
          InvalidAccessKeyError: {
            NotEnoughAllowance: { account_id: "a", allowance: "1", cost: "2", public_key: "k" },
          },
        },
      }),
    ).toBe("InvalidTxError.InvalidAccessKeyError.NotEnoughAllowance");
  });
});

describe("FastNearLocator.signedBy", () => {
  it("lists signer transactions newest first and stops after the page with a known hash", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const page = body.resume_token === undefined ? ["N3", "N2"] : ["K1", "O0"];
      return Response.json({
        account_txs: page.map((hash, i) => ({
          transaction_hash: hash,
          tx_block_timestamp: String(100 - i),
        })),
        resume_token: "more",
      });
    });
    const locator = new FastNearLocator({
      network: "testnet",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const found = await locator.signedBy("r1.challenge.testnet", (hash) => hash === "K1");
    expect(found.map((t) => t.hash)).toEqual(["N3", "N2", "K1", "O0"]);
    expect(found[0]).toEqual({ hash: "N3", blockTimestampNs: "100" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ account_id: "r1.challenge.testnet", is_signer: true });
    expect(bodies[1]).toMatchObject({ resume_token: "more" });
  });

  it("throws when the indexer is down", async () => {
    const locator = new FastNearLocator({
      network: "testnet",
      fetch: (async () => new Response("", { status: 502 })) as typeof fetch,
    });
    await expect(locator.signedBy("r1.challenge.testnet")).rejects.toThrow(/HTTP 502/);
  });
});
