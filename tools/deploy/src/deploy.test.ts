import { describe, expect, it } from "vitest";
import { parseDeploy } from "./args.js";
import { INIT_GAS, deploy, formatNear, storageStake } from "./deploy.js";
import {
  FakeChain,
  NEAR,
  SIGNING_KEY,
  STORAGE_PRICE,
  TESTNET_CONFIG,
  VERSION,
  WASM,
  full,
  output,
} from "./test-helpers.js";

const ACCOUNT = "x.testnet";
const ARGV = [
  "--account",
  ACCOUNT,
  "--signer",
  "v1.signer-prod.testnet",
  "--networks",
  "signet",
  "--creators",
  "y.testnet",
];
const MAINNET = [
  "--account",
  "bounty.near",
  "--network",
  "mainnet",
  "--signer",
  "v1.signer",
  "--networks",
  "bitcoin",
  "--creators",
  "op.near",
];

function ports(chain: FakeChain, account = ACCOUNT) {
  let senders = 0;
  return {
    ports: {
      reader: chain,
      sender: () => {
        senders += 1;
        return chain.sender(account);
      },
    },
    senders: () => senders,
  };
}

/** Lets the fake deploy land: `new` writes this config. */
function landInit(chain: FakeChain, account = ACCOUNT) {
  const sender = chain.sender(account);
  return {
    ...sender,
    send: async (batch: Parameters<typeof sender.send>[0]) => {
      const hash = await sender.send(batch);
      chain.accounts.get(account)!.config = {
        ...(batch[1] as { args: object }).args,
        version: VERSION,
      };
      return hash;
    },
  };
}

describe("deploy", () => {
  it("dry run: prints the plan and the read-only checks, loads no key, sends nothing", async () => {
    const chain = new FakeChain().addEmpty(ACCOUNT);
    const { ports: p, senders } = ports(chain);
    const o = output();
    expect(await deploy(parseDeploy(ARGV), WASM, p, o.out, VERSION)).toBe(0);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
    const stake = storageStake(182, WASM.code.length, STORAGE_PRICE);
    expect(o.lines).toEqual([
      `Deploy plan for ${ACCOUNT} (testnet, https://rpc.testnet.fastnear.com)`,
      `  1. DeployContract ${WASM.path} (8 bytes, code_hash ${WASM.hash})`,
      "  2. FunctionCall new (30 Tgas, no deposit)",
      "       signer_account: v1.signer-prod.testnet",
      "       allowed_networks: signet",
      "       creator_allowlist: y.testnet",
      `Check: ${ACCOUNT} exists, balance 10.0000 NEAR`,
      "Check: no contract deployed yet",
      `Check: storage stake about ${formatNear(stake.yocto)} NEAR (2190 bytes at ${STORAGE_PRICE} yoctoNEAR/byte, plus 10%)`,
      "Dry run: nothing sent. Add --send to deploy.",
    ]);
  });

  it("refuses an account that does not exist, holds a contract, or cannot cover the stake", async () => {
    for (const [chain, problem] of [
      [new FakeChain(), `${ACCOUNT} does not exist: create and fund it first`],
      [
        new FakeChain().add(ACCOUNT),
        `${ACCOUNT} already holds a contract (code_hash ${WASM.hash})`,
      ],
      [
        new FakeChain().addEmpty(ACCOUNT, { amount: NEAR / 100n }),
        "balance 0.0100 NEAR does not cover the storage stake",
      ],
    ] as const) {
      const { ports: p, senders } = ports(chain);
      const o = output();
      expect(await deploy(parseDeploy([...ARGV, "--send"]), WASM, p, o.out, VERSION)).toBe(1);
      expect(o.text()).toContain(`FAIL ${ACCOUNT}: ${problem}`);
      expect(o.lines.at(-1)).toBe("Refused: the deploy checks did not pass; nothing sent.");
      expect(senders()).toBe(0);
      expect(chain.sent).toEqual([]);
    }
  });

  it("mainnet: every allowlisted creator must exist", async () => {
    const chain = new FakeChain().addEmpty("bounty.near");
    const { ports: p } = ports(chain, "bounty.near");
    const o = output();
    expect(await deploy(parseDeploy(MAINNET), WASM, p, o.out, VERSION)).toBe(1);
    expect(o.text()).toContain("FAIL bounty.near: creator op.near does not exist on mainnet");
    chain.add("op.near");
    const o2 = output();
    expect(await deploy(parseDeploy(MAINNET), WASM, p, o2.out, VERSION)).toBe(0);
    expect(o2.lines).toContain("Check: creator op.near exists");
  });

  it("--send: one transaction with DeployContract and new, then a verify against that init", async () => {
    const chain = new FakeChain().addEmpty(ACCOUNT, { keys: [full(SIGNING_KEY)] });
    const o = output();
    const code = await deploy(
      parseDeploy([...ARGV, "--send"]),
      WASM,
      { reader: chain, sender: () => landInit(chain) },
      o.out,
      VERSION,
    );
    expect(code).toBe(0);
    expect(chain.sent).toEqual([
      {
        accountId: ACCOUNT,
        batch: [
          { kind: "deployContract", code: WASM.code },
          {
            kind: "functionCall",
            method: "new",
            args: {
              signer_account: "v1.signer-prod.testnet",
              allowed_networks: ["signet"],
              creator_allowlist: ["y.testnet"],
            },
            gas: INIT_GAS,
            deposit: 0n,
          },
        ],
      },
    ]);
    expect(o.text()).toContain("Sent: transaction ");
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, not locked yet`,
    );
  });

  it("--send: the post-deploy verify fails when get_config is not the init just sent", async () => {
    const chain = new FakeChain().addEmpty(ACCOUNT, { keys: [full(SIGNING_KEY)] });
    const sender = chain.sender(ACCOUNT);
    const o = output();
    const code = await deploy(
      parseDeploy([...ARGV, "--send"]),
      WASM,
      {
        reader: chain,
        sender: () => ({
          ...sender,
          send: async (batch) => {
            const hash = await sender.send(batch);
            chain.accounts.get(ACCOUNT)!.config = TESTNET_CONFIG;
            return hash;
          },
        }),
      },
      o.out,
      VERSION,
    );
    expect(code).toBe(1);
    expect(o.text()).toContain("get_config creator_allowlist is (open), expected y.testnet");
  });

  it("--send: the contract's error propagates (already initialised)", async () => {
    const chain = new FakeChain().addEmpty(ACCOUNT);
    const sender = {
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
      send: async () => {
        throw new Error("Smart contract panicked: The contract has already been initialized");
      },
    };
    await expect(
      deploy(
        parseDeploy([...ARGV, "--send"]),
        WASM,
        { reader: chain, sender: () => sender },
        output().out,
        VERSION,
      ),
    ).rejects.toThrow("already been initialized");
  });
});

describe("formatNear", () => {
  it("prints 4 decimals, rounded down", () => {
    expect(formatNear(0n)).toBe("0.0000");
    expect(formatNear(NEAR + NEAR / 2n + 1n)).toBe("1.5000");
    expect(formatNear(123_456_789n * 10n ** 16n)).toBe("1.2345");
  });
});
