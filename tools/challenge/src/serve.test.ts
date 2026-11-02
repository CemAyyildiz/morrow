import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRoundServer } from "./serve.js";
import { InMemoryRoundStore, type RoundRecord } from "./store.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(store: InMemoryRoundStore): Promise<string> {
  const server = createRoundServer(store);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const round = (
  n: number,
  status: RoundRecord["status"],
  fundingHeight: number | null = 300,
): RoundRecord => ({
  round: n,
  status,
  vault_contract: "vault.testnet",
  near_network: "testnet",
  btc_network: "signet",
  failed_step: null,
  last_error: null,
  owner_account: `r${n}.challenge.testnet`,
  owner_account_full_access_key: "ed25519:OPERATOR_ONLY_FULL_ACCESS",
  owner_key: `02${"11".repeat(32)}`,
  owner_key_secret: "aa".repeat(32),
  near_function_call_key: "ed25519:PUBLISHED_FUNCTION_CALL",
  near_function_call_public_key: "ed25519:fcpub",
  function_call_key_added: true,
  vault_id: String(n),
  vault_address: "tb1qvault",
  allowance_address: "tb1qallowance",
  escape_timelock_blocks: 26_280,
  fund_sats: "100000",
  funding_txid: "bb".repeat(32),
  funding_height: fundingHeight,
  rotation_deadline_height: fundingHeight === null ? null : fundingHeight + 21_024,
  opened_at: "2026-11-02T00:00:00.000Z",
  updated_at: "2026-11-02T00:00:00.000Z",
});

describe("GET /round", () => {
  it("is 404 without an open round", async () => {
    const store = new InMemoryRoundStore();
    const base = await serve(store);
    expect((await fetch(`${base}/round`)).status).toBe(404);
    await store.put(round(1, "opening"));
    const response = await fetch(`${base}/round`);
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is 404 with a clear error until the funding confirms", async () => {
    const store = new InMemoryRoundStore();
    await store.put(round(1, "open", null));
    const base = await serve(store);
    const response = await fetch(`${base}/round`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "round 1 funding is not confirmed yet" });
  });

  it("serves exactly the published fields of the open round, with CORS", async () => {
    const store = new InMemoryRoundStore();
    await store.put(round(1, "closed"));
    await store.put(round(2, "open"));
    const base = await serve(store);
    const response = await fetch(`${base}/round`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      round: 2,
      vault_contract: "vault.testnet",
      near_network: "testnet",
      btc_network: "signet",
      vault_id: "2",
      owner_account: "r2.challenge.testnet",
      owner_key: `02${"11".repeat(32)}`,
      owner_key_secret: "aa".repeat(32),
      near_function_call_key: "ed25519:PUBLISHED_FUNCTION_CALL",
      vault_address: "tb1qvault",
      escape_timelock_blocks: 26_280,
      funding_txid: "bb".repeat(32),
      funding_height: 300,
      rotation_deadline_height: 21_324,
    });
    expect(text).not.toContain("OPERATOR_ONLY");
    expect(text).not.toContain("allowance");
  });

  it("answers CORS preflight and 404s everything else", async () => {
    const base = await serve(new InMemoryRoundStore());
    expect((await fetch(`${base}/round`, { method: "OPTIONS" })).status).toBe(204);
    expect((await fetch(`${base}/rounds`)).status).toBe(404);
    expect((await fetch(`${base}/round`, { method: "POST" })).status).toBe(404);
  });

  it("answers 400 to a malformed request target instead of crashing", async () => {
    const base = await serve(new InMemoryRoundStore());
    const { port } = new URL(base);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => (data += String(chunk)));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect((await fetch(`${base}/round`)).status).toBe(404); // still up
  });
});
