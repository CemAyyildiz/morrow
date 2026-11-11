import { MorrowContractError, XRayInputError } from "@morrow/core-ts/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProofRpc } from "./proof";
import {
  allRows,
  boundFetch,
  contractOver,
  esploraGetTx,
  isLive,
  parseXRayEntry,
  parseXRayPath,
  readXRay,
  senderHint,
  xrayEndpoints,
  xrayInput,
  xrayModel,
  xrayTxPath,
} from "./xray";

import {
  ADDRESS,
  CONTRACT,
  KIT_REF,
  NOW,
  OP_REF,
  SCRIPT,
  SIGN_TX,
  TXID,
  TXID_URL,
  TX_URL,
  input,
  refusedCall,
  signedOp,
  src,
} from "./xray.fixture";

describe("X-Ray routes", () => {
  const hash = "2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD";

  it("parses the form, an op and a refused call; canonicalises the op id", () => {
    expect(parseXRayPath("/xray")).toEqual({ kind: "form" });
    expect(parseXRayPath("/xray/25")).toEqual({ kind: "op", opId: "25" });
    expect(parseXRayPath("/xray/007")).toEqual({ kind: "redirect", to: "/xray/7" });
    expect(parseXRayPath(`/xray/tx/${hash}`)).toEqual({ kind: "tx", hash });
    for (const bad of ["/xray/x", "/xray/tx/abc", "/xray/tx/" + "0".repeat(43), "/proof/7"]) {
      expect(parseXRayPath(bad)).toBeNull();
    }
  });

  it("reads the form's entry as an op id or a NEAR transaction hash", () => {
    expect(parseXRayEntry(" 0025 ")).toBe("/xray/25");
    expect(parseXRayEntry(hash)).toBe(`/xray/tx/${hash}`);
    expect(parseXRayEntry("")).toBeNull();
    expect(parseXRayEntry("op 25")).toBeNull();
  });

  it("names a refused call's signer in the link, and reads it back only when it is an account", () => {
    expect(xrayTxPath(hash)).toBe(`/xray/tx/${hash}`);
    expect(xrayTxPath(hash, "r7.challenge.testnet")).toBe(
      `/xray/tx/${hash}?sender=r7.challenge.testnet`,
    );
    expect(senderHint("?sender=r7.challenge.testnet")).toBe("r7.challenge.testnet");
    expect(senderHint("?sender=Not%20An%20Account")).toBeNull();
    expect(senderHint("")).toBeNull();
    expect(xrayInput({ kind: "tx", hash, sender: null })).toEqual({ refusedTx: { hash } });
    expect(xrayInput({ kind: "tx", hash, sender: "a.testnet" })).toEqual({
      refusedTx: { hash, senderId: "a.testnet" },
    });
    expect(xrayInput({ kind: "op", opId: "25" })).toEqual({ opId: "25" });
  });
});

describe("X-Ray reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    network: { btc: "signet", near: "testnet" } as const,
    contractId: CONTRACT,
    nearRpcUrl: "https://rpc.example",
    nearArchivalRpcUrl: "https://archival.example",
    nearTxIndexerUrl: "https://tx.example",
    btcBackendUrl: "https://btc.example/api",
  };

  it("needs a NEAR network: none on the mock contract or without the archival RPC", () => {
    expect(xrayEndpoints(config)).toEqual({
      contractId: CONTRACT,
      near: "testnet",
      rpcUrl: "https://rpc.example",
      archivalUrl: "https://archival.example",
      indexerUrl: "https://tx.example",
      btcBackendUrl: "https://btc.example/api",
    });
    expect(xrayEndpoints({ ...config, network: { btc: "regtest", near: "mock" } })).toBeNull();
    expect(xrayEndpoints({ ...config, nearArchivalRpcUrl: null })).toBeNull();
    expect(xrayEndpoints({ ...config, nearTxIndexerUrl: null })).toBeNull();
  });

  it("throws the contract's ERR_* on a panic, a read error otherwise", async () => {
    const answers: Record<string, Awaited<ReturnType<ProofRpc["view"]>>> = {
      get_op: {
        kind: "error",
        text: '{"cause":{"name":"CONTRACT_EXECUTION_ERROR"},"data":"Smart contract panicked: ERR_OP_NOT_FOUND"}',
      },
      get_vault_kit: { kind: "unreachable" },
      events_since: { kind: "ok", value: [] },
    };
    const calls: [string, unknown][] = [];
    const rpc: ProofRpc = {
      query: async () => ({ kind: "unreachable" }),
      view: async (method, args) => {
        calls.push([method, args]);
        return answers[method] ?? { kind: "unreachable" };
      },
    };
    const contract = contractOver(rpc);
    const notFound = await contract.getOp("99").catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(MorrowContractError);
    expect((notFound as MorrowContractError).code).toBe("ERR_OP_NOT_FOUND");
    await expect(contract.getVaultKit("29")).rejects.toThrow(/get_vault_kit/);
    expect(await contract.eventsSince("0", 100)).toEqual([]);
    expect(calls).toEqual([
      ["get_op", { op_id: "99" }],
      ["get_vault_kit", { vault_id: "29" }],
      ["events_since", { cursor: "0", limit: 100 }],
    ]);
  });

  it("maps XRayInputError to its message and any other failure to unreachable", async () => {
    const target = { kind: "op", opId: "99" } as const;
    expect(
      await readXRay(target, async () => {
        throw new XRayInputError(`No op 99 on ${CONTRACT}`);
      }),
    ).toEqual({ kind: "input", message: `No op 99 on ${CONTRACT}` });
    expect(
      await readXRay(target, async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toEqual({ kind: "unreachable" });
    const xray = signedOp();
    expect(await readXRay(target, async () => xray)).toEqual({ kind: "ok", xray });
  });

  it("reads a Bitcoin tx's confirmations from Esplora; null when unknown", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      if (url.endsWith(`/tx/${TXID}/status`)) {
        return Response.json({ confirmed: true, block_height: 290_100 });
      }
      if (url.endsWith("/blocks/tip/height")) return new Response("290102");
      if (url.endsWith("/status")) return new Response("not found", { status: 404 });
      return new Response("", { status: 500 });
    });
    const backend = esploraGetTx("https://btc.example/api/", new AbortController().signal);
    expect(await backend.getTx(TXID)).toEqual({
      txid: TXID,
      confirmations: 3,
      block_height: 290_100,
    });
    expect(seen).toEqual([
      `https://btc.example/api/tx/${TXID}/status`,
      "https://btc.example/api/blocks/tip/height",
    ]);
    expect(await backend.getTx("ee".repeat(32))).toBeNull();
  });

  it("a mempool tx has 0 confirmations, an unknown one is null; a backend error throws", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("aa")) {
        return url.endsWith("/status") ? Response.json({ confirmed: false }) : new Response("{}");
      }
      // mempool.space says `{confirmed: false}` for a txid it has never seen, too.
      if (url.includes("cc")) {
        return url.endsWith("/status")
          ? Response.json({ confirmed: false })
          : new Response("Transaction not found", { status: 404 });
      }
      return new Response("down", { status: 503 });
    });
    const backend = esploraGetTx("https://btc.example/api", new AbortController().signal);
    expect(await backend.getTx("aa".repeat(32))).toEqual({
      txid: "aa".repeat(32),
      confirmations: 0,
      block_height: null,
    });
    expect(await backend.getTx("cc".repeat(32))).toBeNull();
    await expect(backend.getTx("bb".repeat(32))).rejects.toThrow(/503/);
  });

  it("binds fetch to the page's signal, and works when called as a method", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("{}");
    });
    const page = new AbortController();
    const holder = { fetchFn: boundFetch(page.signal) };
    const own = new AbortController();
    await holder.fetchFn("https://archival.example", { signal: own.signal });
    await holder.fetchFn("https://archival.example");
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(page.signal);
    expect(signals[0]?.aborted).toBe(false);
    page.abort();
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("X-Ray view model", () => {
  it("a signed, confirmed withdrawal lights all four stages, the last one ok", () => {
    const model = xrayModel(signedOp(), NOW);
    expect(model.stages.map((s) => [s.id, s.status, s.tone])).toEqual([
      ["script", "done", "lit"],
      ["rule", "done", "lit"],
      ["mpc", "done", "lit"],
      ["bitcoin", "done", "ok"],
    ]);
    expect(model.reveal).toBe(4);
    expect(model.live).toBe(false);
    expect(model.chips).toEqual(["op #25", "vault #29"]);
    const [script, rule, mpc, bitcoin] = model.stages;
    expect(script?.headline).toBe("Withdrawal path of the Vault Script");
    expect(rule?.headline).toBe("Accepted · op signed · executable_at 09:30");
    expect(mpc?.headline).toBe("Signed by the NEAR MPC network (11 of 16)");
    expect(bitcoin?.headline).toBe("Confirmed · 3 confirmations");
    expect(bitcoin?.statusText).toBe("confirmed");
  });

  it("every row keeps a non-empty ref and its explorer link", () => {
    const model = xrayModel(signedOp(), NOW);
    const rows = allRows(model);
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) expect(row.ref).not.toBe("");
    const txid = rows.find((r) => r.label === "txid");
    expect(txid).toMatchObject({ value: TXID, url: TXID_URL });
    const tx = model.stages[2]?.groups[0]?.rows.find((r) => r.label === "sign_input transaction");
    expect(tx).toMatchObject({ value: SIGN_TX, url: TX_URL });
    // Times are absolute times of the contract's ns fields.
    expect(rows.find((r) => r.label === "executable_at")?.value).toBe("09:30");
  });

  it("decodes the script in the browser, highlights the op's path, recomputes the address", () => {
    const script = xrayModel(signedOp(), NOW).stages[0];
    expect(script?.script?.bytes).toBe(SCRIPT.length);
    const lines = script?.script?.lines ?? [];
    expect(lines[0]).toMatchObject({ name: "OP_IF", onPath: true });
    expect(lines.filter((l) => l.onPath).length).toBeGreaterThan(2);
    expect(lines.some((l) => l.path === "clawback" && !l.onPath)).toBe(true);
    const recomputed = script?.rows.find((r) => r.label === "Address recomputed in this browser");
    expect(recomputed).toMatchObject({ value: ADDRESS, url: null });
    expect(recomputed?.ref).toBe(`p2wshAddress(${KIT_REF} → vault_script_hex) in this browser`);
    expect(script?.addressMatch).toBe(true);
    // A kit address that differs from the recomputed one says so.
    const tampered = signedOp();
    tampered.script.address = src("tb1qother", `${KIT_REF} → addresses.vault`);
    expect(xrayModel(tampered, NOW).stages[0]?.addressMatch).toBe(false);
  });

  it("lists each stage's distinct sources", () => {
    const mpc = xrayModel(signedOp(), NOW).stages[2];
    expect(new Set(mpc?.sources).size).toBe(mpc?.sources.length);
    expect(mpc?.sources).toContain(`${OP_REF} → sighashes[1]`);
    const script = xrayModel(signedOp(), NOW).stages[0];
    expect(script?.sources.at(-1)).toBe(
      `decodeScript(${KIT_REF} → vault_script_hex) in this browser`,
    );
  });

  it("drops the T of N when the signer's state could not be read", () => {
    const xray = signedOp();
    xray.mpc.inputs = [input(0, { threshold: null }), input(1, { participants: null })];
    expect(xrayModel(xray, NOW).stages[2]?.headline).toBe("Signed by the NEAR MPC network");
  });

  it("a pending withdrawal: stages 1-2 lit, 3-4 not reached, and it reads again", () => {
    const xray = signedOp();
    xray.rule.opState = src("pending", `${OP_REF} → state`);
    xray.mpc = { status: "not_reached", inputs: [] };
    xray.bitcoin = { status: "not_reached", txid: null, confirmations: null, blockHeight: null };
    const model = xrayModel(xray, NOW);
    expect(model.stages.map((s) => s.tone)).toEqual(["lit", "lit", "unreached", "unreached"]);
    expect(model.stages[2]?.headline).toBe("not reached");
    expect(model.stages[1]?.headline).toBe("Accepted · op pending · executable_at 09:30");
    expect(model.reveal).toBe(4);
    expect(model.live).toBe(true);
    expect(isLive(xray)).toBe(true);
  });

  it("stops the reveal at the first stage still waiting", () => {
    const xray = signedOp();
    xray.rule.opState = src("frozen", `${OP_REF} → state`);
    xray.mpc = { status: "pending", inputs: [input(0, { status: "pending", signature: null })] };
    xray.bitcoin = { ...xray.bitcoin, status: "pending", confirmations: null, blockHeight: null };
    const model = xrayModel(xray, NOW);
    expect(model.reveal).toBe(3);
    expect(model.stages[2]).toMatchObject({ tone: "waiting", statusText: "waiting" });
    expect(model.stages[2]?.headline).toBe("Waiting for the NEAR MPC network");
    expect(model.stages[3]?.headline).toBe("Built by the contract, waiting for its signatures");
    expect(model.live).toBe(true);
  });

  it("a refused call: stage 2 alarm with the code, gloss and the values it was judged on", () => {
    const model = xrayModel(refusedCall(), NOW);
    const rule = model.stages[1];
    expect(rule).toMatchObject({ status: "refused", tone: "alarm", statusText: "refused" });
    expect(rule?.headline).toBe(
      "ERR_NOT_EXECUTABLE · The Delay has not passed yet. The Withdrawal Request is still pending.",
    );
    expect(rule?.detail).toBe("executable_at 10:30 · block 08:30 → ERR_NOT_EXECUTABLE");
    const labels = Object.fromEntries((rule?.rows ?? []).map((r) => [r.label, r]));
    expect(labels.Method).toMatchObject({ value: "begin_execute" });
    expect(labels["Block time"]?.value).toBe("08:30");
    expect(labels["executable_at when judged"]?.value).toBe("10:30");
    expect(labels["NEAR transaction"]?.url).toBe("https://testnet.nearblocks.io/txns/H");
    expect(model.stages.slice(2).map((s) => s.headline)).toEqual(["not reached", "not reached"]);
    expect(model.live).toBe(false);
  });

  it("a voided op names the Clawback that voided it", () => {
    const xray = signedOp();
    xray.rule.opState = src("voided", `${OP_REF} → state`);
    xray.rule.voidedBy = src("31", "events_since … → [5].data.by_op_id");
    expect(xrayModel(xray, NOW).stages[1]?.headline).toBe("Voided by Clawback op 31");
  });

  it("a failed kit read or Bitcoin read turns its stage to alarm", () => {
    const xray = signedOp();
    xray.script = { ...xray.script, status: "failed", scriptHex: null, address: null };
    xray.bitcoin = { status: "failed", txid: null, confirmations: null, blockHeight: null };
    const model = xrayModel(xray, NOW);
    expect(model.stages[0]).toMatchObject({
      tone: "alarm",
      headline: "The Vault Kit could not be read",
    });
    expect(model.stages[3]).toMatchObject({
      tone: "alarm",
      headline: "The Bitcoin transaction could not be read",
    });
  });
});
