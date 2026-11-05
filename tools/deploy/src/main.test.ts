import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "./args.js";
import { main } from "./main.js";
import { FakeChain, WASM, output } from "./test-helpers.js";

describe("main", () => {
  it("refuses an unknown command with the usage line", async () => {
    await expect(main(["publish"], () => undefined)).rejects.toThrow(UsageError);
    await expect(main([], () => undefined)).rejects.toThrow(
      /Usage: deploy <build\|hash\|deploy\|lock\|verify>/,
    );
  });

  it("checks arguments before reading the wasm or the network", async () => {
    await expect(
      main(
        [
          "deploy",
          "--account",
          "x.near",
          "--network",
          "mainnet",
          "--signer",
          "v1.signer",
          "--networks",
          "signet",
          "--creators",
          "y.near",
        ],
        () => undefined,
      ),
    ).rejects.toThrow("a mainnet deployment allows only bitcoin");
  });

  it("hash prints a wasm file's code_hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-deploy-"));
    writeFileSync(join(dir, "v.wasm"), new TextEncoder().encode("abc"));
    const o = output();
    expect(await main(["hash", "--wasm", join(dir, "v.wasm")], o.out)).toBe(0);
    expect(o.lines).toContain("code_hash: DYu3G8aGTMBW1WrTw76zxQJQU4DHLw9MLyy7peG4LKkY");
  });

  it("refuses an --rpc that serves another network before reading any account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-deploy-"));
    writeFileSync(join(dir, "v.wasm"), WASM.code);
    const chain = new FakeChain().add("v.testnet");
    chain.chainId = "mainnet";
    const argv = ["verify", "--account", "v.testnet", "--rpc", "http://127.0.0.1:3030"];
    await expect(
      main([...argv, "--wasm", join(dir, "v.wasm")], () => undefined, { reader: () => chain }),
    ).rejects.toThrow("--rpc http://127.0.0.1:3030 serves mainnet, not testnet");
    chain.chainId = "testnet";
    const o = output();
    expect(
      await main([...argv, "--wasm", join(dir, "v.wasm")], o.out, { reader: () => chain }),
    ).toBe(0);
    expect(o.lines.at(-1)).toBe(
      `Deployment verified: 1 account(s), code_hash ${WASM.hash}, locked`,
    );
  });
});
