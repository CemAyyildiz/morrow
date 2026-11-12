// `assembleSpend` for the browser, without bitcoinjs-lib: the contract's unsigned transaction
// gets the SegWit marker and flag after its 4-byte version and one witness stack per input
// before its 4-byte locktime. Nothing else changes, so the result is byte for byte what
// `assembleSpend` gives. Pure: @noble only.
import type { Hex, SpendOp } from "../contract/types.js";
import { CryptoError } from "../crypto/errors.js";
import { bytesToHex, hexToBytes } from "../crypto/hex.js";
import { mpcSignatureToDer } from "../crypto/signature.js";
import { fillWitness } from "../crypto/witness.js";
import { ownerSignature, parseStoredSignature, type LocalSigner } from "./signatures.js";

/** Bitcoin's CompactSize encoding of `n`. */
function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  if (n <= 0xffffffff) {
    return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
  }
  throw new CryptoError("Length out of range");
}

/** Reads a CompactSize at `at`; returns the value and the offset after it. */
function readCompactSize(bytes: Uint8Array, at: number): [number, number] {
  const first = bytes[at];
  if (first === undefined) throw new CryptoError("Transaction ends early");
  if (first < 0xfd) return [first, at + 1];
  const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (at + 1 + size > bytes.length) throw new CryptoError("Transaction ends early");
  let value = 0;
  for (let i = size; i >= 1; i--) value = value * 256 + (bytes[at + i] as number);
  if (!Number.isSafeInteger(value)) throw new CryptoError("Transaction length out of range");
  return [value, at + 1 + size];
}

/**
 * The input count of a legacy (no witness) serialization, checking that it parses to exactly
 * its locktime. A transaction that already carries the SegWit marker is refused.
 */
function legacyInputCount(tx: Uint8Array): number {
  const skip = (at: number, n: number) => {
    if (at + n > tx.length) throw new CryptoError("Transaction ends early");
    return at + n;
  };
  let at = skip(0, 4);
  if (tx[at] === 0x00) throw new CryptoError("Unsigned transaction already has a witness");
  /** A CompactSize at `at`, moving `at` past it. */
  const count = () => {
    const [value, next] = readCompactSize(tx, at);
    at = next;
    return value;
  };
  const inputs = count();
  if (inputs === 0) throw new CryptoError("Transaction has no inputs");
  for (let i = 0; i < inputs; i++) {
    at = skip(at, 36);
    const script = count();
    at = skip(at, script + 4);
  }
  const outputs = count();
  for (let i = 0; i < outputs; i++) {
    at = skip(at, 8);
    const script = count();
    at = skip(at, script);
  }
  if (skip(at, 4) !== tx.length) throw new CryptoError("Transaction has unexpected data");
  return inputs;
}

/**
 * Adds the witnesses to the contract-built transaction, as `assembleSpend` does: per input, the
 * Co-signer's MPC signature and the local signer's signature placed by the contract-published
 * template. Returns the signed transaction as hex. A bare secret key means the Owner.
 */
export function assembleSpendHex(
  op: SpendOp,
  witnessScriptHex: Hex,
  signer: LocalSigner | Uint8Array,
): Hex {
  const local =
    signer instanceof Uint8Array ? { role: "owner" as const, secretKey: signer } : signer;
  const template = op.witness_template;
  if (!op.unsigned_tx_hex || !template) throw new CryptoError(`Op ${op.op_id} is not frozen`);
  const tx = hexToBytes(op.unsigned_tx_hex);
  if (legacyInputCount(tx) !== op.sighashes.length) {
    throw new CryptoError("Sighash count does not match inputs");
  }
  const witness: Uint8Array[] = [];
  op.sighashes.forEach((sighash, i) => {
    const stored = op.signatures[i];
    if (!stored) throw new CryptoError(`Missing Co-signer signature for input ${i}`);
    const stack = fillWitness(template, {
      signatures: {
        cosigner: mpcSignatureToDer(parseStoredSignature(stored)),
        [local.role]: ownerSignature(sighash, local.secretKey),
      },
      scriptHex: witnessScriptHex,
    });
    witness.push(compactSize(stack.length));
    for (const item of stack) {
      const bytes = hexToBytes(item);
      witness.push(compactSize(bytes.length), bytes);
    }
  });
  const parts = [
    tx.subarray(0, 4),
    Uint8Array.of(0x00, 0x01),
    tx.subarray(4, tx.length - 4),
    ...witness,
    tx.subarray(tx.length - 4),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return bytesToHex(out);
}
