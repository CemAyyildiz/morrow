/**
 * Escape Path spending from a Vault Kit and the Owner Key alone. No NEAR, no Morrow service:
 * only Bitcoin libraries.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { address as baddress, networks, Transaction, type Network } from "bitcoinjs-lib";

export type BtcNetwork = "regtest" | "signet" | "testnet4" | "bitcoin";

export type WitnessSlot =
  | { kind: "signature"; signer: string }
  | { kind: "selector"; hex: string }
  | { kind: "empty" }
  | { kind: "script" };

export interface VaultKit {
  kit_version: 1;
  btc_network: BtcNetwork;
  vault_script_hex: string;
  allowance_script_hex: string;
  addresses: { vault: string; allowance: string };
  escape_timelock_blocks: number;
  witness_templates: { path: string; slots: WitnessSlot[] }[];
}

/** A coin to escape: display-order txid, value, confirmation height and which address holds it. */
export interface EscapeCoin {
  txid: string;
  vout: number;
  value_sats: bigint;
  height: number;
  source: "vault" | "allowance";
}

export class EscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscapeError";
  }
}

const NETWORKS: Record<BtcNetwork, Network> = {
  bitcoin: networks.bitcoin,
  signet: networks.testnet,
  testnet4: networks.testnet,
  regtest: networks.regtest,
};
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DUST_LIMIT_SATS = 546n;
const MAX_SIGNATURE_BYTES = 73;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

export function parseKit(json: string): VaultKit {
  const kit = JSON.parse(json) as VaultKit;
  if (kit.kit_version !== 1)
    throw new EscapeError(`Unsupported Vault Kit version ${String(kit.kit_version)}`);
  if (!Number.isInteger(kit.escape_timelock_blocks) || kit.escape_timelock_blocks < 1) {
    throw new EscapeError("Vault Kit has no valid escape_timelock_blocks");
  }
  if (!kit.witness_templates.some((t) => t.path === "escape"))
    throw new EscapeError("Vault Kit has no escape template");
  return kit;
}

/**
 * Blocks still to wait before every coin can be spent in the next block (CSV is relative to each
 * coin's confirmation). 0 means ready.
 */
export function blocksRemaining(coins: EscapeCoin[], tipHeight: number, timelock: number): number {
  return Math.max(0, ...coins.map((coin) => coin.height + timelock - (tipHeight + 1)));
}

/** Minimal big-endian bytes of a positive integer, padded when the top bit is set (DER). */
function derInteger(value: bigint): Uint8Array {
  let h = value.toString(16);
  if (h.length % 2) h = `0${h}`;
  const bytes = unhex(h);
  return (bytes[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...bytes) : bytes;
}

/** Low-S DER signature with SIGHASH_ALL. */
function signDer(sighash: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const compact = secp256k1.sign(sighash, secretKey, { prehash: false });
  const r = BigInt(`0x${hex(compact.subarray(0, 32))}`);
  let s = BigInt(`0x${hex(compact.subarray(32))}`);
  if (s > N / 2n) s = N - s;
  const [rBytes, sBytes] = [derInteger(r), derInteger(s)];
  const body = [0x02, rBytes.length, ...rBytes, 0x02, sBytes.length, ...sBytes];
  return Uint8Array.of(0x30, body.length, ...body, Transaction.SIGHASH_ALL);
}

export interface EscapeRequest {
  kit: VaultKit;
  coins: EscapeCoin[];
  ownerSecretKey: Uint8Array;
  destination: string;
  feeRateSatVb: number;
  tipHeight: number;
}

export interface EscapeResult {
  rawHex: string;
  txid: string;
  fee_sats: bigint;
  amount_sats: bigint;
}

/** Builds and signs the Escape Path transaction, refusing before the timelock has matured. */
export function buildEscape({
  kit,
  coins,
  ownerSecretKey,
  destination,
  feeRateSatVb,
  tipHeight,
}: EscapeRequest): EscapeResult {
  if (coins.length === 0) throw new EscapeError("No coins to escape");
  const remaining = blocksRemaining(coins, tipHeight, kit.escape_timelock_blocks);
  if (remaining > 0)
    throw new EscapeError(`Escape Timelock not reached: ${remaining} blocks remaining`);

  const network = NETWORKS[kit.btc_network];
  const scripts = {
    vault: unhex(kit.vault_script_hex),
    allowance: unhex(kit.allowance_script_hex),
  };
  const template = kit.witness_templates.find((t) => t.path === "escape")?.slots ?? [];
  const output = baddress.toOutputScript(destination, network);

  const tx = new Transaction();
  tx.version = 2;
  for (const coin of coins)
    tx.addInput(unhex(coin.txid).reverse(), coin.vout, kit.escape_timelock_blocks);
  tx.addOutput(output, 0n);

  const witnessBytes = coins.reduce((sum, coin) => {
    const script = scripts[coin.source].length;
    return sum + 1 + (1 + MAX_SIGNATURE_BYTES) + 1 + 1 + (script < 0xfd ? 1 : 3) + script;
  }, 2);
  const vsize = Math.ceil((tx.byteLength(false) * 4 + witnessBytes) / 4);
  const fee = BigInt(vsize) * BigInt(feeRateSatVb);
  const total = coins.reduce((sum, coin) => sum + coin.value_sats, 0n);
  const amount = total - fee;
  if (amount < DUST_LIMIT_SATS)
    throw new EscapeError(`Coins (${total} sats) do not cover the fee (${fee} sats)`);
  const [payout] = tx.outs;
  if (!payout) throw new EscapeError("Missing output");
  payout.value = amount;

  coins.forEach((coin, i) => {
    const script = scripts[coin.source];
    const sighash = tx.hashForWitnessV0(i, script, coin.value_sats, Transaction.SIGHASH_ALL);
    const signature = signDer(sighash, ownerSecretKey);
    tx.setWitness(
      i,
      template.map((slot) => {
        if (slot.kind === "signature") return signature;
        if (slot.kind === "selector") return unhex(slot.hex);
        if (slot.kind === "script") return script;
        return new Uint8Array();
      }),
    );
  });
  return { rawHex: tx.toHex(), txid: tx.getId(), fee_sats: fee, amount_sats: amount };
}
