import { describe, expect, it, vi } from "vitest";
import { MorrowContractError, parseContractError } from "../contract/errors.js";
import { NearContractClient } from "./client.js";
import { createTestnetAccount } from "./faucet.js";

describe("createTestnetAccount", () => {
  it("posts the account and key, retrying failures with backoff", async () => {
    const calls: string[] = [];
    let attempt = 0;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.body));
      attempt++;
      return new Response("", { status: attempt < 3 ? 503 : 200 });
    }) as typeof fetch;
    await createTestnetAccount("judge.testnet", "ed25519:abc", { fetchFn, backoffMs: () => 0 });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[0] ?? "{}")).toEqual({
      newAccountId: "judge.testnet",
      newAccountPublicKey: "ed25519:abc",
    });
  });

  it("fails with the last status after all attempts", async () => {
    const fetchFn = (async () => new Response("", { status: 429 })) as typeof fetch;
    await expect(
      createTestnetAccount("j.testnet", "k", { fetchFn, attempts: 2, backoffMs: () => 0 }),
    ).rejects.toThrow(/HTTP 429/);
  });
});

describe("NEAR error translation", () => {
  it("recognizes contract panics as they arrive from RPC", () => {
    const error = parseContractError(
      "Error: Smart contract panicked: ERR_POLICY_BOUNDS: delay_ns\n    at JsonRpcProvider.sendJsonRpc",
    );
    expect(error).toBeInstanceOf(MorrowContractError);
    expect(error?.code).toBe("ERR_POLICY_BOUNDS");
  });
});

describe("NearContractClient.refresh", () => {
  it("sends `source` only when given", async () => {
    const client = new NearContractClient({ contractId: "vault.testnet", rpcUrl: "http://x" });
    const sent: unknown[] = [];
    vi.spyOn(
      client as unknown as { call: (m: string, a: object) => Promise<unknown> },
      "call",
    ).mockImplementation(async (_method, args) => {
      sent.push(args);
      return {};
    });
    const base = { vault_id: "1", fee_rate_sat_vb: 2, utxos: [], envelope: "ab".repeat(80) };
    await client.refresh(base);
    await client.refresh({ ...base, source: "allowance" });
    expect(sent).toEqual([base, { ...base, source: "allowance" }]);
    expect(Object.hasOwn(sent[0] as object, "source")).toBe(false);
  });
});
