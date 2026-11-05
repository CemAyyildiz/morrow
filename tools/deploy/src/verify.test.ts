import { describe, expect, it } from "vitest";
import { NO_CONTRACT_HASH } from "./rpc.js";
import {
  CALL_KEY,
  FakeChain,
  GAS_KEY,
  OTHER_HASH,
  SIGNING_KEY,
  TESTNET_CONFIG,
  WASM,
  full,
  functionCall,
  gasFull,
  output,
} from "./test-helpers.js";
import { checkConfig, verify } from "./verify.js";

const DEMO = "morrow-vault.testnet";
const BOUNTY = "morrow-vault.near";
const MAINNET_CONFIG = {
  signer_account: "v1.signer",
  allowed_networks: ["bitcoin"],
  creator_allowlist: ["bounty-operator.near"],
  version: "0.1.0",
};

function twoAccounts() {
  const chain = new FakeChain()
    .add(DEMO, { keys: [functionCall(CALL_KEY)] })
    .add(BOUNTY, { config: MAINNET_CONFIG });
  const targets = [
    { accountId: DEMO, network: "testnet" as const, reader: chain },
    { accountId: BOUNTY, network: "mainnet" as const, reader: chain },
  ];
  return { chain, targets };
}

describe("verify", () => {
  it("passes two locked accounts running the local build", async () => {
    const { targets } = twoAccounts();
    const o = output();
    expect(await verify(targets, WASM, o.out)).toBe(0);
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 2 account(s), code_hash ${WASM.hash}, locked`,
    );
    expect(o.lines).toContain(`${BOUNTY} (mainnet)`);
    expect(o.lines).toContain(`  code_hash: ${WASM.hash} (matches the local build)`);
    expect(o.lines).toContain("  Locked: no full-access keys");
    expect(o.lines).toContain(
      "  get_config: signer v1.signer, networks bitcoin, allowlist bounty-operator.near, version 0.1.0",
    );
    expect(o.lines).toContain(
      "  get_config: signer v1.signer-prod.testnet, networks signet, allowlist (open), version 0.1.0",
    );
  });

  it("names the account whose code_hash differs, and that the accounts run different code", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(BOUNTY)!.codeHash = OTHER_HASH;
    const o = output();
    expect(await verify(targets, WASM, o.out)).toBe(1);
    expect(o.text()).toContain(
      `FAIL ${BOUNTY}: code_hash ${OTHER_HASH} differs from the local build`,
    );
    expect(o.text()).toContain("FAIL the accounts run different code");
    expect(o.text()).not.toContain(`FAIL ${DEMO}`);
    expect(o.lines.at(-1)).toBe("Deployment NOT verified: 2 problem(s)");
  });

  it("fails an unlocked account, counting gas keys as full access", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.keys = [functionCall(CALL_KEY), gasFull(GAS_KEY)];
    chain.accounts.get(BOUNTY)!.keys = [full(SIGNING_KEY)];
    const o = output();
    expect(await verify(targets, WASM, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: not locked: 1 full-access key(s)`);
    expect(o.text()).toContain(`FAIL ${BOUNTY}: not locked: 1 full-access key(s)`);
  });

  it("fails when get_config is missing or wrong for the network", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.config = new Error("MethodResolveError(MethodNotFound)");
    chain.accounts.get(BOUNTY)!.config = {
      ...MAINNET_CONFIG,
      allowed_networks: ["bitcoin", "signet"],
    };
    const o = output();
    expect(await verify(targets, WASM, o.out)).toBe(1);
    expect(o.text()).toContain(
      `FAIL ${DEMO}: get_config failed: MethodResolveError(MethodNotFound)`,
    );
    expect(o.text()).toContain(
      `FAIL ${BOUNTY}: allowed_networks is bitcoin,signet; mainnet allows only bitcoin`,
    );
  });

  it("fails an account with no contract", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.codeHash = NO_CONTRACT_HASH;
    const o = output();
    expect(await verify(targets.slice(0, 1), WASM, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: no contract is deployed`);
  });

  it("exits 1 with the RPC error when the RPC is down", async () => {
    const { chain, targets } = twoAccounts();
    chain.down = true;
    const o = output();
    expect(await verify(targets, WASM, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: RPC error reading the account: connect ECONNREFUSED`);
  });

  it("without requiring the lock, reports full-access keys but passes", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.keys = [full(SIGNING_KEY)];
    const o = output();
    expect(await verify(targets.slice(0, 1), WASM, o.out, false)).toBe(0);
    expect(o.lines).toContain("  Not locked: 1 full-access key(s)");
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, not locked yet`,
    );
  });
});

describe("checkConfig", () => {
  const testnet = { accountId: DEMO, network: "testnet" as const };
  it("accepts the testnet config", () => {
    expect(checkConfig(TESTNET_CONFIG, testnet)).toEqual(TESTNET_CONFIG);
  });
  it("refuses the wrong MPC signer", () => {
    expect(checkConfig({ ...TESTNET_CONFIG, signer_account: "mock-signer.testnet" }, testnet)).toBe(
      "signer_account is mock-signer.testnet, not the testnet MPC signer v1.signer-prod.testnet",
    );
  });
  it("refuses a shape that is not a Vault config", () => {
    expect(checkConfig("0.1.0", testnet)).toBe("get_config returned no config");
    expect(checkConfig({ signer_account: "v1.signer-prod.testnet" }, testnet)).toMatch(/missing/);
  });
});
