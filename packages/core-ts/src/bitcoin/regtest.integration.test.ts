import { describe, expect, it } from "vitest";
import { BitcoindRpc } from "./bitcoind-rpc.js";
import { RegtestControl } from "./regtest.js";

const url = process.env.MORROW_REGTEST_RPC;

/** Runs only against a live node: `make regtest-up` then set MORROW_REGTEST_RPC. */
describe.skipIf(!url)("BitcoindRpc against regtest", () => {
  const rpc = new BitcoindRpc(url ?? "http://127.0.0.1:18443");
  const control = new RegtestControl(rpc);

  it("funds an address, finds the UTXO and counts confirmations", async () => {
    const address = await control.newAddress();
    const txid = await control.fund(address, 100_000_000n);
    expect((await rpc.getTx(txid))?.confirmations).toBe(0);

    await control.mine(1);
    const utxos = await rpc.getUtxos(address);
    expect(utxos).toHaveLength(1);
    expect(utxos[0]?.value_sats).toBe("100000000");
    expect(utxos[0]?.height).toBe(await rpc.getTipHeight());
    expect((await rpc.getTx(txid))?.confirmations).toBe(1);
  });

  it("broadcasts a signed transaction", async () => {
    const source = await control.newAddress();
    await control.fund(source, 50_000_000n);
    await control.mine(1);
    const [utxo] = await rpc.getUtxos(source);
    if (!utxo) throw new Error("funding UTXO not found");

    const destination = await control.newAddress();
    const unsigned = await rpc.call<string>("createrawtransaction", [
      [{ txid: utxo.txid, vout: utxo.vout }],
      [{ [destination]: "0.4999" }],
    ]);
    const signed = await rpc.call<{ hex: string; complete: boolean }>(
      "signrawtransactionwithwallet",
      [unsigned],
      "miner",
    );
    expect(signed.complete).toBe(true);

    const txid = await rpc.broadcast(signed.hex);
    await control.mine(1);
    expect((await rpc.getTx(txid))?.confirmations).toBe(1);
  });
});
