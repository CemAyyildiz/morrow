import sodium from "libsodium-wrappers-sumo";
import { ENVELOPE_HEX_LENGTH } from "../contract/policy.js";
import { CryptoError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./hex.js";

export type EnvelopeFlag = "normal" | "duress";

const PLAINTEXT_BYTES = 32;
const FLAG_BYTE: Record<EnvelopeFlag, number> = { normal: 0x00, duress: 0x01 };

async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

/**
 * Seals a Watcher Envelope to the watcher's X25519 key: 1 flag byte + 31 random bytes, sealed
 * with crypto_box_seal into exactly 80 bytes. Normal and duress envelopes are indistinguishable.
 */
export async function sealEnvelope(
  flag: EnvelopeFlag,
  watcherPublicKeyHex: string,
): Promise<string> {
  const lib = await ready();
  const publicKey = hexToBytes(watcherPublicKeyHex);
  if (publicKey.length !== lib.crypto_box_PUBLICKEYBYTES)
    throw new CryptoError("Watcher key must be 32 bytes");
  const plaintext = lib.randombytes_buf(PLAINTEXT_BYTES);
  plaintext[0] = FLAG_BYTE[flag];
  const envelope = bytesToHex(lib.crypto_box_seal(plaintext, publicKey));
  if (envelope.length !== ENVELOPE_HEX_LENGTH) throw new CryptoError("Unexpected envelope length");
  return envelope;
}

export interface EnvelopeKeypair {
  publicKeyHex: string;
  secretKeyHex: string;
}

/** Watcher side: a fresh X25519 keypair for receiving envelopes. */
export async function generateEnvelopeKeypair(): Promise<EnvelopeKeypair> {
  const lib = await ready();
  const { publicKey, privateKey } = lib.crypto_box_keypair();
  return { publicKeyHex: bytesToHex(publicKey), secretKeyHex: bytesToHex(privateKey) };
}

/** Watcher side: opens an envelope and returns its flag. */
export async function openEnvelope(
  envelopeHex: string,
  keypair: EnvelopeKeypair,
): Promise<EnvelopeFlag> {
  const lib = await ready();
  if (envelopeHex.length !== ENVELOPE_HEX_LENGTH)
    throw new CryptoError("Envelope must be 80 bytes");
  let plaintext: Uint8Array;
  try {
    plaintext = lib.crypto_box_seal_open(
      hexToBytes(envelopeHex),
      hexToBytes(keypair.publicKeyHex),
      hexToBytes(keypair.secretKeyHex),
    );
  } catch {
    throw new CryptoError("Envelope cannot be opened with this key");
  }
  if (plaintext.length !== PLAINTEXT_BYTES) throw new CryptoError("Unexpected envelope plaintext");
  return plaintext[0] === FLAG_BYTE.duress ? "duress" : "normal";
}
