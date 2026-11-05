import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { KEY_ENV, isFullAccess, loadSigningKey } from "./rpc.js";

describe("isFullAccess", () => {
  it("counts FullAccess and GasKeyFullAccess as full access", () => {
    expect(isFullAccess("FullAccess")).toBe(true);
    expect(isFullAccess({ GasKeyFullAccess: { balance: "0", num_nonces: 2 } })).toBe(true);
  });

  it("does not count function-call keys, plain or gas", () => {
    expect(isFullAccess({ FunctionCall: { receiver_id: "x", method_names: [] } })).toBe(false);
    expect(isFullAccess({ GasKeyFunctionCall: { receiver_id: "x", method_names: [] } })).toBe(
      false,
    );
  });

  it("counts a permission it does not recognise as full access", () => {
    expect(isFullAccess({ SomeFutureKind: {} })).toBe(true);
    expect(isFullAccess("Other")).toBe(true);
    expect(isFullAccess(null)).toBe(true);
  });
});

describe("loadSigningKey", () => {
  const key = KeyPair.fromRandom("ed25519");
  const secret = key.toString();

  function credentials(content: unknown) {
    const home = mkdtempSync(join(tmpdir(), "morrow-deploy-home-"));
    mkdirSync(join(home, ".near-credentials", "testnet"), { recursive: true });
    writeFileSync(
      join(home, ".near-credentials", "testnet", "x.testnet.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return home;
  }

  it("prefers MORROW_DEPLOY_PRIVATE_KEY", () => {
    const loaded = loadSigningKey("x.testnet", "testnet", { [KEY_ENV]: secret }, "/nowhere");
    expect(loaded.getPublicKey().toString()).toBe(key.getPublicKey().toString());
  });

  it("reads the near-api-js credential file", () => {
    const home = credentials({ account_id: "x.testnet", private_key: secret });
    const loaded = loadSigningKey("x.testnet", "testnet", {}, home);
    expect(loaded.getPublicKey().toString()).toBe(key.getPublicKey().toString());
  });

  it("refuses a credential file for another account", () => {
    const home = credentials({ account_id: "y.testnet", private_key: secret });
    expect(() => loadSigningKey("x.testnet", "testnet", {}, home)).toThrow(
      /is for y.testnet, not x.testnet/,
    );
  });

  it("names where it looked when there is no key", () => {
    expect(() => loadSigningKey("x.testnet", "testnet", {}, "/nowhere")).toThrow(
      `No key for x.testnet: set ${KEY_ENV} or create /nowhere/.near-credentials/testnet/x.testnet.json`,
    );
  });

  it("never quotes a bad key in its error", () => {
    const bad = "ed25519:notARealKeyButSecretLooking";
    let message = "";
    try {
      loadSigningKey("x.testnet", "testnet", { [KEY_ENV]: bad }, "/nowhere");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${KEY_ENV} is not a valid NEAR private key`);
    const home = credentials({ private_key: bad });
    expect(() => loadSigningKey("x.testnet", "testnet", {}, home)).toThrow(
      /x\.testnet\.json is not a valid NEAR private key$/,
    );
  });
});
