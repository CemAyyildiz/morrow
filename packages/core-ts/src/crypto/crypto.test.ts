import { describe, expect, it } from "vitest";
import { WITNESS_TEMPLATES } from "../contract/mock.js";
import { recomputeAddress } from "./address.js";
import { generateEnvelopeKeypair, openEnvelope, sealEnvelope } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { encodeSignature, mpcSignatureToDer, toLowS } from "./signature.js";
import { fillWitness } from "./witness.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("recomputeAddress", () => {
  // BIP173 P2WSH test vector: <pubkey> OP_CHECKSIG.
  const script = "210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";

  it("matches the BIP173 testnet and mainnet vectors", () => {
    expect(recomputeAddress(script, "signet")).toBe(
      "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
    );
    expect(recomputeAddress(script, "testnet4")).toBe(
      "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
    );
    expect(recomputeAddress(script, "bitcoin")).toBe(
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    );
  });

  it("uses the regtest prefix on regtest", () => {
    expect(recomputeAddress(script, "regtest")).toMatch(
      /^bcrt1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q/,
    );
  });

  it("changes when one script byte changes", () => {
    const tampered = `${script.slice(0, -4)}00ac`;
    expect(recomputeAddress(tampered, "signet")).not.toBe(recomputeAddress(script, "signet"));
  });
});

describe("signatures", () => {
  it("normalizes high S to n − s", () => {
    expect(toLowS(N - 1n)).toBe(1n);
    expect(toLowS(5n)).toBe(5n);
  });

  it("DER-encodes with SIGHASH_ALL and pads integers with the top bit set", () => {
    expect(encodeSignature(1n, 1n)).toBe("300602010102010101");
    expect(encodeSignature(0x80n, N - 1n)).toBe("30070202008002010101");
  });

  it("converts an MPC response, taking r from big_r's x coordinate", () => {
    const der = mpcSignatureToDer({
      big_r: { affine_point: `02${"11".repeat(32)}` },
      s: { scalar: (N - 2n).toString(16) },
      recovery_id: 0,
    });
    expect(der).toBe(`30250220${"11".repeat(32)}02010201`);
  });

  it("rejects malformed or out-of-range signatures", () => {
    expect(() =>
      mpcSignatureToDer({ big_r: { affine_point: "04" }, s: { scalar: "01".repeat(32) } }),
    ).toThrow(CryptoError);
    expect(() =>
      mpcSignatureToDer({
        big_r: { affine_point: `02${"00".repeat(32)}` },
        s: { scalar: "01".repeat(32) },
      }),
    ).toThrow(/r is out of range/);
    expect(() =>
      mpcSignatureToDer({
        big_r: { affine_point: `02${"11".repeat(32)}` },
        s: { scalar: N.toString(16) },
      }),
    ).toThrow(/s is out of range/);
  });
});

describe("fillWitness", () => {
  it("fills the withdrawal template in slot order with the selector", () => {
    const stack = fillWitness(WITNESS_TEMPLATES.withdrawal, {
      signatures: { owner: "aa01", cosigner: "bb01" },
      scriptHex: "51",
    });
    expect(stack).toEqual(["bb01", "aa01", "01", "51"]);
  });

  it("fills the clawback template with the CHECKMULTISIG dummy and the empty Escape selector", () => {
    const stack = fillWitness(WITNESS_TEMPLATES.clawback, {
      signatures: { guardian: "cc01", cosigner: "bb01" },
      scriptHex: "51",
    });
    expect(stack).toEqual(["", "cc01", "bb01", "01", "", "51"]);
  });

  it("rejects a missing signature", () => {
    expect(() =>
      fillWitness(WITNESS_TEMPLATES.withdrawal, { signatures: { owner: "aa01" }, scriptHex: "51" }),
    ).toThrow(/Missing cosigner signature/);
  });
});

describe("Watcher Envelope", () => {
  it("seals to 80 bytes and opens to the right flag", async () => {
    const keypair = await generateEnvelopeKeypair();
    const duress = await sealEnvelope("duress", keypair.publicKeyHex);
    const normal = await sealEnvelope("normal", keypair.publicKeyHex);
    expect(duress).toMatch(/^[0-9a-f]{160}$/);
    expect(normal).toMatch(/^[0-9a-f]{160}$/);
    expect(await openEnvelope(duress, keypair)).toBe("duress");
    expect(await openEnvelope(normal, keypair)).toBe("normal");
  });

  it("never repeats ciphertexts, so envelopes cannot be matched", async () => {
    const { publicKeyHex } = await generateEnvelopeKeypair();
    const a = await sealEnvelope("normal", publicKeyHex);
    const b = await sealEnvelope("normal", publicKeyHex);
    expect(a).not.toBe(b);
  });

  it("rejects a wrong key or a wrong length", async () => {
    const owner = await generateEnvelopeKeypair();
    const other = await generateEnvelopeKeypair();
    const envelope = await sealEnvelope("normal", owner.publicKeyHex);
    await expect(openEnvelope(envelope, other)).rejects.toThrow(/cannot be opened/);
    await expect(openEnvelope(envelope.slice(2), owner)).rejects.toThrow(/80 bytes/);
    await expect(sealEnvelope("normal", "ab")).rejects.toThrow(/32 bytes/);
  });
});
