import { Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { TxParseError, txidOf } from "./browser-txid.js";

const bytes = (byte: number, length: number) => new Uint8Array(length).fill(byte);

/** A transaction with `inputs` inputs and two outputs, optionally with a witness on each input. */
function build(options: { inputs: number; witness: boolean; scriptSig?: boolean }): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = 291_744;
  for (let i = 0; i < options.inputs; i++) {
    tx.addInput(
      bytes(0x10 + i, 32),
      i,
      0xfffffffd,
      options.scriptSig ? bytes(0x51, 71 + i) : undefined,
    );
  }
  tx.addOutput(Uint8Array.of(0x00, 0x20, ...bytes(0xab, 32)), 600_000n);
  tx.addOutput(Uint8Array.of(0x00, 0x14, ...bytes(0xcd, 20)), 399_000n);
  if (options.witness) {
    for (let i = 0; i < options.inputs; i++) {
      tx.setWitness(i, [new Uint8Array(0), bytes(0x30, 72), bytes(0x02, 33), bytes(0x63, 300)]);
    }
  }
  return tx;
}

describe("txidOf", () => {
  it.each([
    ["legacy, one input with a scriptSig", { inputs: 1, witness: false, scriptSig: true }],
    ["legacy, three inputs", { inputs: 3, witness: false, scriptSig: true }],
    ["unsigned SegWit (no witnesses, as the contract stores it)", { inputs: 2, witness: false }],
    ["signed SegWit, one input", { inputs: 1, witness: true }],
    ["signed SegWit, 300 inputs (multi-byte counts)", { inputs: 300, witness: true }],
  ])("matches bitcoinjs-lib on %s", (_, options) => {
    const hex = build(options).toHex();
    expect(txidOf(hex)).toBe(Transaction.fromHex(hex).getId());
  });

  it("strips the witness: a signed transaction has its unsigned transaction's txid", () => {
    const unsigned = build({ inputs: 2, witness: false }).toHex();
    const signed = build({ inputs: 2, witness: true }).toHex();
    expect(signed).not.toBe(unsigned);
    expect(txidOf(signed)).toBe(txidOf(unsigned));
  });

  it("matches bitcoinjs-lib on BIP143's signed native P2WPKH example", () => {
    const hex =
      "01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000";
    expect(txidOf(hex)).toBe(Transaction.fromHex(hex).getId());
  });

  it.each([
    ["not hex", "zz"],
    ["odd length", "010"],
    ["cut short", build({ inputs: 1, witness: true }).toHex().slice(0, -10)],
    ["trailing bytes", `${build({ inputs: 1, witness: false }).toHex()}00`],
    [
      "a SegWit flag with no witness",
      "02000000000101" + "11".repeat(36) + "00fdffffff0000" + "00000000",
    ],
  ])("throws TxParseError on %s, as bitcoinjs-lib throws", (_, hex) => {
    expect(() => Transaction.fromHex(hex)).toThrow();
    expect(() => txidOf(hex)).toThrow(TxParseError);
  });
});
