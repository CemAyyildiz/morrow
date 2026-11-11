// A Bitcoin transaction's txid without bitcoinjs-lib: the double SHA-256 of its legacy
// serialization (no marker, flag or witnesses), in display byte order. Pure: @noble/hashes only.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "../contract/types.js";

export class TxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxParseError";
  }
}

/** Reads a serialized transaction front to back; every read past the end throws. */
class Reader {
  at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at === this.bytes.length;
  }

  skip(n: number): void {
    if (n < 0 || this.at + n > this.bytes.length) {
      throw new TxParseError("Transaction ends early");
    }
    this.at += n;
  }

  byte(offset = 0): number {
    const value = this.bytes[this.at + offset];
    if (value === undefined) throw new TxParseError("Transaction ends early");
    return value;
  }

  /** A CompactSize integer. */
  varint(): number {
    const first = this.byte();
    this.skip(1);
    if (first < 0xfd) return first;
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let value = 0;
    for (let i = size - 1; i >= 0; i--) value = value * 256 + this.byte(i);
    this.skip(size);
    if (!Number.isSafeInteger(value)) throw new TxParseError("Transaction length out of range");
    return value;
  }

  slice(from: number, to: number): Uint8Array {
    return this.bytes.subarray(from, to);
  }
}

/**
 * The txid of a serialized transaction (hex), as bitcoinjs-lib's `Transaction.fromHex(hex).getId()`
 * gives it: SegWit marker, flag and witnesses are stripped before hashing. Throws `TxParseError`
 * on a transaction that does not parse or has bytes after its locktime.
 */
export function txidOf(hex: Hex): Hex {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    throw new TxParseError("Transaction is not hex");
  }
  const r = new Reader(bytes);
  r.skip(4); // version
  const segwit = r.byte() === 0x00 && r.byte(1) === 0x01;
  if (segwit) r.skip(2);
  const bodyStart = r.at;
  const inputs = r.varint();
  for (let i = 0; i < inputs; i++) {
    r.skip(36); // outpoint
    r.skip(r.varint()); // scriptSig
    r.skip(4); // sequence
  }
  const outputs = r.varint();
  for (let i = 0; i < outputs; i++) {
    r.skip(8); // value
    r.skip(r.varint()); // scriptPubKey
  }
  const bodyEnd = r.at;
  if (segwit) {
    let witnessItems = 0;
    for (let i = 0; i < inputs; i++) {
      const items = r.varint();
      witnessItems += items;
      for (let j = 0; j < items; j++) r.skip(r.varint());
    }
    // As bitcoinjs-lib: a SegWit serialization must carry a witness.
    if (witnessItems === 0) throw new TxParseError("Transaction has superfluous witness data");
  }
  const lockStart = r.at;
  r.skip(4); // locktime
  if (!r.done) throw new TxParseError("Transaction has unexpected data");

  const legacy = new Uint8Array(4 + (bodyEnd - bodyStart) + 4);
  legacy.set(r.slice(0, 4), 0);
  legacy.set(r.slice(bodyStart, bodyEnd), 4);
  legacy.set(r.slice(lockStart, lockStart + 4), 4 + (bodyEnd - bodyStart));
  return bytesToHex(sha256(sha256(legacy)).reverse());
}
