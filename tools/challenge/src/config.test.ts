import { describe, expect, it } from "vitest";
import { loadBaseConfig, loadNearConfig, loadPolicyConfig } from "./config.js";

const policyEnv = {
  MORROW_CHALLENGE_GUARDIAN_ACCOUNT: "watcher-guardian.testnet",
  MORROW_CHALLENGE_GUARDIAN_KEY: `03${"22".repeat(32)}`,
  MORROW_CHALLENGE_WATCHER_X25519_PK: "44".repeat(32),
  MORROW_CHALLENGE_RECOVERY_KEY: "11".repeat(32),
};
const nearEnv = {
  MORROW_VAULT_CONTRACT: "vault.testnet",
  MORROW_CHALLENGE_OWNER_PARENT: "challenge.testnet",
  MORROW_CHALLENGE_PARENT_KEY: "ed25519:parent",
};

describe("loadBaseConfig", () => {
  it("defaults the state file, the signet backend and the port", () => {
    expect(loadBaseConfig({})).toEqual({
      stateFile: ".challenge-state/rounds.json",
      btcBackendUrl: "https://mempool.space/signet/api",
      port: 8081,
    });
    expect(loadBaseConfig({ MORROW_CHALLENGE_PORT: "9000" }).port).toBe(9000);
    expect(() => loadBaseConfig({ MORROW_CHALLENGE_PORT: "0" })).toThrow(/MORROW_CHALLENGE_PORT/);
  });
});

describe("loadPolicyConfig", () => {
  it("defaults fund sats and fee rate, with no overrides", () => {
    expect(loadPolicyConfig(policyEnv)).toMatchObject({
      fundSats: 100_000n,
      feeRate: 2,
      policyOverrides: {},
    });
    expect(
      loadPolicyConfig({
        ...policyEnv,
        MORROW_CHALLENGE_FUND_SATS: "250000",
        MORROW_CHALLENGE_FEE_RATE: "5",
      }),
    ).toMatchObject({ fundSats: 250_000n, feeRate: 5 });
    expect(() => loadPolicyConfig({ ...policyEnv, MORROW_CHALLENGE_FEE_RATE: "1.5" })).toThrow(
      /MORROW_CHALLENGE_FEE_RATE/,
    );
  });

  it.each([
    ["MORROW_CHALLENGE_GUARDIAN_KEY", `04${"22".repeat(32)}`],
    ["MORROW_CHALLENGE_GUARDIAN_KEY", "22".repeat(33)],
    ["MORROW_CHALLENGE_WATCHER_X25519_PK", "44".repeat(31)],
    ["MORROW_CHALLENGE_RECOVERY_KEY", "zz".repeat(32)],
    ["MORROW_CHALLENGE_GUARDIAN_ACCOUNT", "Not An Account"],
    ["MORROW_CHALLENGE_GUARDIAN_ACCOUNT", "a"],
  ])("refuses a bad %s", (name, value) => {
    expect(() => loadPolicyConfig({ ...policyEnv, [name]: value })).toThrow(name);
  });

  it("refuses a missing key", () => {
    expect(() => loadPolicyConfig({ ...policyEnv, MORROW_CHALLENGE_RECOVERY_KEY: "" })).toThrow(
      /MORROW_CHALLENGE_RECOVERY_KEY/,
    );
  });

  it("parses MORROW_CHALLENGE_POLICY and refuses invalid JSON or non-objects", () => {
    expect(
      loadPolicyConfig({ ...policyEnv, MORROW_CHALLENGE_POLICY: '{"fee_cap_sats":"20000"}' })
        .policyOverrides,
    ).toEqual({ fee_cap_sats: "20000" });
    expect(() => loadPolicyConfig({ ...policyEnv, MORROW_CHALLENGE_POLICY: "{nope" })).toThrow(
      /MORROW_CHALLENGE_POLICY is not valid JSON/,
    );
    for (const value of ["[]", "42", "null", '"x"']) {
      expect(() => loadPolicyConfig({ ...policyEnv, MORROW_CHALLENGE_POLICY: value })).toThrow(
        /MORROW_CHALLENGE_POLICY must be a JSON object/,
      );
    }
  });
});

describe("loadNearConfig", () => {
  it("defaults to testnet", () => {
    expect(loadNearConfig(nearEnv)).toEqual({
      nearNetwork: "testnet",
      rpcUrl: "https://rpc.testnet.near.org",
      vaultContract: "vault.testnet",
      ownerParent: "challenge.testnet",
      parentKey: "ed25519:parent",
    });
  });

  it.each(["testnet", "a", "Bad.Parent", `${"a".repeat(60)}.testnet`])(
    "refuses owner parent %s",
    (parent) => {
      expect(() => loadNearConfig({ ...nearEnv, MORROW_CHALLENGE_OWNER_PARENT: parent })).toThrow(
        /MORROW_CHALLENGE_OWNER_PARENT must be a NEAR sub-account id/,
      );
    },
  );
});
