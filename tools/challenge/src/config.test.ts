import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROTATION_MARGIN_BLOCKS,
  loadBaseConfig,
  loadNearConfig,
  loadPolicyConfig,
  loadAttackConfig,
  loadRunConfig,
} from "./config.js";

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
      attemptsFile: ".challenge-state/attempts.json",
      btcBackendUrl: "https://mempool.space/signet/api",
      port: 8081,
    });
    expect(loadBaseConfig({ MORROW_CHALLENGE_PORT: "9000" }).port).toBe(9000);
    expect(() => loadBaseConfig({ MORROW_CHALLENGE_PORT: "0" })).toThrow(/MORROW_CHALLENGE_PORT/);
    expect(
      loadBaseConfig({ MORROW_CHALLENGE_STATE_FILE: "/var/lib/challenge/state.json" }),
    ).toMatchObject({
      stateFile: "/var/lib/challenge/state.json",
      attemptsFile: "/var/lib/challenge/attempts.json",
    });
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

describe("loadRunConfig", () => {
  const runEnv = {
    MORROW_WATCHER_URL: "https://watcher.example",
    MORROW_WATCHER_ADMIN_TOKEN: "admin-token",
  };

  it("needs the watcher URL and admin token; defaults the margin to 144 blocks", () => {
    expect(loadRunConfig(runEnv)).toEqual({
      watcherUrl: "https://watcher.example",
      watcherAdminToken: "admin-token",
      rotationMarginBlocks: DEFAULT_ROTATION_MARGIN_BLOCKS,
      fastnearTxUrl: undefined,
      archivalRpcUrl: undefined,
    });
    expect(
      loadRunConfig({
        ...runEnv,
        MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS: "288",
        MORROW_FASTNEAR_TX_URL: "https://tx.test.fastnear.com",
      }),
    ).toMatchObject({ rotationMarginBlocks: 288, fastnearTxUrl: "https://tx.test.fastnear.com" });
    expect(DEFAULT_ROTATION_MARGIN_BLOCKS).toBe(144);
    expect(
      loadRunConfig({ ...runEnv, MORROW_NEAR_ARCHIVAL_RPC_URL: "https://archival.example" })
        .archivalRpcUrl,
    ).toBe("https://archival.example");
    expect(() =>
      loadRunConfig({ ...runEnv, MORROW_NEAR_ARCHIVAL_RPC_URL: "wss://archival.example" }),
    ).toThrow(/MORROW_NEAR_ARCHIVAL_RPC_URL must be an http/);
    expect(() => loadRunConfig({ ...runEnv, MORROW_WATCHER_ADMIN_TOKEN: "" })).toThrow(
      /MORROW_WATCHER_ADMIN_TOKEN/,
    );
    expect(() => loadRunConfig({ ...runEnv, MORROW_WATCHER_URL: "ftp://x" })).toThrow(
      /MORROW_WATCHER_URL must be an http/,
    );
    expect(() =>
      loadRunConfig({ ...runEnv, MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS: "-1" }),
    ).toThrow(/MORROW_CHALLENGE_ROTATION_MARGIN_BLOCKS/);
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

describe("loadAttackConfig", () => {
  it("needs only MORROW_CHALLENGE_URL and defaults the rest", () => {
    expect(loadAttackConfig({ MORROW_CHALLENGE_URL: "https://challenge.example/" })).toEqual({
      challengeUrl: "https://challenge.example",
      nearNetwork: "testnet",
      rpcUrl: "https://rpc.testnet.near.org",
      btcBackendUrl: "https://mempool.space/signet/api",
    });
  });

  it("reads the public overrides and never asks for an operator secret", () => {
    expect(
      loadAttackConfig({
        MORROW_CHALLENGE_URL: "http://127.0.0.1:8081",
        MORROW_NEAR_NETWORK: "mainnet",
        MORROW_NEAR_RPC_URL: "https://rpc.example",
        MORROW_BTC_BACKEND_URL: "https://esplora.example",
      }),
    ).toEqual({
      challengeUrl: "http://127.0.0.1:8081",
      nearNetwork: "mainnet",
      rpcUrl: "https://rpc.example",
      btcBackendUrl: "https://esplora.example",
    });
  });

  it("refuses a missing or non-http challenge URL and an unknown NEAR network", () => {
    expect(() => loadAttackConfig({})).toThrow(/MORROW_CHALLENGE_URL/);
    expect(() => loadAttackConfig({ MORROW_CHALLENGE_URL: "ftp://x" })).toThrow(/http/);
    expect(() =>
      loadAttackConfig({ MORROW_CHALLENGE_URL: "http://x", MORROW_NEAR_NETWORK: "devnet" }),
    ).toThrow(/MORROW_NEAR_NETWORK/);
  });
});
