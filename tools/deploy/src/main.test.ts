import { describe, expect, it } from "vitest";
import { UsageError } from "./args.js";
import { main } from "./main.js";

describe("main", () => {
  it("refuses an unknown command with the usage line", async () => {
    await expect(main(["publish"], () => undefined)).rejects.toThrow(UsageError);
    await expect(main([], () => undefined)).rejects.toThrow(
      /Usage: deploy <build\|deploy\|lock\|verify>/,
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
});
