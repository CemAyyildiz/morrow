import { describe, expect, it } from "vitest";
import { parseDeploy } from "./args.js";
import { INIT_GAS, deploy } from "./deploy.js";
import { FakeChain, SIGNING_KEY, WASM, full, output } from "./test-helpers.js";

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

describe("deploy", () => {
  it("dry run: prints the plan and code_hash, loads no key, sends nothing", async () => {
    const chain = new FakeChain();
    let senders = 0;
    const ports = {
      reader: chain,
      sender: () => {
        senders += 1;
        return chain.sender(ACCOUNT);
      },
    };
    const o = output();
    expect(await deploy(parseDeploy(ARGV), WASM, ports, o.out)).toBe(0);
    expect(senders).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(o.lines).toEqual([
      `Deploy plan for ${ACCOUNT} (testnet, https://rpc.testnet.near.org)`,
      `  1. DeployContract ${WASM.path} (8 bytes, code_hash ${WASM.hash})`,
      "  2. FunctionCall new (30 Tgas, no deposit)",
      "       signer_account: v1.signer-prod.testnet",
      "       allowed_networks: signet",
      "       creator_allowlist: y.testnet",
      "Dry run: nothing sent. Add --send to deploy.",
    ]);
  });

  it("--send: one transaction with DeployContract and new, then a verify without the lock", async () => {
    const chain = new FakeChain().add(ACCOUNT, { keys: [full(SIGNING_KEY)] });
    const o = output();
    const code = await deploy(
      parseDeploy([...ARGV, "--send"]),
      WASM,
      { reader: chain, sender: () => chain.sender(ACCOUNT) },
      o.out,
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

  it("--send: the contract's error propagates (already initialised)", async () => {
    const chain = new FakeChain().add(ACCOUNT);
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
      ),
    ).rejects.toThrow("already been initialized");
  });
});
