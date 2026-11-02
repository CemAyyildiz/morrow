import { describe, expect, it } from "vitest";
import { BitcoinBackendError, btcToSats } from "./backend.js";
import { BitcoindRpc } from "./bitcoind-rpc.js";
import { Esplora } from "./esplora.js";
import { backendFromUrl } from "./from-url.js";

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

describe("BitcoindRpc.getSpender", () => {
  const spent = { txid: "aa".repeat(32), vout: 0 };
  const thief = "ee".repeat(32);
  const rpcWith = (spender: Record<string, unknown>, entry: unknown) =>
    new BitcoindRpc(
      "http://127.0.0.1:18443",
      stubFetch((_url, init) => {
        const { method, params } = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        if (method === "gettxspendingprevout") {
          expect(params).toEqual([[spent]]);
          return { body: { result: [{ ...spent, ...spender }], error: null } };
        }
        if (entry === null) {
          return {
            status: 500,
            body: { result: null, error: { code: -5, message: "Transaction not in mempool" } },
          };
        }
        return { body: { result: entry, error: null } };
      }),
    );

  it("returns the mempool spender with its fee rate and descendant fees", async () => {
    const rpc = rpcWith(
      { spendingtxid: thief },
      { vsize: 200, vsize_bip141: 150, fees: { base: 0.0000045, descendant: 0.003 } },
    );
    expect(await rpc.getSpender(spent)).toEqual({
      txid: thief,
      fee_rate_sat_vb: 3,
      fee_sats: "450",
      descendant_fees_sats: "300000",
    });
  });

  it("returns null when unspent, spent in a block or gone from the mempool", async () => {
    expect(await rpcWith({}, {}).getSpender(spent)).toBeNull();
    expect(
      await rpcWith({ spendingtxid: thief, blockhash: "00".repeat(32) }, {}).getSpender(spent),
    ).toBeNull();
    expect(await rpcWith({ spendingtxid: thief }, null).getSpender(spent)).toBeNull();
  });
});

describe("backendFromUrl", () => {
  it("picks Bitcoin Core RPC for URLs with credentials and Esplora otherwise", () => {
    expect(backendFromUrl("http://morrow:morrow@127.0.0.1:18443")).toBeInstanceOf(BitcoindRpc);
    expect(backendFromUrl("https://mempool.space/signet/api")).toBeInstanceOf(Esplora);
  });
});

describe("Esplora.getSpender", () => {
  const funding = "aa".repeat(32);
  const [thief, child, grandchild] = ["e1", "e2", "e3"].map((b) => b.repeat(32)) as [
    string,
    string,
    string,
  ];
  const esplora = (outspend: unknown) =>
    new Esplora(
      "https://esplora.test/api",
      stubFetch((url) => {
        if (url.endsWith(`/tx/${funding}/outspend/1`)) return { body: outspend };
        if (url.endsWith(`/tx/${thief}`)) return { body: { fee: 600, weight: 800 } };
        if (url.endsWith(`/tx/${child}`)) return { body: { fee: 50_000, weight: 440 } };
        if (url.endsWith(`/tx/${grandchild}`)) return { body: { fee: 1_000, weight: 440 } };
        if (url.endsWith(`/tx/${thief}/outspends`)) {
          return {
            body: [{ spent: true, txid: child, status: { confirmed: false } }, { spent: false }],
          };
        }
        if (url.endsWith(`/tx/${child}/outspends`)) {
          return { body: [{ spent: true, txid: grandchild, status: { confirmed: false } }] };
        }
        if (url.endsWith(`/tx/${grandchild}/outspends`)) return { body: [{ spent: false }] };
        return { status: 404, body: "not found" };
      }),
    );

  it("sums the fees of unconfirmed descendants", async () => {
    const spender = await esplora({
      spent: true,
      txid: thief,
      status: { confirmed: false },
    }).getSpender({ txid: funding, vout: 1 });
    expect(spender).toEqual({
      txid: thief,
      fee_rate_sat_vb: 3,
      fee_sats: "600",
      descendant_fees_sats: "51600",
    });
  });

  it("returns null when unspent or spent by a confirmed transaction", async () => {
    expect(await esplora({ spent: false }).getSpender({ txid: funding, vout: 1 })).toBeNull();
    expect(
      await esplora({ spent: true, txid: thief, status: { confirmed: true } }).getSpender({
        txid: funding,
        vout: 1,
      }),
    ).toBeNull();
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
