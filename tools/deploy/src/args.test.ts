import { describe, expect, it } from "vitest";
import {
  UsageError,
  assertRpcNetwork,
  knownRpcNetwork,
  parseDeploy,
  parseLock,
  parseVerify,
} from "./args.js";

const deployArgv = (overrides: Record<string, string> = {}, extra: string[] = []) => {
  const flags = {
    account: "x.testnet",
    signer: "v1.signer-prod.testnet",
    networks: "signet",
    creators: "y.testnet",
    ...overrides,
  };
  return [...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]), ...extra];
};

const mainnetArgv = (overrides: Record<string, string> = {}) =>
  deployArgv({
    account: "morrow-vault.near",
    signer: "v1.signer",
    networks: "bitcoin",
    creators: "bounty-operator.near",
    network: "mainnet",
    ...overrides,
  });

describe("parseDeploy", () => {
  it("reads the dry-run arguments", () => {
    expect(parseDeploy(deployArgv())).toEqual({
      accountId: "x.testnet",
      network: "testnet",
      rpcUrl: "https://rpc.testnet.fastnear.com",
      wasm: undefined,
      send: false,
      init: {
        signer_account: "v1.signer-prod.testnet",
        allowed_networks: ["signet"],
        creator_allowlist: ["y.testnet"],
      },
    });
    expect(parseDeploy(deployArgv({}, ["--send"])).send).toBe(true);
  });

  it("splits comma lists and allows an open testnet allowlist", () => {
    const argv = deployArgv({ networks: "signet, testnet4" }).filter(
      (_, i, a) => a[i] !== "--creators" && a[i - 1] !== "--creators",
    );
    expect(parseDeploy(argv).init).toEqual({
      signer_account: "v1.signer-prod.testnet",
      allowed_networks: ["signet", "testnet4"],
      creator_allowlist: [],
    });
  });

  it("reads the mainnet Bounty arguments", () => {
    expect(parseDeploy(mainnetArgv())).toMatchObject({
      network: "mainnet",
      rpcUrl: "https://rpc.mainnet.fastnear.com",
      init: { signer_account: "v1.signer", allowed_networks: ["bitcoin"] },
    });
  });

  it.each([
    [
      { signer: "v1.signer" },
      /--signer: testnet Vaults must use the MPC signer v1.signer-prod.testnet/,
    ],
    [{ networks: "" }, /--networks: name at least one/],
    [{ networks: "liquid" }, /--networks: "liquid" is not a network the contract knows/],
    [{ networks: "signet,signet" }, /listed twice/],
    [{ networks: "bitcoin" }, /bitcoin needs the mainnet MPC signer/],
    [{ creators: "Bad_Account!" }, /--creators: "Bad_Account!" is not a valid NEAR account id/],
    [{ creators: "y.near" }, /--creators: y.near is a mainnet account, not testnet/],
    [{ account: "a" }, /--account: "a" is not a valid NEAR account id/],
    [{ network: "mainnet" }, /--account x.testnet is a testnet account, not mainnet/],
    [{ network: "betanet" }, /--network: "betanet" is not testnet or mainnet/],
  ])("refuses %o", (overrides, message) => {
    expect(() => parseDeploy(deployArgv(overrides))).toThrow(message);
  });

  it("mainnet guard: only bitcoin, a creator allowlist, the mainnet signer", () => {
    expect(() => parseDeploy(mainnetArgv({ networks: "signet" }))).toThrow(
      "--networks: a mainnet deployment allows only bitcoin",
    );
    expect(() => parseDeploy(mainnetArgv({ networks: "bitcoin,signet" }))).toThrow(
      "allows only bitcoin",
    );
    expect(() => parseDeploy(mainnetArgv({ creators: "" }))).toThrow(
      "--creators: a mainnet deployment needs a creator allowlist",
    );
    expect(() => parseDeploy(mainnetArgv({ signer: "v1.signer-prod.testnet" }))).toThrow(
      "--signer: mainnet Vaults must use the MPC signer v1.signer",
    );
  });

  it("needs an explicit --network mainnet for a mainnet account", () => {
    const argv = mainnetArgv().filter(
      (_, i, a) => a[i] !== "--network" && a[i - 1] !== "--network",
    );
    expect(() => parseDeploy(argv)).toThrow(
      "morrow-vault.near is a mainnet account: pass --network mainnet to confirm",
    );
  });

  it("refuses unknown flags and missing required ones as usage errors", () => {
    expect(() => parseDeploy([...deployArgv(), "--yes"])).toThrow(UsageError);
    expect(() => parseDeploy(["--account", "x.testnet"])).toThrow("--signer is required");
    expect(() => parseDeploy([])).toThrow("--account is required");
  });
});

const LOCK_INIT = ["--signer", "v1.signer-prod.testnet", "--networks", "signet"];

describe("parseLock", () => {
  it("reads --confirm and the expected init", () => {
    expect(
      parseLock(["--account", "x.testnet", "--confirm", "x.testnet", ...LOCK_INIT]),
    ).toMatchObject({
      accountId: "x.testnet",
      network: "testnet",
      confirm: "x.testnet",
      expected: {
        signer_account: "v1.signer-prod.testnet",
        allowed_networks: ["signet"],
        creator_allowlist: [],
      },
    });
    expect(parseLock(["--account", "x.testnet", ...LOCK_INIT]).confirm).toBeUndefined();
  });

  it("requires the expected init, under the same rules as deploy", () => {
    expect(() => parseLock(["--account", "x.testnet", "--confirm", "x.testnet"])).toThrow(
      "--signer is required",
    );
    expect(() =>
      parseLock([
        "--account",
        "x.near",
        "--network",
        "mainnet",
        "--signer",
        "v1.signer",
        "--networks",
        "bitcoin",
      ]),
    ).toThrow("--creators: a mainnet deployment needs a creator allowlist");
  });

  it("needs --network mainnet for a mainnet account", () => {
    expect(() => parseLock(["--account", "x.near", "--confirm", "x.near", ...LOCK_INIT])).toThrow(
      "pass --network mainnet",
    );
  });
});

describe("networks", () => {
  it("needs --network for an id without a .testnet or .near suffix", () => {
    const implicit = "a".repeat(64);
    expect(() => parseVerify(["--account", implicit])).toThrow(
      `--account ${implicit} names no network by its suffix: pass --network testnet|mainnet`,
    );
    expect(parseVerify(["--account", implicit, "--network", "testnet"]).targets[0]!.network).toBe(
      "testnet",
    );
    expect(() => parseDeploy(deployArgv({ account: "vault.sputnik" }))).toThrow("names no network");
  });

  it("knows the public RPC hosts", () => {
    expect(knownRpcNetwork("https://rpc.testnet.near.org")).toBe("testnet");
    expect(knownRpcNetwork("https://free.rpc.fastnear.com/")).toBe("mainnet");
    expect(knownRpcNetwork("http://127.0.0.1:3030")).toBeNull();
    expect(() => knownRpcNetwork("not a url")).toThrow('--rpc: "not a url" is not a URL');
  });

  it("refuses an --rpc of another network, by host or by the RPC's chain_id", async () => {
    const never = async () => {
      throw new Error("not asked");
    };
    await expect(
      assertRpcNetwork("https://rpc.mainnet.near.org", "testnet", never),
    ).rejects.toThrow("--rpc https://rpc.mainnet.near.org serves mainnet, not testnet");
    await expect(
      assertRpcNetwork("https://rpc.testnet.near.org", "testnet", never),
    ).resolves.toBeUndefined();
    await expect(
      assertRpcNetwork("http://127.0.0.1:3030", "mainnet", async () => "testnet"),
    ).rejects.toThrow("serves testnet, not mainnet");
    await expect(
      assertRpcNetwork("http://127.0.0.1:3030", "testnet", async () => "testnet"),
    ).resolves.toBeUndefined();
  });
});

describe("parseVerify", () => {
  it("takes several accounts, each on the network its suffix names", () => {
    expect(parseVerify(["--account", "a.testnet", "--account", "b.near"]).targets).toEqual([
      {
        accountId: "a.testnet",
        network: "testnet",
        rpcUrl: "https://rpc.testnet.fastnear.com",
        expected: undefined,
      },
      {
        accountId: "b.near",
        network: "mainnet",
        rpcUrl: "https://rpc.mainnet.fastnear.com",
        expected: undefined,
      },
    ]);
  });

  it("applies the init flags that follow an --account to that account", () => {
    const { targets } = parseVerify([
      "--account",
      "a.testnet",
      "--signer",
      "v1.signer-prod.testnet",
      "--networks",
      "signet",
      "--account",
      "b.near",
      "--signer",
      "v1.signer",
      "--networks",
      "bitcoin",
      "--creators",
      "op.near",
      "--account",
      "c.testnet",
    ]);
    expect(targets.map((t) => t.expected)).toEqual([
      {
        signer_account: "v1.signer-prod.testnet",
        allowed_networks: ["signet"],
        creator_allowlist: [],
      },
      {
        signer_account: "v1.signer",
        allowed_networks: ["bitcoin"],
        creator_allowlist: ["op.near"],
      },
      undefined,
    ]);
  });

  it("checks the expected init with the deploy rules", () => {
    expect(() =>
      parseVerify(["--account", "b.near", "--signer", "v1.signer", "--networks", "signet"]),
    ).toThrow("--networks: a mainnet deployment allows only bitcoin");
    expect(() => parseVerify(["--account", "a.testnet", "--networks", "signet"])).toThrow(
      "--signer is required",
    );
    expect(() => parseVerify(["--signer", "v1.signer", "--account", "a.testnet"])).toThrow(
      "--signer must follow the --account it describes",
    );
  });

  it("applies --rpc only to accounts of one network", () => {
    expect(
      parseVerify([
        "--account",
        "a.testnet,b.testnet",
        "--rpc",
        "http://127.0.0.1:3030",
      ]).targets.map((t) => t.rpcUrl),
    ).toEqual(["http://127.0.0.1:3030", "http://127.0.0.1:3030"]);
    expect(() =>
      parseVerify(["--account", "a.testnet", "--account", "b.near", "--rpc", "http://x"]),
    ).toThrow("different networks");
  });

  it("refuses no account and a repeated account", () => {
    expect(() => parseVerify([])).toThrow("--account is required");
    expect(() => parseVerify(["--account", "a.testnet", "--account", "a.testnet"])).toThrow(
      "listed twice",
    );
  });
});
