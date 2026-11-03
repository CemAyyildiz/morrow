/**
 * Owner-Key-only Bitcoin spends built from the Vault Kit, for the two moves a holder of the
 * published Owner Key could try directly on Bitcoin, with no Co-signer and no NEAR:
 *   - an Escape spend sent before the Escape Timelock has matured (BIP68 non-final);
 *   - a Withdrawal-path spend with an empty Co-signer signature (script verify fails).
 *
 * Both are expected to be refused by any Bitcoin node. The transaction never appears in the
 * Attempt Log (the contract never sees it), so each spend records its raw hex, txid and the
 * node's rejection text as its own evidence.
 *
 * The Escape-path pattern mirrors `tools/escape/src/escape.ts` (`buildEscape`): escape is
 * lane-isolated and not importable, so the pattern is reproduced here with bitcoinjs-lib.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { address as baddress, networks, Transaction, type Network } from "bitcoinjs-lib";
import type { BtcNetwork, Outpoint, VaultKit, WitnessSlot } from "@morrow/core-ts";

const NETWORKS: Record<BtcNetwork, Network> = {
  bitcoin: networks.bitcoin,
  signet: networks.testnet,
  testnet4: networks.testnet,
  regtest: networks.regtest,
};

const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MAX_SIGNATURE_BYTES = 73;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** Minimal big-endian bytes of a positive integer, padded when the top bit is set (DER). */
function derInteger(value: bigint): Uint8Array {
  let h = value.toString(16);
  if (h.length % 2) h = `0${h}`;
  const bytes = unhex(h);
  return (bytes[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...bytes) : bytes;
}

/** Low-S DER signature with SIGHASH_ALL, as Bitcoin consensus requires. */
export function signDer(sighash: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const compact = secp256k1.sign(sighash, secretKey, { prehash: false });
  const r = BigInt(`0x${hex(compact.subarray(0, 32))}`);
  let s = BigInt(`0x${hex(compact.subarray(32))}`);
  if (s > CURVE_N / 2n) s = CURVE_N - s;
  const [rBytes, sBytes] = [derInteger(r), derInteger(s)];
  const body = [0x02, rBytes.length, ...rBytes, 0x02, sBytes.length, ...sBytes];
  return Uint8Array.of(0x30, body.length, ...body, Transaction.SIGHASH_ALL);
}

export type OwnerSpendPath = "escape" | "no_cosigner";

export interface OwnerSpendRequest {
  kit: VaultKit;
  coins: readonly Outpoint[];
  ownerSecretKey: Uint8Array;
  destination: string;
  feeRateSatVb: number;
  path: OwnerSpendPath;
}

export interface OwnerSpend {
  rawHex: string;
  txid: string;
  destination: string;
  amount_sats: string;
  fee_sats: string;
}

export class OwnerSpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerSpendError";
  }
}

/**
 * Builds and signs an Owner-Key-only spend of the Vault coins. The Escape path sets each input's
 * nSequence to the Escape Timelock so the node measures it against BIP68; the Withdrawal path
 * leaves the Co-signer signature empty so script verification fails. The bytes are built
 * regardless (so there is something to broadcast and record); only the node decides.
 */
export function buildOwnerSpend({
  kit,
  coins,
  ownerSecretKey,
  destination,
  feeRateSatVb,
  path,
}: OwnerSpendRequest): OwnerSpend {
  if (coins.length === 0) throw new OwnerSpendError("No coins to spend");
  const network = NETWORKS[kit.btc_network];
  const script = unhex(kit.vault_script_hex);
  const template =
    path === "escape" ? kit.witness_templates.escape : kit.witness_templates.withdrawal;
  const output = baddress.toOutputScript(destination, network);

  const tx = new Transaction();
  tx.version = 2;
  // Escape: nSequence = the CSV value, so the node checks BIP68. Withdrawal: RBF-signalling.
  const sequence = path === "escape" ? kit.escape_timelock_blocks : 0xfffffffd;
  for (const coin of coins) tx.addInput(unhex(coin.txid).reverse(), coin.vout, sequence);
  tx.addOutput(output, 0n);

  // One signature slot and the script per input (the Withdrawal path also carries an empty
  // Co-signer slot of 1 byte); a rough witness size for the fee.
  const extra = path === "no_cosigner" ? 1 : 0;
  const perInput =
    1 + (1 + MAX_SIGNATURE_BYTES) + extra + 1 + (script.length < 0xfd ? 1 : 3) + script.length;
  const witnessBytes = 2 + coins.length * perInput;
  const vsize = Math.ceil((tx.byteLength(false) * 4 + witnessBytes) / 4);
  const fee = BigInt(vsize) * BigInt(Math.max(0, Math.ceil(feeRateSatVb)));
  const total = coins.reduce((sum, coin) => sum + BigInt(coin.value_sats), 0n);
  const amount = total > fee ? total - fee : 0n;
  const payout = tx.outs[0];
  if (!payout) throw new OwnerSpendError("Missing output");
  payout.value = amount;

  coins.forEach((coin, i) => {
    const sighash = tx.hashForWitnessV0(
      i,
      script,
      BigInt(coin.value_sats),
      Transaction.SIGHASH_ALL,
    );
    const signature = signDer(sighash, ownerSecretKey);
    tx.setWitness(
      i,
      template.slots.map((slot) => fillSlot(slot, signature, script)),
    );
  });
  return {
    rawHex: tx.toHex(),
    txid: tx.getId(),
    destination,
    amount_sats: amount.toString(),
    fee_sats: fee.toString(),
  };
}

/** Fills one witness slot: the Owner signature, the script, or an empty push for anything else. */
function fillSlot(slot: WitnessSlot, ownerSignature: Uint8Array, script: Uint8Array): Uint8Array {
  if (slot.kind === "signature") return slot.signer === "owner" ? ownerSignature : new Uint8Array();
  if (slot.kind === "selector") return unhex(slot.hex);
  if (slot.kind === "script") return script;
  return new Uint8Array();
}
