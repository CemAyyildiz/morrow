import { Transaction } from "bitcoinjs-lib";
import { BitcoinBackendError, type BitcoinBackend } from "../bitcoin/backend.js";
import type { Hex, SpendOp } from "../contract/types.js";
import { CryptoError } from "../crypto/errors.js";
import { hexToBytes } from "../crypto/hex.js";
import { mpcSignatureToDer } from "../crypto/signature.js";
import { fillWitness } from "../crypto/witness.js";
import { ownerSignature, parseStoredSignature, type LocalSigner } from "./signatures.js";

export { ownerSignature, parseStoredSignature, type LocalSigner } from "./signatures.js";

/**
 * Adds the witnesses to the contract-built transaction: the Co-signer's MPC signature and the
 * local signer's signature, placed by the contract-published template. The transaction itself is
 * never rebuilt or modified. A bare secret key means the Owner.
 */
export function assembleSpend(
  op: SpendOp,
  witnessScriptHex: Hex,
  signer: LocalSigner | Uint8Array,
): Hex {
  const local =
    signer instanceof Uint8Array ? { role: "owner" as const, secretKey: signer } : signer;
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
        [local.role]: ownerSignature(sighash, local.secretKey),
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
  signer: LocalSigner | Uint8Array,
  backend: BitcoinBackend,
): Promise<Hex> {
  const raw = assembleSpend(op, witnessScriptHex, signer);
  try {
    return await backend.broadcast(raw);
  } catch (error) {
    if (error instanceof BitcoinBackendError && ALREADY_KNOWN.test(error.message)) {
      return Transaction.fromHex(raw).getId();
    }
    throw error;
  }
}
