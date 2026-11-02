import { describe, expect, it } from "vitest";
import { BitcoinBackendError, btcToSats } from "./backend.js";
import { BitcoindRpc } from "./bitcoind-rpc.js";
import { Esplora } from "./esplora.js";

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function stubFetch(route: Route): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { status = 200, body } = route(String(input), init);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  }) as typeof fetch;
}

describe("btcToSats", () => {
  it("converts without floating-point drift", () => {
    expect(btcToSats(0.1)).toBe("10000000");
    expect(btcToSats(50)).toBe("5000000000");
    expect(btcToSats("0.00000001")).toBe("1");
    expect(btcToSats(0.29999999)).toBe("29999999");
  });
});

describe("BitcoindRpc", () => {
  it("sends basic auth and maps scantxoutset to UTXOs", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    const rpc = new BitcoindRpc(
      "http://morrow:secret@127.0.0.1:18443",
      stubFetch((url, init) => {
        seenUrl = url;
        seenAuth = new Headers(init?.headers).get("authorization");
        return {
          body: {
            result: { unspents: [{ txid: "aa".repeat(32), vout: 1, amount: 1.5, height: 102 }] },
            error: null,
          },
        };
      }),
    );
    const utxos = await rpc.getUtxos("bcrt1qexample");
    expect(seenUrl).toBe("http://127.0.0.1:18443/");
    expect(seenAuth).toBe(`Basic ${btoa("morrow:secret")}`);
    expect(utxos).toEqual([
      { txid: "aa".repeat(32), vout: 1, value_sats: "150000000", height: 102 },
    ]);
  });

  it("raises BitcoinBackendError with the node message", async () => {
    const rpc = new BitcoindRpc(
      "http://127.0.0.1:18443",
      stubFetch(() => ({
        status: 500,
        body: { result: null, error: { code: -26, message: "bad-txns" } },
      })),
    );
    await expect(rpc.broadcast("00")).rejects.toThrow(BitcoinBackendError);
    await expect(rpc.broadcast("00")).rejects.toThrow(/bad-txns/);
  });

  it("returns null for an unknown transaction", async () => {
    const rpc = new BitcoindRpc(
      "http://127.0.0.1:18443",
      stubFetch(() => ({
        status: 500,
        body: {
          result: null,
          error: { code: -5, message: "No such mempool or blockchain transaction." },
        },
      })),
    );
    expect(await rpc.getTx("bb".repeat(32))).toBeNull();
  });
});

describe("Esplora", () => {
  const txid = "cc".repeat(32);
  const esplora = new Esplora(
    "https://mempool.space/signet/api/",
    stubFetch((url, init) => {
      if (url.endsWith("/address/tb1qexample/utxo")) {
        return {
          body: [
            { txid, vout: 0, value: 25000, status: { confirmed: true, block_height: 200 } },
            { txid, vout: 1, value: 1000, status: { confirmed: false } },
          ],
        };
      }
      if (url.endsWith("/blocks/tip/height")) return { body: "209" };
      if (url.endsWith(`/tx/${txid}/status`))
        return { body: { confirmed: true, block_height: 200 } };
      if (url.endsWith("/tx") && init?.method === "POST") return { body: `${txid}\n` };
      return { status: 404, body: "Transaction not found" };
    }),
  );

  it("maps UTXOs, tip height and confirmations", async () => {
    expect(await esplora.getUtxos("tb1qexample")).toEqual([
      { txid, vout: 0, value_sats: "25000", height: 200 },
      { txid, vout: 1, value_sats: "1000", height: null },
    ]);
    expect(await esplora.getTipHeight()).toBe(209);
    expect(await esplora.getTx(txid)).toEqual({ txid, confirmations: 10, block_height: 200 });
  });

  it("broadcasts and returns the txid", async () => {
    expect(await esplora.broadcast("0200")).toBe(txid);
  });

  it("returns null for an unknown transaction and raises on other errors", async () => {
    expect(await esplora.getTx("dd".repeat(32))).toBeNull();
    await expect(esplora.getUtxos("tb1qmissing")).rejects.toThrow(/HTTP 404/);
  });
});
