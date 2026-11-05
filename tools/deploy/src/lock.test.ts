import { describe, expect, it } from "vitest";
import type { LockOptions } from "./args.js";
import { codeHash } from "./build.js";
import { lock } from "./lock.js";
import {
  CALL_KEY,
  FakeChain,
  GAS_KEY,
  OTHER_HASH,
  SECOND_KEY,
  SIGNING_KEY,
  TESTNET_INIT,
  VERSION,
  WASM,
  full,
  functionCall,
  gasFull,
  output,
} from "./test-helpers.js";

const ACCOUNT = "morrow-vault.testnet";

const options = (confirm?: string, expected = TESTNET_INIT): LockOptions => ({
  accountId: ACCOUNT,
  network: "testnet",
  rpcUrl: "http://fake",
  wasm: undefined,
  confirm,
  expected,
});

function setup(account: Parameters<FakeChain["add"]>[1] = {}) {
  const chain = new FakeChain().add(ACCOUNT, {
    keys: [full(SIGNING_KEY), full(SECOND_KEY), gasFull(GAS_KEY), functionCall(CALL_KEY)],
    ...account,
  });
  let senders = 0;
  const ports = {
    reader: chain,
    sender: () => {
      senders += 1;
      return chain.sender(ACCOUNT);
    },
  };
  return { chain, ports, senders: () => senders };
}

const run = (o: LockOptions, ports: Parameters<typeof lock>[2], out: (l: string) => void) =>
  lock(o, WASM, ports, out, VERSION);

describe("lock refusals (nothing sent)", () => {
  it("refuses without --confirm, loading no key", async () => {
    const { chain, ports, senders } = setup();
    const o = output();
    expect(await run(options(), ports, o.out)).toBe(1);
    expect(o.text()).toContain(`Pass --confirm ${ACCOUNT}`);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses a --confirm naming another account", async () => {
    const { chain, ports, senders } = setup();
    expect(await run(options("other.testnet"), ports, output().out)).toBe(1);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses when the deployed code_hash differs from the local build", async () => {
    const { chain, ports, senders } = setup({ codeHash: OTHER_HASH });
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${ACCOUNT}: code_hash ${OTHER_HASH} differs`);
    expect(o.text()).toContain("nothing sent");
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses when get_config does not answer", async () => {
    const { chain, ports } = setup({ config: new Error("MethodNotFound") });
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain("get_config failed: MethodNotFound");
    expect(chain.sent).toEqual([]);
  });

  it("refuses a config other than the expected init", async () => {
    const { chain, ports } = setup({
      config: { ...TESTNET_INIT, creator_allowlist: ["intruder.testnet"], version: VERSION },
    });
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain("get_config creator_allowlist is intruder.testnet, expected (open)");
    expect(chain.sent).toEqual([]);
  });

  it("refuses a version other than the contract source's", async () => {
    const { chain, ports } = setup({ config: { ...TESTNET_INIT, version: "0.0.9" } });
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain(`get_config version is 0.0.9, the contract source says ${VERSION}`);
    expect(chain.sent).toEqual([]);
  });

  it("refuses a signing key that is not a full-access key of the account", async () => {
    const { chain } = setup();
    const o = output();
    const ports = { reader: chain, sender: () => chain.sender(ACCOUNT, CALL_KEY) };
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain("is not a full-access key");
    expect(chain.sent).toEqual([]);
  });
});

describe("lock", () => {
  it("redeploys the verified wasm and deletes every access key in exactly one batch", async () => {
    const { chain, ports } = setup();
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(0);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.accountId).toBe(ACCOUNT);
    expect(chain.sent[0]!.batch).toEqual([
      { kind: "deployContract", code: WASM.code },
      { kind: "deleteKey", publicKey: SECOND_KEY },
      { kind: "deleteKey", publicKey: GAS_KEY },
      { kind: "deleteKey", publicKey: CALL_KEY },
      { kind: "deleteKey", publicKey: SIGNING_KEY },
    ]);
    expect(chain.accounts.get(ACCOUNT)!.keys).toEqual([]);
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, locked`,
    );
  });

  it("prints what it strands before sending: config, code hash, keys, balance", async () => {
    const { ports } = setup();
    const o = output();
    await run(options(ACCOUNT), ports, o.out);
    const sent = o.lines.findIndex((l) => l.startsWith("Sent: "));
    const plan = o.lines.slice(0, sent).join("\n");
    expect(plan).toContain(
      "get_config: signer v1.signer-prod.testnet, networks signet, allowlist (open), version 0.1.0",
    );
    expect(plan).toContain(`  code_hash: ${WASM.hash}`);
    expect(plan).toContain(
      "  Balance: 10.0000 NEAR. After the lock this balance can never be withdrawn.",
    );
    expect(plan).toContain(`  1. DeployContract ${WASM.path}`);
    expect(plan).toContain(`DeleteKey ${CALL_KEY} (FunctionCall receiver x.testnet, methods any)`);
    expect(plan).toContain(`  5. DeleteKey ${SIGNING_KEY} (FullAccess)`);
  });

  it("fails loudly, naming the key, when the re-read still shows a key", async () => {
    const { chain, ports } = setup();
    chain.sticky.add(CALL_KEY);
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(chain.sent).toHaveLength(1);
    expect(o.text()).toContain(`FAIL ${ACCOUNT}: not locked: 1 access key(s) remain`);
    expect(o.text()).toContain(`    ${CALL_KEY} FunctionCall receiver x.testnet`);
    expect(o.text()).not.toContain("Deployment verified");
  });

  it("re-reads the account after a send that throws, and fails when nothing landed", async () => {
    const { chain, ports } = setup();
    chain.sendError = new Error("Transaction timed out");
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(1);
    expect(o.text()).toContain("Send failed: Transaction timed out");
    expect(o.text()).toContain(`FAIL ${ACCOUNT}: not locked: 4 access key(s) remain`);
  });

  it("reports the real state after a send that throws but landed", async () => {
    const { chain, ports } = setup();
    chain.sendError = new Error("Transaction timed out");
    chain.applyBeforeError = true;
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(0);
    expect(o.text()).toContain("Send failed: Transaction timed out");
    expect(o.lines.at(-1)).toContain("locked");
  });

  it("the re-read checks the code hash too", async () => {
    const { chain, ports } = setup();
    const ports2 = {
      ...ports,
      sender: () => {
        const s = chain.sender(ACCOUNT);
        return {
          ...s,
          send: async () =>
            s.send([
              { kind: "deployContract", code: new Uint8Array([1]) },
              ...chain.accounts
                .get(ACCOUNT)!
                .keys.map((k) => ({ kind: "deleteKey" as const, publicKey: k.publicKey })),
            ]),
        };
      },
    };
    const o = output();
    expect(await run(options(ACCOUNT), ports2, o.out)).toBe(1);
    expect(o.text()).toContain(`code_hash ${codeHash(new Uint8Array([1]))} differs`);
  });

  it("sends nothing for an account that already has no access keys", async () => {
    const { chain, ports, senders } = setup({ keys: [] });
    const o = output();
    expect(await run(options(ACCOUNT), ports, o.out)).toBe(0);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(o.text()).toContain("already has no access keys");
  });
});
