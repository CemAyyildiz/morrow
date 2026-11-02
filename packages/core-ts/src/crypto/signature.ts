import { CryptoError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;

export const SIGHASH_ALL = 0x01;

/** The signature shape returned by the NEAR MPC signer for secp256k1. */
export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id?: number;
}

function toScalar(hex: string, name: string): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new CryptoError(`${name} must be 32 bytes of hex`);
  const value = BigInt(`0x${hex}`);
  if (value === 0n || value >= N) throw new CryptoError(`${name} is out of range`);
  return value;
}

/** Bitcoin standardness requires s ≤ n/2. */
export function toLowS(s: bigint): bigint {
  return s > HALF_N ? N - s : s;
}

/** Minimal big-endian bytes of a positive integer, with a 0x00 pad when the top bit is set. */
function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = hexToBytes(hex.toLowerCase());
  return (bytes[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...bytes) : bytes;
}

/** DER-encodes (r, low-S s) and appends the sighash byte. Returns lowercase hex. */
export function encodeSignature(r: bigint, s: bigint, hashType = SIGHASH_ALL): string {
  if (hashType !== SIGHASH_ALL) throw new CryptoError("Only SIGHASH_ALL is used");
  const rBytes = derInteger(r);
  const sBytes = derInteger(toLowS(s));
  const body = [0x02, rBytes.length, ...rBytes, 0x02, sBytes.length, ...sBytes];
  return bytesToHex(Uint8Array.of(0x30, body.length, ...body, hashType));
}

/** Converts an MPC signer response into the witness-ready signature (DER, low-S, SIGHASH_ALL). */
export function mpcSignatureToDer(signature: MpcSignature): string {
  const point = signature.big_r.affine_point;
  if (!/^0[23][0-9a-fA-F]{64}$/.test(point)) {
    throw new CryptoError("big_r must be a 33-byte compressed point");
  }
  const r = toScalar(point.slice(2), "r");
  const s = toScalar(signature.s.scalar, "s");
  return encodeSignature(r, s);
}
