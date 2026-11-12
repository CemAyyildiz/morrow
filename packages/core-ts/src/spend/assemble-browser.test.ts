import { secp256k1 } from "@noble/curves/secp256k1.js";
import { networks, opcodes, payments, script as bscript, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { txidOf } from "../bitcoin/browser-txid.js";
import { WITNESS_TEMPLATES } from "../contract/mock.js";
import type { SpendOp } from "../contract/types.js";
import { bytesToHex } from "../crypto/hex.js";
import { assembleSpendHex } from "./assemble-browser.js";
import { assembleSpend } from "./complete.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const pub = (sk: Uint8Array) => secp256k1.getPublicKey(sk, true);
const key = (byte: number) => new Uint8Array(32).fill(byte);

/** The contract's Vault Script shape with one Guardian, built independently with bitcoinjs-lib. */
function vaultScript(owner: Uint8Array, cosigner: Uint8Array, guardian: Uint8Array): Uint8Array {
  return bscript.compile([
    opcodes.OP_IF,
    owner,
    opcodes.OP_CHECKSIGVERIFY,
    cosigner,
    opcodes.OP_CHECKSIG,
    opcodes.OP_ELSE,
    opcodes.OP_IF,
    cosigner,
    opcodes.OP_CHECKSIGVERIFY,
    opcodes.OP_1,
    guardian,
    opcodes.OP_1,
    opcodes.OP_CHECKMULTISIG,
    opcodes.OP_ELSE,
    bscript.number.encode(4320),
    opcodes.OP_CHECKSEQUENCEVERIFY,
    opcodes.OP_DROP,
    owner,
    opcodes.OP_CHECKSIG,
    opcodes.OP_ENDIF,
    opcodes.OP_ENDIF,
  ]);
}

/** A Co-signer signature stored the way the contract does; `high` forces a high-S value. */
function stored(sighash: Uint8Array, cosignerSecret: Uint8Array, high: boolean): string {
  const compact = secp256k1.sign(sighash, cosignerSecret, { prehash: false });
  const s = BigInt(`0x${bytesToHex(compact.slice(32))}`);
  const value = high === s > N / 2n ? s : N - s;
  return `03${bytesToHex(compact.slice(0, 32))}${value.toString(16).padStart(64, "0")}`;
}

const ownerSk = key(1);
const cosignerSk = key(2);
const guardianSk = key(3);
const witnessScript = vaultScript(pub(ownerSk), pub(cosignerSk), pub(guardianSk));
const vault = payments.p2wsh({ redeem: { output: witnessScript }, network: networks.testnet });

/** A frozen op as the contract publishes it: v2, RBF inputs, `outputs` P2WPKH outputs. */
function frozenOp(kind: "withdrawal" | "clawback", inputs: number, outputs: number): SpendOp {
  const tx = new Transaction();
  tx.version = 2;
  const values: bigint[] = [];
  for (let i = 0; i < inputs; i++) {
    tx.addInput(new Uint8Array(32).fill(0x10 + i), i, 0xfffffffd);
    values.push(BigInt(100_000 * (i + 1)));
  }
  for (let o = 0; o < outputs; o++) {
    const out =
      o === outputs - 1 && kind === "withdrawal"
        ? (vault.output ?? new Uint8Array())
        : (payments.p2wpkh({ hash: new Uint8Array(20).fill(0x20 + o) }).output ?? new Uint8Array());
    tx.addOutput(out, BigInt(10_000 * (o + 1)));
  }
  const sighashes = values.map((value, i) =>
    tx.hashForWitnessV0(i, witnessScript, value, Transaction.SIGHASH_ALL),
  );
  return {
    op_id: "9",
    vault_id: "3",
    kind,
    source: "vault",
    state: "signed",
    amount_sats: "10000",
    destination: "tb1q",
    fee_rate_sat_vb: 2,
    utxos: [],
    created_at: "1",
    executable_at: null,
    unsigned_tx_hex: tx.toHex(),
    sighashes: sighashes.map((s) => bytesToHex(s)),
    signatures: sighashes.map((s, i) => stored(s, cosignerSk, i % 2 === 0)),
    witness_template: WITNESS_TEMPLATES[kind],
  };
}

describe("assembleSpendHex", () => {
  it.each([
    ["withdrawal", 1, 2],
    ["withdrawal", 3, 2],
    ["clawback", 1, 1],
    ["clawback", 5, 1],
  ] as const)("matches assembleSpend byte for byte: %s, %i inputs", (kind, inputs, outputs) => {
    const op = frozenOp(kind, inputs, outputs);
    const scriptHex = bytesToHex(witnessScript);
    const signer =
      kind === "withdrawal"
        ? { role: "owner" as const, secretKey: ownerSk }
        : { role: "guardian" as const, secretKey: guardianSk };
    const browser = assembleSpendHex(op, scriptHex, signer);
    expect(browser).toBe(assembleSpend(op, scriptHex, signer));
    // The txid ignores witnesses: it is the unsigned transaction's.
    expect(txidOf(browser)).toBe(Transaction.fromHex(op.unsigned_tx_hex ?? "").getId());
  });

  it("takes a bare secret key as the Owner's", () => {
    const op = frozenOp("withdrawal", 2, 2);
    const scriptHex = bytesToHex(witnessScript);
    expect(assembleSpendHex(op, scriptHex, ownerSk)).toBe(assembleSpend(op, scriptHex, ownerSk));
  });

  it("refuses ops that are not frozen, short of signatures or with the wrong input count", () => {
    const op = frozenOp("withdrawal", 2, 2);
    expect(() => assembleSpendHex({ ...op, unsigned_tx_hex: null }, "51", ownerSk)).toThrow(
      /not frozen/,
    );
    expect(() =>
      assembleSpendHex({ ...op, signatures: [op.signatures[0] ?? null, null] }, "51", ownerSk),
    ).toThrow(/Missing Co-signer signature for input 1/);
    expect(() =>
      assembleSpendHex({ ...op, sighashes: op.sighashes.slice(1) }, "51", ownerSk),
    ).toThrow(/Sighash count/);
  });

  it("refuses a transaction that does not parse or already has a witness", () => {
    const op = frozenOp("withdrawal", 1, 2);
    const unsigned = op.unsigned_tx_hex ?? "";
    expect(() =>
      assembleSpendHex({ ...op, unsigned_tx_hex: `${unsigned}00` }, "51", ownerSk),
    ).toThrow(/unexpected data/);
    expect(() =>
      assembleSpendHex({ ...op, unsigned_tx_hex: unsigned.slice(0, 40) }, "51", ownerSk),
    ).toThrow(/ends early/);
    const signed = assembleSpendHex(op, bytesToHex(witnessScript), ownerSk);
    expect(() => assembleSpendHex({ ...op, unsigned_tx_hex: signed }, "51", ownerSk)).toThrow(
      /already has a witness/,
    );
  });
});
