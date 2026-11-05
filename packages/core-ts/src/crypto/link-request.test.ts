import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { canonicalChangesJson } from "../contract/policy.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import {
  linkRequestMessage,
  linkRequestProblems,
  signLinkRequest,
  verifyLinkRequest,
  type LinkRequest,
} from "./link-request.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECRET = hexToBytes("11".repeat(32));
const OTHER = hexToBytes("22".repeat(32));
const PUBLIC = bytesToHex(secp256k1.getPublicKey(SECRET, true));
const REQUEST: LinkRequest = {
  vault_id: "7",
  role: "owner",
  account_id: "daniel.testnet",
  ts: "1793608920000000000",
};

describe("link requests", () => {
  it("signs the fixed message and verifies under the signing key only", () => {
    expect(linkRequestMessage(REQUEST)).toBe(
      "morrow-link:v1:7:owner:daniel.testnet:1793608920000000000",
    );
    const signature = signLinkRequest(REQUEST, SECRET);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(BigInt(`0x${signature.slice(64)}`) <= N >> 1n).toBe(true);
    expect(verifyLinkRequest(REQUEST, signature, PUBLIC)).toBe(true);
    const otherPublic = bytesToHex(secp256k1.getPublicKey(OTHER, true));
    expect(verifyLinkRequest(REQUEST, signature, otherPublic)).toBe(false);
  });

  it("binds every field", () => {
    const signature = signLinkRequest(REQUEST, SECRET);
    for (const changed of [
      { vault_id: "8" },
      { role: "guardian" as const },
      { account_id: "thief.testnet" },
      { ts: "1793608920000000001" },
    ]) {
      expect(verifyLinkRequest({ ...REQUEST, ...changed }, signature, PUBLIC)).toBe(false);
    }
  });

  it("refuses a high-S signature and malformed input without throwing", () => {
    const signature = signLinkRequest(REQUEST, SECRET);
    const highS = (N - BigInt(`0x${signature.slice(64)}`)).toString(16).padStart(64, "0");
    expect(verifyLinkRequest(REQUEST, `${signature.slice(0, 64)}${highS}`, PUBLIC)).toBe(false);
    expect(verifyLinkRequest(REQUEST, "zz", PUBLIC)).toBe(false);
    expect(verifyLinkRequest(REQUEST, signature, "02ab")).toBe(false);
    expect(verifyLinkRequest({ ...REQUEST, ts: "01" }, signature, PUBLIC)).toBe(false);
    expect(verifyLinkRequest({ ...REQUEST, account_id: "a:b" }, signature, PUBLIC)).toBe(false);
  });

  it("names each malformed field and refuses to sign one", () => {
    expect(
      linkRequestProblems({ vault_id: "x", role: "admin", account_id: "A", ts: -1 }),
    ).toHaveLength(4);
    expect(linkRequestProblems(REQUEST)).toEqual([]);
    expect(() => signLinkRequest({ ...REQUEST, account_id: "a:owner" }, SECRET)).toThrow();
  });
});

describe("canonicalChangesJson", () => {
  it("sorts keys so equal changes give equal strings", () => {
    expect(canonicalChangesJson({ fee_cap_sats: "2", delay_ns: "1", fast_approval: true })).toBe(
      '{"delay_ns":"1","fast_approval":true,"fee_cap_sats":"2"}',
    );
    expect(canonicalChangesJson({ b: "1", a: "2" })).toBe(canonicalChangesJson({ a: "2", b: "1" }));
  });
});
