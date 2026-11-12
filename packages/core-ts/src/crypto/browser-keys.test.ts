import { secp256k1 } from "@noble/curves/secp256k1.js";
import { networks, payments } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { decodeSegwitAddress } from "../bitcoin/browser-address.js";
import { sealWatcherEnvelope } from "./browser-envelope.js";
import {
  compressedPublicKey,
  decodeWif,
  encodeWif,
  p2wpkhAddress,
  randomSecretKey,
  randomX25519SecretKey,
  x25519PublicKey,
} from "./browser-keys.js";
import { bytesToHex } from "./hex.js";

describe("browser keys", () => {
  it("draws distinct secp256k1 keys with compressed public keys", () => {
    const a = randomSecretKey();
    const b = randomSecretKey();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(compressedPublicKey(a)).toBe(bytesToHex(secp256k1.getPublicKey(a, true)));
    expect(compressedPublicKey(a)).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(() => compressedPublicKey(new Uint8Array(32))).toThrow(/valid/);
  });

  it("draws X25519 keys a Watcher Envelope can be sealed to", () => {
    const pk = x25519PublicKey(randomX25519SecretKey());
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
    expect(sealWatcherEnvelope("normal", pk)).toMatch(/^[0-9a-f]{160}$/);
  });

  it("derives the P2WPKH address bitcoinjs-lib derives", () => {
    const secret = new Uint8Array(32).fill(7);
    const pub = compressedPublicKey(secret);
    const expected = payments.p2wpkh({
      pubkey: Buffer.from(pub, "hex"),
      network: networks.testnet,
    }).address;
    expect(p2wpkhAddress(pub, "signet")).toBe(expected);
    expect(decodeSegwitAddress(p2wpkhAddress(pub, "signet"), "signet").ok).toBe(true);
    expect(() => p2wpkhAddress("04", "signet")).toThrow(/compressed/);
  });

  it("encodes the well-known WIF vectors, and decodes them back", () => {
    const one = new Uint8Array(32);
    one[31] = 1;
    expect(encodeWif(one, "bitcoin")).toBe("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
    const wif = encodeWif(one, "signet");
    expect(wif).toBe("cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA");
    expect(bytesToHex(decodeWif(wif, "signet"))).toBe(bytesToHex(one));
    const random = randomSecretKey();
    expect(bytesToHex(decodeWif(encodeWif(random, "signet"), "signet"))).toBe(bytesToHex(random));
    expect(() => decodeWif(wif, "bitcoin")).toThrow(/network/);
    expect(() => decodeWif("nope", "signet")).toThrow(/WIF/);
  });
});
