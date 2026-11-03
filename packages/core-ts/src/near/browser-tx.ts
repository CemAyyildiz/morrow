// NEAR transactions signed in the browser without a NEAR SDK: the borsh layout of a
// `Transaction` (V0) with one `FunctionCall` action, ed25519 over sha256 of those bytes, and
// the `ed25519:<base58>` key format. Byte-for-byte equal to near-api-js `createTransaction` /
// `signTransaction` (browser-tx.test.ts proves it). Pure: @noble and @scure only.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

/** An ed25519 function-call key from `ed25519:<base58 of seed ‖ public key>`. */
export interface NearKey {
  /** The 32-byte seed. Never logged, never stored. */
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  /** `ed25519:<base58 public key>`, as `view_access_key` takes it. */
  readonly publicKeyString: string;
}

export class NearKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearKeyError";
  }
}

/**
 * Parses a published `ed25519:<base58>` secret key: 64 bytes, the seed then the public key.
 * The public key must be the one the seed derives, otherwise the key is rejected.
 */
export function parseNearKey(text: string): NearKey {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(text.trim());
  if (!match) throw new NearKeyError("Not an ed25519:<base58> key");
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(match[1] as string);
  } catch {
    throw new NearKeyError("The key is not valid base58");
  }
  if (bytes.length !== 64) throw new NearKeyError("An ed25519 secret key is 64 bytes");
  const seed = bytes.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  const stated = bytes.slice(32);
  if (!publicKey.every((byte, i) => byte === stated[i])) {
    throw new NearKeyError("The key's public half does not match its seed");
  }
  return { seed, publicKey, publicKeyString: `ed25519:${base58.encode(publicKey)}` };
}

/** One `FunctionCall` transaction. */
export interface FunctionCallTx {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  /** The 32-byte hash of a recent block (base58-decoded `header.hash`). */
  blockHash: Uint8Array;
  methodName: string;
  /** JSON-serialised as the call's args. */
  args: object;
  gas: bigint;
  /** yoctoNEAR. */
  deposit: bigint;
}

const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  u8(value: number): this {
    return this.bytes(Uint8Array.of(value));
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return this.bytes(out);
  }

  /** Little-endian unsigned integer of `size` bytes. */
  uint(value: bigint, size: number, max: bigint): this {
    if (value < 0n || value > max) throw new RangeError(`${value} does not fit in ${size} bytes`);
    const out = new Uint8Array(size);
    let rest = value;
    for (let i = 0; i < size; i += 1) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return this.bytes(out);
  }

  /** u32 length + bytes. */
  vec(value: Uint8Array): this {
    return this.u32(value.length).bytes(value);
  }

  string(value: string): this {
    return this.vec(new TextEncoder().encode(value));
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** `FunctionCall` is variant 2 of NEAR's `Action` enum. */
const ACTION_FUNCTION_CALL = 2;
/** `KeyType::ED25519`. */
const KEY_ED25519 = 0;

/** borsh(`Transaction`): signer, public key, nonce, receiver, block hash, one FunctionCall. */
export function encodeFunctionCallTx(tx: FunctionCallTx): Uint8Array {
  if (tx.publicKey.length !== 32) throw new RangeError("An ed25519 public key is 32 bytes");
  if (tx.blockHash.length !== 32) throw new RangeError("A block hash is 32 bytes");
  return new Writer()
    .string(tx.signerId)
    .u8(KEY_ED25519)
    .bytes(tx.publicKey)
    .uint(tx.nonce, 8, U64_MAX)
    .string(tx.receiverId)
    .bytes(tx.blockHash)
    .u32(1)
    .u8(ACTION_FUNCTION_CALL)
    .string(tx.methodName)
    .vec(new TextEncoder().encode(JSON.stringify(tx.args)))
    .uint(tx.gas, 8, U64_MAX)
    .uint(tx.deposit, 16, U128_MAX)
    .done();
}

export interface SignedFunctionCall {
  /** base58(sha256(borsh(Transaction))): the transaction hash explorers show. */
  hash: string;
  /** borsh(`SignedTransaction`): the transaction, then `0 ‖ signature[64]`. */
  signed: Uint8Array;
  /** `signed` in base64, as `send_tx` takes it. */
  signedBase64: string;
}

/** Signs `tx` with `key`: ed25519 over sha256 of its borsh bytes. */
export function signFunctionCall(
  tx: Omit<FunctionCallTx, "publicKey">,
  key: NearKey,
): SignedFunctionCall {
  const body = encodeFunctionCallTx({ ...tx, publicKey: key.publicKey });
  const digest = sha256(body);
  const signature = ed25519.sign(digest, key.seed);
  const signed = new Writer().bytes(body).u8(KEY_ED25519).bytes(signature).done();
  return { hash: base58.encode(digest), signed, signedBase64: base64.encode(signed) };
}

/** Decodes a base58 block hash (`block.header.hash`) to its 32 bytes. */
export function decodeBlockHash(hash: string): Uint8Array {
  const bytes = base58.decode(hash);
  if (bytes.length !== 32) throw new RangeError("A block hash is 32 bytes");
  return bytes;
}
