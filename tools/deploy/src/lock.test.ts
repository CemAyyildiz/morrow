import { describe, expect, it } from "vitest";
import type { LockOptions } from "./args.js";
import { lock } from "./lock.js";
import {
  CALL_KEY,
  FakeChain,
  GAS_KEY,
  OTHER_HASH,
  SECOND_KEY,
  SIGNING_KEY,
  WASM,
  full,
  functionCall,
  gasFull,
  output,
} from "./test-helpers.js";

const ACCOUNT = "morrow-vault.testnet";

const options = (confirm?: string): LockOptions => ({
  accountId: ACCOUNT,
  network: "testnet",
  rpcUrl: "http://fake",
  wasm: undefined,
  confirm,
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

describe("lock", () => {
  it("refuses without --confirm, loading no key and sending nothing", async () => {
    const { chain, ports, senders } = setup();
    const o = output();
    expect(await lock(options(), WASM, ports, o.out)).toBe(1);
    expect(o.text()).toContain(`Pass --confirm ${ACCOUNT}`);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses a --confirm naming another account", async () => {
    const { chain, ports, senders } = setup();
    expect(await lock(options("other.testnet"), WASM, ports, output().out)).toBe(1);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses when the deployed code_hash differs from the local build", async () => {
    const { chain, ports, senders } = setup({ codeHash: OTHER_HASH });
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(1);
    expect(o.text()).toContain(`FAIL ${ACCOUNT}: code_hash ${OTHER_HASH} differs`);
    expect(o.text()).toContain("nothing sent");
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("refuses when get_config does not answer", async () => {
    const { chain, ports } = setup({ config: new Error("MethodNotFound") });
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(1);
    expect(o.text()).toContain("get_config failed: MethodNotFound");
    expect(chain.sent).toEqual([]);
  });

  it("refuses a signing key that is not one of the full-access keys", async () => {
    const { chain } = setup();
    const ports = { reader: chain, sender: () => chain.sender(ACCOUNT, CALL_KEY) };
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(1);
    expect(o.text()).toContain("is not a full-access key");
    expect(chain.sent).toEqual([]);
  });

  it("deletes every full-access key, gas keys included, in exactly one batch", async () => {
    const { chain, ports } = setup();
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(0);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.accountId).toBe(ACCOUNT);
    expect(chain.sent[0]!.batch).toEqual([
      { kind: "deleteKey", publicKey: SECOND_KEY },
      { kind: "deleteKey", publicKey: GAS_KEY },
      { kind: "deleteKey", publicKey: SIGNING_KEY },
    ]);
    // The function-call key cannot deploy or delete the account, so it stays.
    expect((await chain.accessKeys(ACCOUNT)).map((k) => k.publicKey)).toEqual([CALL_KEY]);
    expect(o.lines).toContain(`Locked: ${ACCOUNT} has no full-access keys`);
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, locked`,
    );
  });

  it("fails loudly when the re-read still shows a full-access key", async () => {
    const { chain, ports } = setup();
    chain.sticky.add(SECOND_KEY);
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(1);
    expect(chain.sent).toHaveLength(1);
    expect(o.text()).toContain(`FAIL ${ACCOUNT}: 1 full-access key(s) remain after the lock`);
    expect(o.text()).toContain(SECOND_KEY);
    expect(o.text()).not.toContain("Deployment verified");
  });

  it("sends nothing for an account that is already locked", async () => {
    const { chain, ports, senders } = setup({ keys: [functionCall(CALL_KEY)] });
    const o = output();
    expect(await lock(options(ACCOUNT), WASM, ports, o.out)).toBe(0);
    expect(senders()).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(o.text()).toContain("already has no full-access keys");
  });
});
