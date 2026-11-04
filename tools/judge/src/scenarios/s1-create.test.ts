import { describe, expect, it } from "vitest";
import { judgeAccountId } from "../session.js";
import { signerAccountOf } from "./s1-create.js";

describe("judgeAccountId", () => {
  it("is a valid, unique-looking testnet account id", () => {
    const id = judgeAccountId(1_762_070_400_000, 0.123456789);
    expect(id).toMatch(/^morrow-judge-[a-z0-9]+-[a-z0-9]{1,6}\.testnet$/);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(judgeAccountId(1, 0.5)).not.toBe(judgeAccountId(2, 0.5));
  });
});

describe("signerAccountOf", () => {
  it("names the signer the deployment really uses, so a mock signer shows up in the S-1 line", () => {
    expect(signerAccountOf({ signer_account: "v1.signer-prod.testnet", version: "0.1.0" })).toBe(
      "v1.signer-prod.testnet",
    );
    expect(signerAccountOf({ signer_account: "mock-signer.test.near" })).toBe(
      "mock-signer.test.near",
    );
  });

  it("refuses a config without a signer_account", () => {
    for (const config of [null, {}, { signer_account: "" }, { signer_account: 7 }]) {
      expect(() => signerAccountOf(config)).toThrow("get_config has no signer_account");
    }
  });
});
