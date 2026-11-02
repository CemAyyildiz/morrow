import { secp256k1 } from "@noble/curves/secp256k1.js";
import { networks, opcodes, payments, script as bscript, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { BitcoindRpc } from "../bitcoin/bitcoind-rpc.js";
import { RegtestControl } from "../bitcoin/regtest.js";
import { WITNESS_TEMPLATES } from "../contract/mock.js";
import type { SpendOp } from "../contract/types.js";
import { bytesToHex } from "../crypto/hex.js";
import {
  assembleSpend,
  completeAndBroadcast,
  ownerSignature,
  parseStoredSignature,
} from "./complete.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The contract's Vault Script shape (addendum §A), built independently with bitcoinjs-lib. */
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
    bscript.number.encode(6),
    opcodes.OP_CHECKSEQUENCEVERIFY,
    opcodes.OP_DROP,
    owner,
    opcodes.OP_CHECKSIG,
    opcodes.OP_ENDIF,
    opcodes.OP_ENDIF,
  ]);
}

/** Stores a Co-signer signature the way the contract does, deliberately as high-S. */
function storedHighS(sighash: Uint8Array, cosignerSecret: Uint8Array): string {
  const compact = secp256k1.sign(sighash, cosignerSecret, { prehash: false });
  const s = BigInt(`0x${bytesToHex(compact.slice(32))}`);
  const high = s > N / 2n ? s : N - s;
  return `02${bytesToHex(compact.slice(0, 32))}${high.toString(16).padStart(64, "0")}`;
}

describe("signature helpers", () => {
  it("parses the contract's stored signature form", () => {
    const stored = `03${"11".repeat(32)}${"22".repeat(32)}`;
    expect(parseStoredSignature(stored)).toEqual({
      big_r: { affine_point: `03${"11".repeat(32)}` },
      s: { scalar: "22".repeat(32) },
    });
    expect(() => parseStoredSignature("04")).toThrow(/33-byte big_r/);
  });

  it("produces low-S DER Owner signatures that verify", () => {
    const secret = secp256k1.utils.randomSecretKey();
    const sighash = "ab".repeat(32);
    const der = ownerSignature(sighash, secret);
    expect(der.endsWith("01")).toBe(true);
    const decoded = bscript.signature.decode(Buffer.from(der, "hex"));
    expect(
      secp256k1.verify(
        decoded.signature,
        Buffer.from(sighash, "hex"),
        secp256k1.getPublicKey(secret, true),
        { prehash: false },
      ),
    ).toBe(true);
  });

  it("refuses ops that are not frozen or not fully signed", () => {
    const op = { op_id: "1", unsigned_tx_hex: null, witness_template: null } as unknown as SpendOp;
    expect(() => assembleSpend(op, "51", new Uint8Array(32).fill(1))).toThrow(/not frozen/);
  });
});

const url = process.env.MORROW_REGTEST_RPC;

describe.skipIf(!url)("withdrawal accepted by Bitcoin Core (regtest)", () => {
  it("assembles, broadcasts and confirms a Withdrawal Path spend, idempotently", async () => {
    const rpc = new BitcoindRpc(url ?? "");
    const control = new RegtestControl(rpc);
    const [ownerSk, cosignerSk, guardianSk] = [0, 1, 2].map(() =>
      secp256k1.utils.randomSecretKey(),
    ) as [Uint8Array, Uint8Array, Uint8Array];
    const pub = (sk: Uint8Array) => secp256k1.getPublicKey(sk, true);
    const witnessScript = vaultScript(pub(ownerSk), pub(cosignerSk), pub(guardianSk));
    const vault = payments.p2wsh({ redeem: { output: witnessScript }, network: networks.regtest });

    await control.fund(vault.address ?? "", 1_000_000n);
    await control.mine(1);
    const [utxo] = await rpc.getUtxos(vault.address ?? "");
    if (!utxo) throw new Error("vault not funded");

    // What the contract would build: v2, RBF, destination + change back to the Vault.
    const destination = await control.newAddress();
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout, 0xfffffffd);
    tx.addOutput(
      payments.p2wpkh({ address: destination, network: networks.regtest }).output ??
        new Uint8Array(),
      400_000n,
    );
    tx.addOutput(vault.output ?? new Uint8Array(), 1_000_000n - 400_000n - 1_000n);
    const sighash = tx.hashForWitnessV0(
      0,
      witnessScript,
      BigInt(utxo.value_sats),
      Transaction.SIGHASH_ALL,
    );

    const op = {
      op_id: "1",
      unsigned_tx_hex: tx.toHex(),
      sighashes: [bytesToHex(sighash)],
      signatures: [storedHighS(sighash, cosignerSk)],
      witness_template: WITNESS_TEMPLATES.withdrawal,
    } as unknown as SpendOp;

    const txid = await completeAndBroadcast(op, bytesToHex(witnessScript), ownerSk, rpc);
    expect(txid).toBe(tx.getId());
    expect(await completeAndBroadcast(op, bytesToHex(witnessScript), ownerSk, rpc)).toBe(txid);
    await control.mine(1);
    expect((await rpc.getTx(txid))?.confirmations).toBe(1);
  });
});
