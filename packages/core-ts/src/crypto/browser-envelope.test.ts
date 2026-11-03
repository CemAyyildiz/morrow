import sodium from "libsodium-wrappers-sumo";
import { describe, expect, it } from "vitest";
import { boxSeal, sealWatcherEnvelope } from "./browser-envelope.js";
import { generateEnvelopeKeypair, openEnvelope } from "./envelope.js";

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("the Watcher Envelope sealed without libsodium", () => {
  it("opens with libsodium crypto_box_seal_open and keeps the flag byte", async () => {
    await sodium.ready;
    const keypair = await generateEnvelopeKeypair();
    for (const flag of ["normal", "duress"] as const) {
      const envelope = sealWatcherEnvelope(flag, keypair.publicKeyHex);
      expect(envelope).toMatch(/^[0-9a-f]{160}$/);
      const plaintext = sodium.crypto_box_seal_open(
        fromHex(envelope),
        fromHex(keypair.publicKeyHex),
        fromHex(keypair.secretKeyHex),
      );
      expect(plaintext).toHaveLength(32);
      expect(plaintext[0]).toBe(flag === "normal" ? 0x00 : 0x01);
      expect(await openEnvelope(envelope, keypair)).toBe(flag);
    }
  });

  it("matches libsodium byte for byte for the same ephemeral key", async () => {
    await sodium.ready;
    const recipient = sodium.crypto_box_keypair();
    const ephemeral = sodium.crypto_box_keypair();
    const plaintext = sodium.randombytes_buf(32);
    const ours = boxSeal(plaintext, recipient.publicKey, ephemeral.privateKey);
    // crypto_box_seal = epk ‖ crypto_box_easy(m, blake2b(epk ‖ pk, 24), pk, esk).
    const nonce = sodium.crypto_generichash(
      24,
      new Uint8Array([...ephemeral.publicKey, ...recipient.publicKey]),
      null,
    );
    const theirs = sodium.crypto_box_easy(
      plaintext,
      nonce,
      recipient.publicKey,
      ephemeral.privateKey,
    );
    expect(ours).toEqual(new Uint8Array([...ephemeral.publicKey, ...theirs]));
  });

  it("draws a fresh ephemeral key and padding every time", async () => {
    const keypair = await generateEnvelopeKeypair();
    const a = sealWatcherEnvelope("normal", keypair.publicKeyHex);
    const b = sealWatcherEnvelope("normal", keypair.publicKeyHex);
    expect(a).not.toBe(b);
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });

  it("refuses a watcher key that is not 32 bytes of hex", () => {
    expect(() => sealWatcherEnvelope("normal", "ab".repeat(31))).toThrow(/32 bytes/);
    expect(() => sealWatcherEnvelope("normal", "zz".repeat(32))).toThrow(/hex/);
  });
});
