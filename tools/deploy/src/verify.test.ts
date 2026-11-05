import { describe, expect, it } from "vitest";
import type { InitArgs, Target } from "./args.js";
import { NO_CONTRACT_HASH } from "./rpc.js";
import {
  CALL_KEY,
  FakeChain,
  GAS_KEY,
  MAINNET_CONFIG,
  MAINNET_INIT,
  OTHER_HASH,
  SIGNING_KEY,
  TESTNET_CONFIG,
  TESTNET_INIT,
  VERSION,
  WASM,
  full,
  functionCall,
  gasFull,
  output,
} from "./test-helpers.js";
import { checkConfig, verify } from "./verify.js";

const DEMO = "morrow-vault.testnet";
const BOUNTY = "morrow-vault.near";

function twoAccounts() {
  const chain = new FakeChain().add(DEMO).add(BOUNTY, { config: MAINNET_CONFIG });
  const targets = [
    { accountId: DEMO, network: "testnet" as const, reader: chain },
    { accountId: BOUNTY, network: "mainnet" as const, reader: chain },
  ];
  return { chain, targets };
}

const run = (
  targets: Parameters<typeof verify>[0],
  out: (l: string) => void,
  requireLocked = true,
) => verify(targets, WASM, out, { requireLocked, version: VERSION });

describe("verify", () => {
  it("passes two locked accounts running the local build", async () => {
    const { targets } = twoAccounts();
    const o = output();
    expect(await run(targets, o.out)).toBe(0);
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 2 account(s), code_hash ${WASM.hash}, locked`,
    );
    expect(o.lines).toContain(`${BOUNTY} (mainnet) at final block 1002`);
    expect(o.lines).toContain(`  code_hash: ${WASM.hash} (matches the local build)`);
    expect(o.lines).toContain("  Locked: no access keys");
    expect(o.lines).toContain(
      "  get_config: signer v1.signer, networks bitcoin, allowlist bounty-operator.near, version 0.1.0",
    );
    expect(o.lines).toContain(
      "  get_config: signer v1.signer-prod.testnet, networks signet, allowlist (open), version 0.1.0",
    );
  });

  it("passes with the expected init given per account", async () => {
    const { targets } = twoAccounts();
    const o = output();
    const expected = [
      { ...targets[0]!, expected: TESTNET_INIT },
      { ...targets[1]!, expected: MAINNET_INIT },
    ];
    expect(await run(expected, o.out)).toBe(0);
  });

  it("names the account whose code_hash differs, and that the accounts run different code", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(BOUNTY)!.codeHash = OTHER_HASH;
    const o = output();
    expect(await run(targets, o.out)).toBe(1);
    expect(o.text()).toContain(
      `FAIL ${BOUNTY}: code_hash ${OTHER_HASH} differs from the local build`,
    );
    expect(o.text()).toContain("FAIL the accounts run different code");
    expect(o.text()).not.toContain(`FAIL ${DEMO}`);
    expect(o.lines.at(-1)).toBe("Deployment NOT verified: 2 problem(s)");
  });

  it("any access key, function-call keys included, fails the lock and is named", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.keys = [functionCall(CALL_KEY)];
    chain.accounts.get(BOUNTY)!.keys = [full(SIGNING_KEY), gasFull(GAS_KEY)];
    const o = output();
    expect(await run(targets, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: not locked: 1 access key(s) remain`);
    expect(o.text()).toContain(`FAIL ${BOUNTY}: not locked: 2 access key(s) remain`);
    expect(o.lines).toContain(`    ${CALL_KEY} FunctionCall receiver x.testnet, methods any`);
    expect(o.lines).toContain(`    ${SIGNING_KEY} FullAccess`);
    expect(o.lines).toContain(`    ${GAS_KEY} GasKeyFullAccess`);
  });

  it("fails when get_config is missing, against the rules, or not the expected init", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.config = new Error("MethodResolveError(MethodNotFound)");
    chain.accounts.get(BOUNTY)!.config = {
      ...MAINNET_CONFIG,
      allowed_networks: ["bitcoin", "signet"],
    };
    const o = output();
    expect(await run(targets, o.out)).toBe(1);
    expect(o.text()).toContain(
      `FAIL ${DEMO}: get_config failed: MethodResolveError(MethodNotFound)`,
    );
    expect(o.text()).toContain(
      `FAIL ${BOUNTY}: get_config allowed_networks: a mainnet deployment allows only bitcoin`,
    );
  });

  it("fails an account with no contract, and one that does not exist", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.codeHash = NO_CONTRACT_HASH;
    chain.accounts.delete(BOUNTY);
    const o = output();
    expect(await run(targets, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: no contract is deployed`);
    expect(o.text()).toContain(`FAIL ${BOUNTY}: the account does not exist`);
  });

  it("exits 1 with the RPC error when the RPC is down", async () => {
    const { chain, targets } = twoAccounts();
    chain.down = true;
    const o = output();
    expect(await run(targets, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${DEMO}: RPC error: connect ECONNREFUSED`);
  });

  it("without requiring the lock, lists the keys but passes", async () => {
    const { chain, targets } = twoAccounts();
    chain.accounts.get(DEMO)!.keys = [full(SIGNING_KEY)];
    const o = output();
    expect(await run(targets.slice(0, 1), o.out, false)).toBe(0);
    expect(o.lines).toContain("  Not locked: 1 access key(s)");
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, not locked yet`,
    );
  });
});

describe("checkConfig (the same rules as deploy)", () => {
  const testnet: Target = { accountId: DEMO, network: "testnet" };
  const mainnet: Target = { accountId: BOUNTY, network: "mainnet" };
  const problems = (value: unknown, target = testnet, expected?: InitArgs) =>
    checkConfig(value, target, expected, VERSION).problems;

  it("accepts the testnet and mainnet configs", () => {
    expect(checkConfig(TESTNET_CONFIG, testnet, TESTNET_INIT, VERSION)).toEqual({
      config: TESTNET_CONFIG,
      problems: [],
    });
    expect(problems(MAINNET_CONFIG, mainnet, MAINNET_INIT)).toEqual([]);
  });

  it.each([
    [
      { ...MAINNET_CONFIG, creator_allowlist: [] },
      mainnet,
      "get_config creator_allowlist: a mainnet deployment needs a creator allowlist",
    ],
    [
      { ...TESTNET_CONFIG, allowed_networks: ["signet", "bitcoin"] },
      testnet,
      "get_config allowed_networks: bitcoin needs the mainnet MPC signer; deploy it with --network mainnet",
    ],
    [
      { ...TESTNET_CONFIG, allowed_networks: ["liquid"] },
      testnet,
      'get_config allowed_networks: "liquid" is not a network the contract knows (regtest, signet, testnet4, bitcoin)',
    ],
    [
      { ...TESTNET_CONFIG, allowed_networks: ["signet", "signet"] },
      testnet,
      "get_config allowed_networks: a network is listed twice",
    ],
    [
      { ...TESTNET_CONFIG, signer_account: "mock-signer.testnet" },
      testnet,
      'get_config signer_account: testnet Vaults must use the MPC signer v1.signer-prod.testnet, not "mock-signer.testnet"',
    ],
  ])("refuses %o", (value, target, problem) => {
    expect(problems(value, target)).toContain(problem);
  });

  it("compares with the expected init as sets, and the version with the source", () => {
    expect(
      problems({ ...TESTNET_CONFIG, allowed_networks: ["testnet4", "signet"] }, testnet, {
        ...TESTNET_INIT,
        allowed_networks: ["signet", "testnet4"],
      }),
    ).toEqual([]);
    expect(
      problems({ ...TESTNET_CONFIG, allowed_networks: ["testnet4"] }, testnet, TESTNET_INIT),
    ).toEqual(["get_config allowed_networks is testnet4, expected signet"]);
    expect(problems({ ...TESTNET_CONFIG, version: "9.9.9" })).toEqual([
      `get_config version is 9.9.9, the contract source says ${VERSION}`,
    ]);
  });

  it("refuses a shape that is not a Vault config", () => {
    expect(problems("0.1.0")).toEqual(["get_config returned no config"]);
    expect(problems({ signer_account: "v1.signer-prod.testnet" })[0]).toMatch(/missing/);
  });
});
