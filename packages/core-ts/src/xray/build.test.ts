import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../contract/errors.js";
import type { MorrowEvent } from "../contract/events.js";
import type { MockContractClient } from "../contract/mock.js";
import { DESTINATION, EMMA, ENVELOPE, setup, utxo } from "../contract/test-fixtures.js";
import type { SpendOp, U64, VaultKit } from "../contract/types.js";
import { NearContractClient } from "../near/client.js";
import { RECEIPTS_UNAVAILABLE, buildXRay, type XRayDeps } from "./build.js";
import { bitcoinTxUrl, nearTxUrl } from "./links.js";
import {
  FastNearLocator,
  FetchNearRpc,
  NearRpcError,
  chainLocators,
  decodeBase64,
  hintLocator,
  type TxLocator,
} from "./ports.js";
import {
  FakeBitcoin,
  FakeNearRpc,
  OP25,
  OP25_INPUT0_TX,
  OP25_SIGN_TX,
  OP25_TXID,
  TESTNET_CONTRACT,
  TESTNET_SENDER,
  TESTNET_SIGNER,
  refusedTx,
  signInputTx,
  signerState,
} from "./test-fixtures.js";
import { XRayInputError, type Sourced, type XRay } from "./types.js";

const FEE_SATS = "754";

/** Contract views over the mock, with real tx bytes (for a real txid) and the live `fee_sats`. */
function contractView(mock: MockContractClient): XRayDeps["contract"] {
  return {
    async getOp(opId) {
      const op = await mock.getOp(opId);
      if (op.unsigned_tx_hex !== null) op.unsigned_tx_hex = OP25.unsigned_tx_hex;
      return op;
    },
    getVaultKit: (vaultId) => mock.getVaultKit(vaultId),
    async eventsSince(cursor, limit) {
      return (await mock.eventsSince(cursor, limit)).map((e) =>
        e.kind === "op_frozen"
          ? ({ ...e, data: { ...e.data, fee_sats: FEE_SATS } } as MorrowEvent)
          : e,
      );
    },
  };
}

/** `opAt` patches `get_op` results viewed at a given block. */
function fakeRpc(mock: MockContractClient, opAt: Map<string, Partial<SpendOp>>): FakeNearRpc {
  return new FakeNearRpc(async (account, method, args, blockHash) => {
    if (account === TESTNET_SIGNER && method === "state") return signerState();
    if (account === TESTNET_CONTRACT && method === "get_config") {
      return { signer_account: TESTNET_SIGNER, version: "0.1.0" };
    }
    if (account === TESTNET_CONTRACT && method === "get_op") {
      const op = await mock.getOp((args as { op_id: U64 }).op_id);
      return { ...op, ...(blockHash === undefined ? {} : opAt.get(blockHash)) };
    }
    throw new NearRpcError(`no view ${account}.${method}`, null);
  });
}

interface World {
  mock: MockContractClient;
  vaultId: U64;
  rpc: FakeNearRpc;
  bitcoin: FakeBitcoin;
  log: ReturnType<typeof vi.fn>;
  opAt: Map<string, Partial<SpendOp>>;
  deps(locator?: TxLocator): XRayDeps;
}

async function world(): Promise<World> {
  const { mock, vaultId } = await setup();
  const opAt = new Map<string, Partial<SpendOp>>();
  const rpc = fakeRpc(mock, opAt);
  const bitcoin = new FakeBitcoin();
  const log = vi.fn();
  return {
    mock,
    vaultId,
    rpc,
    bitcoin,
    log,
    opAt,
    deps: (locator = hintLocator([])) => ({
      contract: contractView(mock),
      contractId: TESTNET_CONTRACT,
      nearNetwork: "testnet",
      rpc,
      locator,
      bitcoin,
      log,
    }),
  };
}

async function requestWithdrawal(w: World, inputs = [1, 2]): Promise<U64> {
  return w.mock.requestWithdrawal({
    vault_id: w.vaultId,
    amount_sats: "500000",
    destination: DESTINATION,
    fee_rate_sat_vb: 2,
    utxos: inputs.map((n) => utxo(n)),
    envelope: ENVELOPE,
  });
}

async function executable(w: World, opId: U64): Promise<SpendOp> {
  const vault = await w.mock.getVault(w.vaultId);
  w.mock.advance(BigInt(vault.policy.delay_ns));
  return w.mock.beginExecute(opId, ENVELOPE);
}

/** Signs inputs on the mock and records each `sign_input` tree in the fake RPC. */
async function sign(w: World, opId: U64, indexes: number[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const index of indexes) await w.mock.signInput(opId, index);
  const op = await w.mock.getOp(opId);
  for (const index of indexes) {
    const hash = `Tx${opId}x${index}`;
    w.rpc.add(
      signInputTx({
        hash,
        opId,
        inputIndex: index,
        vaultId: w.vaultId,
        payload: op.sighashes[index]!,
        signature: op.signatures[index]!,
      }),
    );
    hashes.push(hash);
  }
  return hashes;
}

const hints = (hashes: string[]) =>
  hintLocator(hashes.map((hash) => ({ hash, senderId: TESTNET_SENDER })));

/** Paths of leaves that are not `Sourced` with a non-empty ref (`status`/`note` are labels). */
function unsourcedLeaves(value: unknown, path = "$"): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => unsourcedLeaves(v, `${path}[${i}]`));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record && "source" in record) {
      const source = record.source as { ref?: unknown; url?: unknown };
      const ok =
        typeof source.ref === "string" &&
        source.ref.length > 0 &&
        (source.url === null || typeof source.url === "string");
      return ok ? [] : [path];
    }
    return Object.entries(record).flatMap(([key, v]) =>
      key === "status" || key === "note" ? [] : unsourcedLeaves(v, `${path}.${key}`),
    );
  }
  return [path];
}

function expectAllSourced(xray: XRay): void {
  expect(unsourcedLeaves(xray)).toEqual([]);
}

const v = <T>(s: Sourced<T> | null | undefined): T | undefined => s?.value;

describe("buildXRay: ops", () => {
  it("signed withdrawal: all four stages with real identifiers", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0, 1]);
    w.bitcoin.txs.set(OP25_TXID, { txid: OP25_TXID, confirmations: 3, block_height: 812 });
    const op = await w.mock.getOp(opId);
    const kit = await w.mock.getVaultKit(w.vaultId);

    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expectAllSourced(xray);

    expect(xray.script.status).toBe("done");
    expect(v(xray.script.path)).toBe("withdrawal");
    expect(v(xray.script.scriptHex)).toBe(kit.vault_script_hex);
    expect(v(xray.script.template)).toEqual(op.witness_template);
    expect(xray.script.path?.source.ref).toContain("get_op");

    expect(xray.rule.status).toBe("done");
    const kinds = xray.rule.events.map((e) => e.kind.value);
    expect(kinds).toEqual([
      "withdrawal_requested",
      "op_frozen",
      "input_signed",
      "input_signed",
      "op_signed",
    ]);
    expect(v(xray.rule.events[0]!.facts.executable_at)).toBe(op.executable_at);
    expect(v(xray.rule.executableAt)).toBe(op.executable_at);
    expect(v(xray.rule.feeSats)).toBe(FEE_SATS);
    expect(xray.rule.refusal).toBeNull();

    expect(xray.mpc.status).toBe("done");
    expect(xray.mpc.inputs).toHaveLength(2);
    for (const [i, input] of xray.mpc.inputs.entries()) {
      expect(input.status).toBe("done");
      expect(v(input.domainId)).toBe(0);
      expect(v(input.path)).toBe(`morrow/v1/${w.vaultId}/vault`);
      expect(v(input.signer)).toBe(TESTNET_SIGNER);
      expect(v(input.sighash)).toBe(op.sighashes[i]);
      expect(v(input.payload)).toBe(op.sighashes[i]);
      expect(v(input.signReceiptId)).toBe(`${hashes[i]}-sign`);
      expect(v(input.responseReceiptId)).toBe(`${hashes[i]}-response`);
      expect(v(input.callbackReceiptId)).toBe(`${hashes[i]}-callback`);
      expect(v(input.signature)).toBe(op.signatures[i]);
      expect(v(input.callbackValue)).toBe(op.signatures[i]);
      expect(v(input.participants)).toBe(16);
      expect(v(input.threshold)).toBe(11);
      expect(v(input.protocol)).toBe("CaitSith");
      expect(input.txHash?.source.url).toBe(`https://testnet.nearblocks.io/txns/${hashes[i]}`);
      expect(input.note).toBeNull();
    }
    expect(w.rpc.calls).toContain(`view ${TESTNET_SIGNER} state ${hashes[0]}-sign-block`);

    expect(xray.bitcoin.status).toBe("done");
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
    expect(v(xray.bitcoin.confirmations)).toBe(3);
    expect(xray.bitcoin.txid?.source.url).toBe(`https://mempool.space/signet/tx/${OP25_TXID}`);
  });

  it("pending withdrawal: rule done with executable_at, MPC and Bitcoin not reached", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    const xray = await buildXRay({ opId }, w.deps());
    expectAllSourced(xray);
    expect(xray.script.status).toBe("done");
    expect(v(xray.script.path)).toBe("withdrawal");
    expect(xray.rule.status).toBe("done");
    expect(v(xray.rule.executableAt)).toBe((await w.mock.getOp(opId)).executable_at);
    expect(xray.rule.events.map((e) => e.kind.value)).toEqual(["withdrawal_requested"]);
    expect(xray.mpc).toEqual({ status: "not_reached", inputs: [] });
    expect(xray.bitcoin.status).toBe("not_reached");
    expect(xray.bitcoin.txid).toBeNull();
  });

  it("voided by Clawback: the void is listed with voidedBy", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    const clawbackId = await w.mock
      .asCaller(EMMA)
      .beginClawback({ vault_id: w.vaultId, utxos: [utxo(9)], fee_rate_sat_vb: 2 });
    const xray = await buildXRay({ opId }, w.deps());
    expectAllSourced(xray);
    expect(xray.rule.events.map((e) => e.kind.value)).toEqual([
      "withdrawal_requested",
      "op_voided",
    ]);
    expect(v(xray.rule.voidedBy)).toBe(clawbackId);
    expect(v(xray.rule.opState)).toBe("voided");
    expect(xray.mpc.status).toBe("not_reached");
    expect(xray.bitcoin.status).toBe("not_reached");
  });

  it("clawback op: clawback path from the frozen template", async () => {
    const w = await world();
    await requestWithdrawal(w);
    const clawbackId = await w.mock
      .asCaller(EMMA)
      .beginClawback({ vault_id: w.vaultId, utxos: [utxo(9)], fee_rate_sat_vb: 2 });
    const find = vi.fn(async () => []);
    const xray = await buildXRay({ opId: clawbackId }, w.deps({ find }));
    expectAllSourced(xray);
    expect(v(xray.script.path)).toBe("clawback");
    expect(xray.rule.events.map((e) => e.kind.value)).toEqual(["vault_clawed_back", "op_frozen"]);
    expect(xray.mpc.status).toBe("pending");
    expect(xray.mpc.inputs[0]!.note).toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect(xray.bitcoin.status).toBe("pending");
  });

  it("partly signed: MPC pending, Bitcoin txid pending without a backend lookup", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0]);
    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expectAllSourced(xray);
    expect(xray.mpc.status).toBe("pending");
    expect(xray.mpc.inputs.map((i) => i.status)).toEqual(["done", "pending"]);
    expect(xray.mpc.inputs[1]!.signature).toBeNull();
    expect(xray.mpc.inputs[1]!.note).toBeNull();
    expect(xray.bitcoin.status).toBe("pending");
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
    expect(w.bitcoin.calls).toEqual([]);
  });

  it("not broadcast: Bitcoin txid pending when getTx returns null", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0, 1]);
    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expect(xray.mpc.status).toBe("done");
    expect(xray.bitcoin.status).toBe("pending");
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
    expect(xray.bitcoin.confirmations).toBeNull();
    expect(w.bitcoin.calls).toEqual([OP25_TXID]);
  });

  it("in the mempool: confirmations 0 stays pending", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0, 1]);
    w.bitcoin.txs.set(OP25_TXID, { txid: OP25_TXID, confirmations: 0, block_height: null });
    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expect(xray.bitcoin.status).toBe("pending");
    expect(v(xray.bitcoin.confirmations)).toBe(0);
  });

  it("no hash found: signatures from get_op, receipt ids null, receipts unavailable", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await sign(w, opId, [0, 1]);
    const op = await w.mock.getOp(opId);
    const xray = await buildXRay({ opId }, w.deps(chainLocators(hintLocator([]), hintLocator([]))));
    expectAllSourced(xray);
    expect(xray.mpc.status).toBe("done");
    for (const [i, input] of xray.mpc.inputs.entries()) {
      expect(v(input.signature)).toBe(op.signatures[i]);
      expect(input.signReceiptId).toBeNull();
      expect(input.responseReceiptId).toBeNull();
      expect(input.callbackReceiptId).toBeNull();
      expect(input.note).toBe(RECEIPTS_UNAVAILABLE);
      expect(v(input.signer)).toBe(TESTNET_SIGNER);
      expect(input.signer?.source.ref).toContain("get_config");
    }
    expect(w.log).not.toHaveBeenCalled();
  });

  it("indexer error: same result, logged", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await sign(w, opId, [0, 1]);
    const broken: TxLocator = {
      find: async () => {
        throw new Error("FastNEAR /v0/account: HTTP 429");
      },
    };
    const xray = await buildXRay({ opId }, w.deps(chainLocators(hintLocator([]), broken)));
    expect(xray.mpc.inputs.map((i) => i.note)).toEqual([
      RECEIPTS_UNAVAILABLE,
      RECEIPTS_UNAVAILABLE,
    ]);
    expect(xray.mpc.inputs.every((i) => i.signReceiptId === null)).toBe(true);
    expect(w.log).toHaveBeenCalledWith(expect.stringContaining(opId), expect.any(Error));
  });

  it("cross-check: a sign payload that differs from get_op fails the input and is not fixed", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await w.mock.signInput(opId, 0);
    const op = await w.mock.getOp(opId);
    w.rpc.add(
      signInputTx({
        hash: "Forged",
        opId,
        inputIndex: 0,
        vaultId: w.vaultId,
        payload: "ff".repeat(32),
        signature: op.signatures[0]!,
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Forged"])));
    const input = xray.mpc.inputs[0]!;
    expect(input.status).toBe("failed");
    expect(v(input.payload)).toBe("ff".repeat(32));
    expect(v(input.sighash)).toBe(op.sighashes[0]);
    expect(xray.mpc.status).toBe("failed");
  });

  it("cross-check: an on_signed value that differs from get_op fails the input", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await w.mock.signInput(opId, 0);
    const op = await w.mock.getOp(opId);
    w.rpc.add(
      signInputTx({
        hash: "Swapped",
        opId,
        inputIndex: 0,
        vaultId: w.vaultId,
        payload: op.sighashes[0]!,
        signature: op.signatures[0]!,
        callbackValue: "02".padEnd(130, "e"),
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Swapped"])));
    expect(xray.mpc.inputs[0]!.status).toBe("failed");
    expect(v(xray.mpc.inputs[0]!.callbackValue)).toBe("02".padEnd(130, "e"));
    expect(v(xray.mpc.inputs[0]!.signature)).toBe(op.signatures[0]);
  });

  it("hints for other ops or methods are read and ignored", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await sign(w, opId, [0, 1]);
    w.rpc.add(
      refusedTx({
        hash: "Other",
        method: "cancel",
        args: { op_id: opId },
        panic: "ERR_BAD_OP_STATE",
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Other", "Missing"])));
    expect(xray.mpc.inputs.every((i) => i.note === RECEIPTS_UNAVAILABLE)).toBe(true);
    expect(w.log).toHaveBeenCalledWith(
      expect.stringContaining("Missing"),
      expect.any(NearRpcError),
    );
  });

  it("finds the op's events behind a long log (gallop + binary search, then pages of 100)", async () => {
    const w = await world();
    for (let i = 0; i < 230; i++) {
      await w.mock.topUpStorage(w.vaultId, "1");
      w.mock.advance(1n);
    }
    const opId = await requestWithdrawal(w);
    const spy = vi.spyOn(w.mock, "eventsSince");
    const xray = await buildXRay({ opId }, w.deps());
    expect(xray.rule.events.map((e) => e.kind.value)).toEqual(["withdrawal_requested"]);
    expect(xray.rule.events[0]!.seq.value).toBe("233");
    expect(spy.mock.calls.length).toBeLessThan(25);
    expect(spy.mock.calls.filter(([, limit]) => limit === 100)).toHaveLength(1);
  });

  it("op 25 input 0: real ids, sighash, path and sign block in a synthetic tree", async () => {
    const rpc = new FakeNearRpc(async (account, method) =>
      account === TESTNET_SIGNER && method === "state" ? signerState() : null,
    ).add(OP25_INPUT0_TX);
    const kit = {
      btc_network: "regtest",
      vault_script_hex: "6321020b6c",
      allowance_script_hex: "6321020b6d",
      addresses: { vault: "bcrt1qvault", allowance: "bcrt1qallow" },
      witness_templates: {},
    } as unknown as VaultKit;
    const xray = await buildXRay(
      { opId: "25" },
      {
        contract: {
          getOp: async () => structuredClone(OP25),
          getVaultKit: async () => kit,
          eventsSince: async () => [],
        },
        contractId: TESTNET_CONTRACT,
        nearNetwork: "testnet",
        rpc,
        locator: hintLocator([{ hash: OP25_SIGN_TX, senderId: TESTNET_SENDER }]),
        bitcoin: new FakeBitcoin(),
        log: () => {},
      },
    );
    expectAllSourced(xray);
    const input = xray.mpc.inputs[0]!;
    expect(input.status).toBe("done");
    expect(v(input.sighash)).toBe(
      "ddb6d4436c2f4454d6d315cce9a537a4b6ade98f1c1f59c97e5819f65ca058e2",
    );
    expect(v(input.path)).toBe("morrow/v1/29/vault");
    expect(v(input.signer)).toBe(TESTNET_SIGNER);
    expect(v(input.signReceiptId)).toBe("ELNqtFfutMEWhjDwHbcgMgMBQ49gXWU87vSnYEjDwYXa");
    expect(v(input.callbackReceiptId)).toBe("CiEd7fYkXkzgGEcLpHw76cVW8vG4uzL9VyiD3gXs8UPh");
    expect([v(input.threshold), v(input.participants)]).toEqual([11, 16]);
    expect(rpc.calls).toContain(
      `view ${TESTNET_SIGNER} state 7ZC9L8JVi7m25vC2JrbqkEaVy48DHv2Kv6xG6obSpCUH`,
    );
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
    expect(xray.bitcoin.txid?.source.url).toBeNull();
  });
});

describe("buildXRay: ops, partial failures", () => {
  it("getTx rejects: Bitcoin stage failed, txid kept, logged", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0, 1]);
    w.bitcoin.getTx = async () => {
      throw new Error("esplora down");
    };
    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expect(xray.bitcoin.status).toBe("failed");
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
    expect(xray.mpc.status).toBe("done");
    expect(w.log).toHaveBeenCalledWith(expect.stringContaining(OP25_TXID), expect.any(Error));
  });

  it("caps the event scan, logs it and keeps what was found", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    for (let i = 0; i < 250; i++) await w.mock.topUpStorage(w.vaultId, "1");
    await w.mock.cancel(opId, ENVELOPE);
    const capped = await buildXRay({ opId }, { ...w.deps(), maxEventPages: 2 });
    expect(capped.rule.events.map((e) => e.kind.value)).toEqual(["withdrawal_requested"]);
    expect(w.log).toHaveBeenCalledWith(expect.stringContaining("2 event pages"), undefined);
    const full = await buildXRay({ opId }, w.deps());
    expect(full.rule.events.map((e) => e.kind.value)).toEqual([
      "withdrawal_requested",
      "withdrawal_cancelled",
    ]);
  });

  it("signing landed between the reads: on_signed value without a stored signature stays pending", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [1]);
    const op = await w.mock.getOp(opId);
    const late = `02${"ab".repeat(64)}`;
    w.rpc.add(
      signInputTx({
        hash: "Late0",
        opId,
        inputIndex: 0,
        vaultId: w.vaultId,
        payload: op.sighashes[0]!,
        signature: late,
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Late0", ...hashes])));
    const input = xray.mpc.inputs[0]!;
    expect(input.status).toBe("pending");
    expect(input.signature).toBeNull();
    expect(v(input.callbackValue)).toBe(late);
    expect(input.note).toBeNull();
    expect(xray.mpc.status).toBe("pending");
  });

  it("a failed attempt before the successful one: receipts come from the successful one", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0, 1]);
    const op = await w.mock.getOp(opId);
    w.rpc.add(
      signInputTx({
        hash: "Fail0",
        opId,
        inputIndex: 0,
        vaultId: w.vaultId,
        payload: op.sighashes[0]!,
        signature: op.signatures[0]!,
        failed: true,
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Fail0", ...hashes])));
    const input = xray.mpc.inputs[0]!;
    expect(input.status).toBe("done");
    expect(v(input.txHash)).toBe(hashes[0]);
    expect(v(input.signReceiptId)).toBe(`${hashes[0]}-sign`);
    expect(v(input.callbackReceiptId)).toBe(`${hashes[0]}-callback`);
    expect(input.note).toBeNull();
  });

  it("only a failed attempt for a stored signature: done, receipts unavailable", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    await w.mock.signInput(opId, 0);
    const op = await w.mock.getOp(opId);
    w.rpc.add(
      signInputTx({
        hash: "Fail0",
        opId,
        inputIndex: 0,
        vaultId: w.vaultId,
        payload: op.sighashes[0]!,
        signature: op.signatures[0]!,
        failed: true,
      }),
    );
    const xray = await buildXRay({ opId }, w.deps(hints(["Fail0"])));
    const input = xray.mpc.inputs[0]!;
    expect(input.status).toBe("done");
    expect(input.callbackReceiptId).toBeNull();
    expect(input.note).toBe(RECEIPTS_UNAVAILABLE);
    expect(v(input.signature)).toBe(op.signatures[0]);
  });

  it("voided while executing: signed input done, the rest not reached, Bitcoin not reached", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await executable(w, opId);
    const hashes = await sign(w, opId, [0]);
    await w.mock
      .asCaller(EMMA)
      .beginClawback({ vault_id: w.vaultId, utxos: [utxo(9)], fee_rate_sat_vb: 2 });
    const xray = await buildXRay({ opId }, w.deps(hints(hashes)));
    expectAllSourced(xray);
    expect(v(xray.rule.opState)).toBe("voided");
    expect(xray.mpc.inputs.map((i) => i.status)).toEqual(["done", "not_reached"]);
    expect(xray.bitcoin.status).toBe("not_reached");
    expect(v(xray.bitcoin.txid)).toBe(OP25_TXID);
  });

  it("get_vault_kit fails: script stage failed", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    const deps = w.deps();
    deps.contract = {
      ...deps.contract,
      getVaultKit: async () => {
        throw new Error("rpc down");
      },
    };
    const xray = await buildXRay({ opId }, deps);
    expect(xray.script.status).toBe("failed");
    expect(v(xray.script.path)).toBe("withdrawal");
    expect(xray.script.scriptHex).toBeNull();
    expect(xray.btcNetwork).toBeNull();
  });

  it("a kit without the path's template: template null", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    const deps = w.deps();
    const kit = await w.mock.getVaultKit(w.vaultId);
    deps.contract = {
      ...deps.contract,
      getVaultKit: async () => ({ ...kit, witness_templates: {} as VaultKit["witness_templates"] }),
    };
    const xray = await buildXRay({ opId }, deps);
    expect(xray.script.status).toBe("done");
    expect(xray.script.template).toBeNull();
    expectAllSourced(xray);
  });
});

describe("buildXRay: refused calls", () => {
  it("ERR_NOT_EXECUTABLE: code, gloss, method, args, executable_at and the block's timestamp", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    const op = await w.mock.getOp(opId);
    const args = { op_id: opId, envelope: ENVELOPE };
    w.rpc.add(
      refusedTx({
        hash: "Early",
        method: "begin_execute",
        args,
        panic: "ERR_NOT_EXECUTABLE",
        blockHash: "B1",
      }),
    );
    w.rpc.headers.set("B1", {
      hash: "B1",
      prevHash: "P1",
      height: 100,
      timestampNs: "1767225700000000000",
    });
    // The failing block's own state (and final) differ from its parent's: facts must use the parent.
    w.opAt.set("P1", { executable_at: "1767225750000000000", state: "pending" });
    w.opAt.set("B1", { executable_at: "1", state: "cancelled" });

    const xray = await buildXRay(
      { refusedTx: { hash: "Early", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    expectAllSourced(xray);
    expect(xray.rule.status).toBe("refused");
    const refusal = xray.rule.refusal!;
    expect(v(refusal.code)).toBe("ERR_NOT_EXECUTABLE");
    expect(v(refusal.gloss)).toBe(ERROR_CODES.ERR_NOT_EXECUTABLE);
    expect(v(refusal.method)).toBe("begin_execute");
    expect(v(refusal.args)).toEqual(args);
    expect(v(refusal.receiptId)).toBe("Early-receipt");
    expect(op.executable_at).not.toBe("1767225750000000000");
    expect(v(refusal.facts.executableAt)).toBe("1767225750000000000");
    expect(refusal.facts.executableAt?.source.ref).toContain("block_id=P1");
    expect(w.rpc.calls).toContain(`view ${TESTNET_CONTRACT} get_op P1`);
    expect(w.rpc.calls.filter((c) => c.includes("get_op"))).toEqual([
      `view ${TESTNET_CONTRACT} get_op P1`,
    ]);
    expect(v(refusal.facts.blockTimestamp)).toBe("1767225700000000000");
    expect(v(refusal.facts.opState)).toBe("pending");
    expect(refusal.method.source.ref).toContain("receipts[receipt_id=Early-receipt].method_name");
    expect(refusal.code.source.url).toBe(nearTxUrl("testnet", "Early"));

    expect(v(xray.opId)).toBe(opId);
    expect(v(xray.script.path)).toBe("withdrawal");
    expect(xray.script.status).toBe("done");
    expect(xray.mpc).toEqual({ status: "not_reached", inputs: [] });
    expect(xray.bitcoin.status).toBe("not_reached");
  });

  it("ERR_CLAWED_BACK on a named op uses the op's path", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    await w.mock
      .asCaller(EMMA)
      .beginClawback({ vault_id: w.vaultId, utxos: [utxo(9)], fee_rate_sat_vb: 2 });
    w.rpc.add(
      refusedTx({
        hash: "Late",
        method: "begin_execute",
        args: { op_id: opId },
        panic: "ERR_CLAWED_BACK",
        blockHash: "B2",
      }),
    );
    w.rpc.headers.set("B2", {
      hash: "B2",
      prevHash: "P2",
      height: 101,
      timestampNs: "1767225800000000000",
    });
    const xray = await buildXRay(
      { refusedTx: { hash: "Late", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    expect(v(xray.rule.refusal?.code)).toBe("ERR_CLAWED_BACK");
    expect(v(xray.rule.refusal?.facts.opState)).toBe("voided");
    expect(v(xray.script.path)).toBe("withdrawal");
  });

  it("a call that names no op: path from the method, vault from the args", async () => {
    const w = await world();
    const args = { vault_id: w.vaultId, utxos: [], fee_rate_sat_vb: 2, source: "allowance" };
    w.rpc.add(
      refusedTx({
        hash: "Claw",
        method: "begin_clawback",
        args,
        panic: "ERR_NO_INPUTS",
        blockHash: "B3",
      }),
    );
    w.rpc.headers.set("B3", {
      hash: "B3",
      prevHash: "P3",
      height: 102,
      timestampNs: "1767225900000000000",
    });
    const kit = await w.mock.getVaultKit(w.vaultId);
    const xray = await buildXRay(
      { refusedTx: { hash: "Claw", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    expectAllSourced(xray);
    expect(xray.opId).toBeNull();
    expect(v(xray.vaultId)).toBe(w.vaultId);
    expect(v(xray.script.path)).toBe("clawback");
    expect(v(xray.script.coinSource)).toBe("allowance");
    expect(v(xray.script.scriptHex)).toBe(kit.allowance_script_hex);
    expect(xray.rule.refusal?.facts.executableAt).toBeNull();
  });

  it("other methods that name no op leave the script path not reached", async () => {
    const w = await world();
    w.rpc.add(
      refusedTx({
        hash: "Veto",
        method: "veto_policy_change",
        args: { change_id: "4" },
        panic: "ERR_CHANGE_NOT_FOUND",
        blockHash: "B4",
      }),
    );
    w.rpc.headers.set("B4", { hash: "B4", prevHash: "P4", height: 103, timestampNs: "1" });
    const xray = await buildXRay(
      { refusedTx: { hash: "Veto", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    expect(xray.script.status).toBe("not_reached");
    expect(xray.rule.status).toBe("refused");
    expectAllSourced(xray);
  });

  it("ERR_SIGNER_FAILED is a known code", async () => {
    const w = await world();
    w.rpc.add(
      refusedTx({
        hash: "Mpc",
        method: "on_signed",
        args: { op_id: "99", input_index: 0 },
        panic: "ERR_SIGNER_FAILED",
        blockHash: "B5",
      }),
    );
    w.rpc.headers.set("B5", { hash: "B5", prevHash: "P5", height: 104, timestampNs: "2" });
    const xray = await buildXRay(
      { refusedTx: { hash: "Mpc", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    expect(v(xray.rule.refusal?.gloss)).toBe(ERROR_CODES.ERR_SIGNER_FAILED);
  });

  it("resolves a missing sender through the locator", async () => {
    const w = await world();
    w.rpc.add(
      refusedTx({
        hash: "NoSender",
        method: "cancel",
        args: { op_id: "7" },
        panic: "ERR_OP_NOT_FOUND",
        blockHash: "B6",
      }),
    );
    w.rpc.headers.set("B6", { hash: "B6", prevHash: "P6", height: 105, timestampNs: "3" });
    const locator: TxLocator = { find: async () => [], senderOf: async () => TESTNET_SENDER };
    const xray = await buildXRay({ refusedTx: { hash: "NoSender" } }, w.deps(locator));
    expect(v(xray.rule.refusal?.code)).toBe("ERR_OP_NOT_FOUND");
  });
});

describe("buildXRay: refused calls, partial data and labels", () => {
  it("block header fails: timestamp null, the refusal keeps its code, method and args", async () => {
    const w = await world();
    const opId = await requestWithdrawal(w);
    w.rpc.add(
      refusedTx({
        hash: "NoBlock",
        method: "begin_execute",
        args: { op_id: opId },
        panic: "ERR_NOT_EXECUTABLE",
        blockHash: "Gone",
      }),
    );
    const xray = await buildXRay(
      { refusedTx: { hash: "NoBlock", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    const refusal = xray.rule.refusal!;
    expect(refusal.facts.blockTimestamp).toBeNull();
    expect(v(refusal.code)).toBe("ERR_NOT_EXECUTABLE");
    expect(v(refusal.method)).toBe("begin_execute");
    expect(v(refusal.args)).toEqual({ op_id: opId });
    expect(xray.rule.status).toBe("refused");
    expect(w.log).toHaveBeenCalledWith(expect.stringContaining("Gone"), expect.any(NearRpcError));
    expectAllSourced(xray);
  });

  it("labels method and args read from transaction.actions, and a defaulted clawback source", async () => {
    const w = await world();
    const tx = refusedTx({
      hash: "Bare",
      method: "begin_clawback",
      args: { vault_id: w.vaultId, utxos: [], fee_rate_sat_vb: 2 },
      panic: "ERR_NO_INPUTS",
      blockHash: "B7",
    });
    tx.receipts[0]!.receipt = {};
    w.rpc.add(tx);
    w.rpc.headers.set("B7", { hash: "B7", prevHash: "P7", height: 106, timestampNs: "4" });
    const xray = await buildXRay(
      { refusedTx: { hash: "Bare", senderId: TESTNET_SENDER } },
      w.deps(),
    );
    const refusal = xray.rule.refusal!;
    expect(v(refusal.method)).toBe("begin_clawback");
    expect(refusal.method.source.ref).toContain("transaction.actions[0].FunctionCall.method_name");
    expect(refusal.args.source.ref).toContain("transaction.actions[0].FunctionCall.args");
    expect(v(xray.script.coinSource)).toBe("vault");
    expect(xray.script.coinSource?.source.ref).toContain("args.source absent");
  });
});

describe("buildXRay: bad input", () => {
  it("an op id that is not a u64", async () => {
    const w = await world();
    await expect(buildXRay({ opId: "25; drop" }, w.deps())).rejects.toBeInstanceOf(XRayInputError);
  });

  it("unknown op", async () => {
    const w = await world();
    await expect(buildXRay({ opId: "404" }, w.deps())).rejects.toBeInstanceOf(XRayInputError);
  });

  it("tx not to this contract", async () => {
    const w = await world();
    w.rpc.add(
      refusedTx({
        hash: "Elsewhere",
        contractId: "other.testnet",
        method: "cancel",
        args: {},
        panic: "ERR_X",
      }),
    );
    await expect(
      buildXRay({ refusedTx: { hash: "Elsewhere", senderId: TESTNET_SENDER } }, w.deps()),
    ).rejects.toBeInstanceOf(XRayInputError);
  });

  it("tx did not fail", async () => {
    const w = await world();
    w.rpc.add(
      signInputTx({
        hash: "Fine",
        opId: "1",
        inputIndex: 0,
        vaultId: "1",
        payload: "aa",
        signature: "bb",
      }),
    );
    await expect(
      buildXRay({ refusedTx: { hash: "Fine", senderId: TESTNET_SENDER } }, w.deps()),
    ).rejects.toBeInstanceOf(XRayInputError);
  });

  it("unknown tx hash", async () => {
    const w = await world();
    await expect(
      buildXRay({ refusedTx: { hash: "Nope", senderId: TESTNET_SENDER } }, w.deps()),
    ).rejects.toBeInstanceOf(XRayInputError);
  });
});

describe("TxLocator", () => {
  it("chainLocators: a hint wins and the indexer is not called", async () => {
    const indexer = { find: vi.fn(async () => [{ hash: "FromIndexer", senderId: "a.testnet" }]) };
    const locator = chainLocators(
      hintLocator([{ hash: "FromHint", senderId: "b.testnet" }]),
      indexer,
    );
    expect(await locator.find(TESTNET_CONTRACT, { method: "sign_input", opId: "1" })).toEqual([
      { hash: "FromHint", senderId: "b.testnet" },
    ]);
    expect(indexer.find).not.toHaveBeenCalled();
  });

  it("chainLocators: falls through to the indexer when there are no hints", async () => {
    const indexer = { find: vi.fn(async () => [{ hash: "FromIndexer", senderId: "a.testnet" }]) };
    const locator = chainLocators(hintLocator([]), indexer);
    expect(await locator.find(TESTNET_CONTRACT, { method: "sign_input" })).toHaveLength(1);
    expect(indexer.find).toHaveBeenCalledOnce();
  });

  it("FastNEAR: logs when it stops at maxPages before sinceNs", async () => {
    const log = vi.fn();
    const fetchFn = (async (url: string) =>
      new URL(url).pathname === "/v0/account"
        ? Response.json({
            account_txs: [{ transaction_hash: "H", tx_block_timestamp: "100" }],
            resume_token: "more",
          })
        : Response.json({ transactions: [] })) as typeof fetch;
    const locator = new FastNearLocator({ network: "testnet", fetch: fetchFn, maxPages: 1, log });
    expect(await locator.find(TESTNET_CONTRACT, { method: "sign_input", sinceNs: "1" })).toEqual(
      [],
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stopped after 1 pages"));
  });

  it("FastNEAR: pages account txs back to sinceNs, batches lookups by 20, filters method and op", async () => {
    const accountTxs = Array.from({ length: 30 }, (_, i) => ({
      transaction_hash: `H${i}`,
      tx_block_timestamp: String(1000 - i),
    }));
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === "/v0/account") {
        const page =
          body.resume_token === undefined ? accountTxs.slice(0, 25) : accountTxs.slice(25);
        return Response.json({
          account_txs: page,
          resume_token: body.resume_token ? undefined : "next",
        });
      }
      const hashes = body.tx_hashes as string[];
      return Response.json({
        transactions: hashes.map((hash) => {
          const n = Number(hash.slice(1));
          const method = n % 3 === 0 ? "sign_input" : "cancel";
          const args = btoa(JSON.stringify({ op_id: n % 2 === 0 ? "7" : "8", input_index: 0 }));
          return {
            transaction: {
              hash,
              signer_id: `s${n}.testnet`,
              receiver_id: TESTNET_CONTRACT,
              actions: [{ FunctionCall: { method_name: method, args } }],
            },
          };
        }),
      });
    }) as typeof fetch;
    const locator = new FastNearLocator({ network: "testnet", fetch: fetchFn });
    const found = await locator.find(TESTNET_CONTRACT, {
      method: "sign_input",
      opId: "7",
      sinceNs: "975",
    });
    // H0..H25 are at or after 975; sign_input on op 7 means n % 6 === 0.
    expect(found).toEqual(
      [0, 6, 12, 18, 24].map((n) => ({ hash: `H${n}`, senderId: `s${n}.testnet` })),
    );
    const lookups = requests.filter((r) => r.path === "/v0/transactions");
    expect(lookups.map((r) => (r.body.tx_hashes as string[]).length)).toEqual([20, 6]);
    expect(requests.filter((r) => r.path === "/v0/account")[0]!.body).toMatchObject({
      account_id: TESTNET_CONTRACT,
      is_real_receiver: true,
    });
    expect(await locator.senderOf("H5")).toBe("s5.testnet");
  });
});

describe("FetchNearRpc", () => {
  const rpcFetch = (result: unknown, error?: unknown) =>
    vi.fn(async () =>
      Response.json(
        error ? { jsonrpc: "2.0", id: "x", error } : { jsonrpc: "2.0", id: "x", result },
      ),
    );

  it("passes a timeout signal and rejects a null result", async () => {
    const fetchFn = rpcFetch(null);
    const rpc = new FetchNearRpc(
      "https://archival.example",
      fetchFn as unknown as typeof fetch,
      50,
    );
    await expect(rpc.blockHeader("B")).rejects.toBeInstanceOf(NearRpcError);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires an archival URL", () => {
    expect(() => new FetchNearRpc("")).toThrow(/archival/);
  });

  it("views at a block and decodes the JSON bytes", async () => {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ ok: 1 })));
    const fetchFn = rpcFetch({ result: bytes, logs: [] });
    const rpc = new FetchNearRpc("https://archival.example", fetchFn as unknown as typeof fetch);
    expect(await rpc.viewAt("v1.signer", "state", {}, "BLOCK")).toEqual({ ok: 1 });
    const body = JSON.parse(
      String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.params).toMatchObject({
      request_type: "call_function",
      block_id: "BLOCK",
      method_name: "state",
    });
    expect(JSON.parse(decodeBase64(body.params.args_base64))).toEqual({});
  });

  it("maps RPC errors with their cause", async () => {
    const fetchFn = rpcFetch(undefined, {
      name: "HANDLER_ERROR",
      cause: { name: "UNKNOWN_TRANSACTION" },
    });
    const rpc = new FetchNearRpc("https://archival.example", fetchFn as unknown as typeof fetch);
    await expect(rpc.txStatus("h", "s")).rejects.toMatchObject({
      causeName: "UNKNOWN_TRANSACTION",
    });
  });

  it("reads block timestamps as nanosecond strings", async () => {
    const fetchFn = rpcFetch({
      header: { hash: "B", height: 7, timestamp: 1, timestamp_nanosec: "1793618433026730451" },
    });
    const rpc = new FetchNearRpc("https://archival.example", fetchFn as unknown as typeof fetch);
    expect(await rpc.blockHeader("B")).toEqual({
      hash: "B",
      height: 7,
      timestampNs: "1793618433026730451",
    });
  });
});

describe("explorer links", () => {
  it("NEAR and Bitcoin", () => {
    expect(nearTxUrl("testnet", "h")).toBe("https://testnet.nearblocks.io/txns/h");
    expect(nearTxUrl("mainnet", "h")).toBe("https://nearblocks.io/txns/h");
    expect(bitcoinTxUrl("signet", "t")).toBe("https://mempool.space/signet/tx/t");
    expect(bitcoinTxUrl("testnet4", "t")).toBe("https://mempool.space/testnet4/tx/t");
    expect(bitcoinTxUrl("bitcoin", "t")).toBe("https://mempool.space/tx/t");
    expect(bitcoinTxUrl("regtest", "t")).toBeNull();
  });
});

/** Live testnet check: `MORROW_XRAY_LIVE=1` (optional `MORROW_NEAR_ARCHIVAL_RPC_URL`). */
describe.skipIf(process.env.MORROW_XRAY_LIVE !== "1")("buildXRay on testnet", () => {
  const archival =
    process.env.MORROW_NEAR_ARCHIVAL_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com";

  it("op 25 on morrow-vault-dev3.testnet, no hint", { timeout: 120_000 }, async () => {
    const xray = await buildXRay(
      { opId: "25" },
      {
        contract: new NearContractClient({ contractId: TESTNET_CONTRACT, rpcUrl: archival }),
        contractId: TESTNET_CONTRACT,
        nearNetwork: "testnet",
        rpc: new FetchNearRpc(archival),
        locator: chainLocators(hintLocator([]), new FastNearLocator({ network: "testnet" })),
        bitcoin: { getTx: async () => null },
      },
    );
    expectAllSourced(xray);
    const input = xray.mpc.inputs[0]!;
    expect(v(input.sighash)).toBe(
      "ddb6d4436c2f4454d6d315cce9a537a4b6ade98f1c1f59c97e5819f65ca058e2",
    );
    expect(v(input.path)).toBe("morrow/v1/29/vault");
    expect(v(input.signer)).toBe(TESTNET_SIGNER);
    expect(v(input.threshold)).toBe(11);
    expect(v(input.participants)).toBe(16);
    expect(input.status).toBe("done");
  });
});
