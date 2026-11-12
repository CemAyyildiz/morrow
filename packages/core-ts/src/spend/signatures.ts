// The local half of a spend's witness, pure (@noble only): the contract's stored MPC signature
// parsed, and the Owner's or a Guardian's own signature over a contract-published sighash.
// Shared by `assembleSpend` (bitcoinjs-lib, Node) and `assembleSpendHex` (browser).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Hex } from "../contract/types.js";
import { CryptoError } from "../crypto/errors.js";
import { bytesToHex, hexToBytes } from "../crypto/hex.js";
import { encodeSignature, type MpcSignature } from "../crypto/signature.js";

/** The contract stores each MPC signature as big_r (33-byte compressed point) ‖ s (32 bytes). */
export function parseStoredSignature(stored: Hex): MpcSignature {
  if (!/^0[23][0-9a-f]{128}$/.test(stored)) {
    throw new CryptoError("Stored signature must be 33-byte big_r followed by 32-byte s");
  }
  return { big_r: { affine_point: stored.slice(0, 66) }, s: { scalar: stored.slice(66) } };
}

/** The local signer for a spend: the Owner (Withdrawal Path) or a Guardian (Clawback Path). */
export interface LocalSigner {
  role: "owner" | "guardian";
  secretKey: Uint8Array;
}

/** Signs one sighash with a local key: low-S, DER, SIGHASH_ALL. */
export function ownerSignature(sighash: Hex, secretKey: Uint8Array): Hex {
  const compact = secp256k1.sign(hexToBytes(sighash), secretKey, { prehash: false });
  const r = BigInt(`0x${bytesToHex(compact.slice(0, 32))}`);
  const s = BigInt(`0x${bytesToHex(compact.slice(32))}`);
  return encodeSignature(r, s);
}
