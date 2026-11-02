import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Transaction } from "bitcoinjs-lib";
import { BitcoinBackendError, type BitcoinBackend } from "../bitcoin/backend.js";
import type { Hex, SpendOp } from "../contract/types.js";
import { CryptoError } from "../crypto/errors.js";
import { bytesToHex, hexToBytes } from "../crypto/hex.js";
import { encodeSignature, mpcSignatureToDer, type MpcSignature } from "../crypto/signature.js";
import { fillWitness } from "../crypto/witness.js";

/** The contract stores each MPC signature as big_r (33-byte compressed point) ‖ s (32 bytes). */
export function parseStoredSignature(stored: Hex): MpcSignature {
  if (!/^0[23][0-9a-f]{128}$/.test(stored)) {
    throw new CryptoError("Stored signature must be 33-byte big_r followed by 32-byte s");
  }
  return { big_r: { affine_point: stored.slice(0, 66) }, s: { scalar: stored.slice(66) } };
}

/** Signs one sighash with the Owner Key: low-S, DER, SIGHASH_ALL. */
export function ownerSignature(sighash: Hex, ownerSecretKey: Uint8Array): Hex {
  const compact = secp256k1.sign(hexToBytes(sighash), ownerSecretKey, { prehash: false });
  const r = BigInt(`0x${bytesToHex(compact.slice(0, 32))}`);
  const s = BigInt(`0x${bytesToHex(compact.slice(32))}`);
  return encodeSignature(r, s);
}

/**
 * Adds the witnesses to the contract-built transaction: the Co-signer's MPC signature and the
 * Owner's signature, placed by the contract-published template. The transaction itself is never
 * rebuilt or modified.
 */
export function assembleSpend(op: SpendOp, witnessScriptHex: Hex, ownerSecretKey: Uint8Array): Hex {
  const template = op.witness_template;
  if (!op.unsigned_tx_hex || !template) throw new CryptoError(`Op ${op.op_id} is not frozen`);
  const tx = Transaction.fromHex(op.unsigned_tx_hex);
  if (tx.ins.length !== op.sighashes.length)
    throw new CryptoError("Sighash count does not match inputs");
  op.sighashes.forEach((sighash, i) => {
    const stored = op.signatures[i];
    if (!stored) throw new CryptoError(`Missing Co-signer signature for input ${i}`);
    const stack = fillWitness(template, {
      signatures: {
        cosigner: mpcSignatureToDer(parseStoredSignature(stored)),
        owner: ownerSignature(sighash, ownerSecretKey),
      },
      scriptHex: witnessScriptHex,
    });
    tx.setWitness(i, stack.map(hexToBytes));
  });
  return tx.toHex();
}

const ALREADY_KNOWN =
  /already in (the )?(mempool|block ?chain|utxo set)|txn-already-known|txn-already-in-mempool/i;

/**
 * Assembles and broadcasts a signed op. ECDSA signatures here are deterministic (RFC 6979), so a
 * retry rebuilds the identical transaction; a node that already has it counts as success.
 */
export async function completeAndBroadcast(
  op: SpendOp,
  witnessScriptHex: Hex,
  ownerSecretKey: Uint8Array,
  backend: BitcoinBackend,
): Promise<Hex> {
  const raw = assembleSpend(op, witnessScriptHex, ownerSecretKey);
  try {
    return await backend.broadcast(raw);
  } catch (error) {
    if (error instanceof BitcoinBackendError && ALREADY_KNOWN.test(error.message)) {
      return Transaction.fromHex(raw).getId();
    }
    throw error;
  }
}
