// SegWit addresses checked in the browser the way the Vault Contract checks them
// (contracts/vault/src/core/address.rs): the network's HRP, a valid bech32 (v0) or bech32m
// (v1) checksum, and the program length. The contract accepts witness versions 0 and 1 only.
// Pure: @scure/base and @noble only, no bitcoinjs-lib.
import { randomBytes } from "@noble/hashes/utils.js";
import { bech32, bech32m } from "@scure/base";
import type { BtcNetwork } from "../contract/types.js";

/** The bech32 human-readable part of each network. */
export const SEGWIT_HRP: Record<BtcNetwork, string> = {
  bitcoin: "bc",
  signet: "tb",
  testnet4: "tb",
  regtest: "bcrt",
};

/** BIP173: a SegWit address is at most 90 characters. */
const MAX_LENGTH = 90;

export type SegwitAddressProblem =
  /** Not bech32 or bech32m at all, or a bad checksum, or mixed case. */
  | "malformed"
  /** Valid, but for another network. */
  | "network"
  /** A witness version the contract does not accept (2 to 16). */
  | "version"
  /** A program length its version does not allow, or the wrong checksum kind. */
  | "program";

export type SegwitAddress =
  { ok: true; version: 0 | 1; program: Uint8Array } | { ok: false; problem: SegwitAddressProblem };

type Bech32Text = `${string}1${string}`;

function decodeWith(
  coder: typeof bech32,
  address: string,
): { prefix: string; words: number[] } | null {
  try {
    return coder.decode(address as Bech32Text, MAX_LENGTH);
  } catch {
    return null;
  }
}

/** Decodes `address` for `network`, or says what is wrong with it. */
export function decodeSegwitAddress(address: string, network: BtcNetwork): SegwitAddress {
  const text = address.trim();
  if (text.length === 0 || text.length > MAX_LENGTH) return { ok: false, problem: "malformed" };
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    return { ok: false, problem: "malformed" };
  }
  const lower = text.toLowerCase();
  const plain = decodeWith(bech32, lower);
  const modern = plain ? null : decodeWith(bech32m, lower);
  const decoded = plain ?? modern;
  if (!decoded || decoded.words.length === 0) return { ok: false, problem: "malformed" };
  if (decoded.prefix !== SEGWIT_HRP[network]) return { ok: false, problem: "network" };
  const [version, ...data] = decoded.words as [number, ...number[]];
  if (version > 16) return { ok: false, problem: "malformed" };
  if (version > 1) return { ok: false, problem: "version" };
  let program: Uint8Array;
  try {
    program = bech32.fromWords(data);
  } catch {
    return { ok: false, problem: "program" };
  }
  // BIP350: v0 uses bech32, v1+ bech32m.
  if (version === 0 && (!plain || (program.length !== 20 && program.length !== 32))) {
    return { ok: false, problem: "program" };
  }
  if (version === 1 && (!modern || program.length !== 32)) {
    return { ok: false, problem: "program" };
  }
  return { ok: true, version: version as 0 | 1, program };
}

/**
 * A fresh random P2WPKH address on `network`: a v0 witness program of 20 random bytes. No key
 * hashes to it that anyone knows, so coins sent there are out of everyone's reach, exactly like
 * the address of a key drawn and thrown away, without drawing one.
 */
export function randomP2wpkhAddress(network: BtcNetwork): string {
  return bech32.encode(SEGWIT_HRP[network], [0, ...bech32.toWords(randomBytes(20))]);
}
