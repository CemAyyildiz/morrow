// Keys an end user's browser draws for a new Vault, pure (@noble and @scure only): secp256k1
// keys for the Owner and the Backup Device Guardian, an X25519 key for Watcher Envelopes, and
// a P2WPKH test Recovery Address with its WIF. Nothing here stores or sends a key.
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, createBase58check } from "@scure/base";
import { SEGWIT_HRP } from "../bitcoin/browser-address.js";
import type { BtcNetwork, Hex } from "../contract/types.js";
import { CryptoError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./hex.js";

const base58check = createBase58check(sha256);

/** WIF version bytes: 0x80 on mainnet, 0xef on every test network. */
const WIF_VERSION: Record<BtcNetwork, number> = {
  bitcoin: 0x80,
  testnet4: 0xef,
  signet: 0xef,
  regtest: 0xef,
};

/** A fresh secp256k1 secret key (32 bytes). */
export function randomSecretKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

/** The 33-byte compressed public key of a secp256k1 secret key, as hex. */
export function compressedPublicKey(secretKey: Uint8Array): Hex {
  if (!secp256k1.utils.isValidSecretKey(secretKey)) {
    throw new CryptoError("Not a valid secp256k1 secret key");
  }
  return bytesToHex(secp256k1.getPublicKey(secretKey, true));
}

/** A fresh X25519 secret key (32 bytes), the kind Watcher Envelopes are sealed to. */
export function randomX25519SecretKey(): Uint8Array {
  return x25519.utils.randomSecretKey();
}

/** The X25519 public key of a secret key, as hex. */
export function x25519PublicKey(secretKey: Uint8Array): Hex {
  if (secretKey.length !== 32) throw new CryptoError("An X25519 secret key is 32 bytes");
  return bytesToHex(x25519.getPublicKey(secretKey));
}

/** The P2WPKH (v0, 20-byte key hash) address of a compressed public key on `network`. */
export function p2wpkhAddress(publicKey: Hex, network: BtcNetwork): string {
  if (!/^0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new CryptoError("A P2WPKH key must be a 33-byte compressed key");
  }
  const program = ripemd160(sha256(hexToBytes(publicKey)));
  return bech32.encode(SEGWIT_HRP[network], [0, ...bech32.toWords(program)]);
}

/** The WIF of a secret key for a compressed public key, as wallets import it. */
export function encodeWif(secretKey: Uint8Array, network: BtcNetwork): string {
  compressedPublicKey(secretKey);
  return base58check.encode(Uint8Array.of(WIF_VERSION[network], ...secretKey, 0x01));
}

/** The secret key in a compressed-key WIF for `network`; throws on anything else. */
export function decodeWif(wif: string, network: BtcNetwork): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58check.decode(wif.trim());
  } catch {
    throw new CryptoError("Not a WIF");
  }
  if (bytes.length !== 34 || bytes[0] !== WIF_VERSION[network] || bytes[33] !== 0x01) {
    throw new CryptoError("Not a compressed-key WIF for this network");
  }
  const secretKey = bytes.slice(1, 33);
  compressedPublicKey(secretKey);
  return secretKey;
}
