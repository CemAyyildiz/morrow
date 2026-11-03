import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import {
  KeyPair,
  KeyPairSigner,
  PublicKey,
  actions,
  createTransaction,
  encodeTransaction,
  type KeyPairString,
} from "near-api-js";
import { describe, expect, it } from "vitest";
import {
  NearKeyError,
  decodeBlockHash,
  encodeFunctionCallTx,
  parseNearKey,
  signFunctionCall,
} from "./browser-tx.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUBLIC = ed25519.getPublicKey(SEED);
const SECRET = `ed25519:${base58.encode(new Uint8Array([...SEED, ...PUBLIC]))}` as KeyPairString;
const BLOCK_HASH = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

const CASES = [
  {
    name: "request_withdrawal",
    signerId: "r3.challenge.testnet",
    receiverId: "vault.morrow.testnet",
    nonce: 1_234_567_890_123n,
    methodName: "request_withdrawal",
    args: {
      vault_id: "42",
      amount_sats: "1000000",
      destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      fee_rate_sat_vb: 2,
      utxos: [{ txid: "f0".repeat(32), vout: 0, value_sats: "1000000" }],
      envelope: "ab".repeat(80),
    },
    gas: 30_000_000_000_000n,
    deposit: 0n,
  },
  {
    name: "begin_execute with a deposit and unicode",
    signerId: "ünïcode.testnet",
    receiverId: "vault.morrow.testnet",
    nonce: 2n ** 64n - 1n,
    methodName: "begin_execute",
    args: { op_id: "12", envelope: "00".repeat(80) },
    gas: 300_000_000_000_000n,
    deposit: 10n ** 24n + 7n,
  },
];

describe("NEAR transactions without a NEAR SDK", () => {
  it.each(CASES)("$name: same bytes, hash and signature as near-api-js", async (c) => {
    const key = parseNearKey(SECRET);
    const ours = signFunctionCall({ ...c, blockHash: decodeBlockHash(BLOCK_HASH) }, key);

    const theirs = createTransaction(
      c.signerId,
      PublicKey.fromString(key.publicKeyString),
      c.receiverId,
      c.nonce,
      [actions.functionCall(c.methodName, c.args, c.gas, c.deposit)],
      base58.decode(BLOCK_HASH),
    );
    expect(
      encodeFunctionCallTx({
        ...c,
        publicKey: key.publicKey,
        blockHash: decodeBlockHash(BLOCK_HASH),
      }),
    ).toEqual(encodeTransaction(theirs));
    const { txHash, signedTransaction } =
      await KeyPairSigner.fromSecretKey(SECRET).signTransaction(theirs);
    expect(ours.hash).toBe(base58.encode(txHash));
    expect(ours.signed).toEqual(signedTransaction.encode());
    expect(ours.signedBase64).toBe(Buffer.from(signedTransaction.encode()).toString("base64"));
  });

  it("signs sha256 of the borsh transaction with the key's seed", () => {
    const key = parseNearKey(SECRET);
    const c = CASES[0]!;
    const ours = signFunctionCall({ ...c, blockHash: decodeBlockHash(BLOCK_HASH) }, key);
    const body = ours.signed.slice(0, -65);
    expect(ours.signed[ours.signed.length - 65]).toBe(0);
    expect(ed25519.verify(ours.signed.slice(-64), sha256(body), PUBLIC)).toBe(true);
    expect(base58.encode(sha256(body))).toBe(ours.hash);
  });

  it("parses a key exactly as near-api-js does", () => {
    const key = parseNearKey(SECRET);
    expect(key.publicKeyString).toBe(KeyPair.fromString(SECRET).getPublicKey().toString());
    expect(key.seed).toEqual(SEED);
  });

  it("rejects keys that are malformed or whose public half does not match", () => {
    const other = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const mismatched = `ed25519:${base58.encode(new Uint8Array([...SEED, ...other]))}`;
    for (const bad of [
      "",
      "ed25519:",
      "secp256k1:abc",
      `ed25519:${base58.encode(SEED)}`,
      "ed25519:0OIl",
      mismatched,
      "ed25519:3stubPublishedFunctionCallKeyNotARealSecret",
    ]) {
      expect(() => parseNearKey(bad), bad).toThrow(NearKeyError);
    }
  });

  it("refuses values that do not fit their borsh field", () => {
    const key = parseNearKey(SECRET);
    const c = { ...CASES[0]!, blockHash: decodeBlockHash(BLOCK_HASH) };
    expect(() => signFunctionCall({ ...c, nonce: 2n ** 64n }, key)).toThrow(RangeError);
    expect(() => signFunctionCall({ ...c, deposit: -1n }, key)).toThrow(RangeError);
    expect(() => decodeBlockHash(base58.encode(new Uint8Array(31)))).toThrow(RangeError);
  });
});
