// The Watcher Envelope sealed in the browser without libsodium: `crypto_box_seal` rebuilt from
// @noble x25519, hsalsa20, xsalsa20poly1305 and blake2b. libsodium's `crypto_box_seal_open`
// opens it (browser-envelope.test.ts proves it), so the watcher reads it like any other.
//   esk, epk  = a fresh x25519 keypair
//   k         = hsalsa20(x25519(esk, pk), 0^16)          (crypto_box_beforenm)
//   nonce     = blake2b(epk ‖ pk, 24 bytes)
//   envelope  = epk ‖ xsalsa20poly1305(k, nonce).encrypt(plaintext)   (32 + 16 + 32 bytes)
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ENVELOPE_HEX_LENGTH } from "../contract/policy.js";

export type WatcherEnvelopeFlag = "normal" | "duress";

const PLAINTEXT_BYTES = 32;
const FLAG_BYTE: Record<WatcherEnvelopeFlag, number> = { normal: 0x00, duress: 0x01 };
/** `expand 32-byte k` as four little-endian words. */
const SIGMA = Uint32Array.of(0x61707865, 0x3320646e, 0x79622d32, 0x6b206574);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("Not a hex string");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function words(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

/** crypto_box_beforenm: hsalsa20 of the x25519 shared secret under a zero nonce. */
function beforenm(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  if (shared.every((b) => b === 0)) throw new Error("The watcher key is a low-order point");
  const out = new Uint32Array(8);
  hsalsa(SIGMA, words(shared), new Uint32Array(4), out);
  const key = new Uint8Array(32);
  const view = new DataView(key.buffer);
  out.forEach((word, i) => view.setUint32(i * 4, word, true));
  return key;
}

/** crypto_box_seal of `plaintext` to `publicKey`, with an ephemeral key from `ephemeralSecret`. */
export function boxSeal(
  plaintext: Uint8Array,
  publicKey: Uint8Array,
  ephemeralSecret: Uint8Array = x25519.utils.randomSecretKey(),
): Uint8Array {
  if (publicKey.length !== 32) throw new Error("An x25519 public key is 32 bytes");
  const epk = x25519.getPublicKey(ephemeralSecret);
  const nonce = blake2b(new Uint8Array([...epk, ...publicKey]), { dkLen: 24 });
  const sealed = xsalsa20poly1305(beforenm(ephemeralSecret, publicKey), nonce).encrypt(plaintext);
  return new Uint8Array([...epk, ...sealed]);
}

/**
 * A Watcher Envelope for `flag`, sealed to the Vault's `watcher_x25519_pk`: 1 flag byte and 31
 * random bytes, 80 bytes sealed, 160 lowercase hex characters. Normal and duress envelopes
 * look alike to everyone but the watcher.
 */
export function sealWatcherEnvelope(
  flag: WatcherEnvelopeFlag,
  watcherPublicKeyHex: string,
): string {
  const publicKey = fromHex(watcherPublicKeyHex);
  if (publicKey.length !== 32) throw new Error("The watcher key must be 32 bytes");
  const plaintext = randomBytes(PLAINTEXT_BYTES);
  plaintext[0] = FLAG_BYTE[flag];
  const envelope = toHex(boxSeal(plaintext, publicKey));
  if (envelope.length !== ENVELOPE_HEX_LENGTH) throw new Error("Unexpected envelope length");
  return envelope;
}
