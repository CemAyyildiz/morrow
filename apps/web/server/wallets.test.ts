// The wallet pages run pinned wallet executors served from our own origin: each copy in
// public/wallets must be byte for byte the one src/vault/wallets.ts records.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PINNED_EXECUTORS, WALLET_MANIFEST } from "../src/vault/wallets.ts";

const PUBLIC = new URL("../public", import.meta.url);

describe("pinned wallet executors", () => {
  it.each(Object.entries(PINNED_EXECUTORS))("%s matches its recorded sha256", (_, pinned) => {
    const bytes = readFileSync(new URL(`.${pinned.path}`, `${PUBLIC.href}/`));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned.sha256);
    expect(pinned.source).toMatch(/^https:\/\//);
  });

  it("serves only the pinned copies, and the manifest points at them", () => {
    expect(readdirSync(new URL("./wallets", `${PUBLIC.href}/`)).sort()).toEqual([
      "intear.js",
      "meteor.js",
    ]);
    expect(WALLET_MANIFEST.wallets.map((w) => [w.id, w.executor])).toEqual([
      ["meteor-wallet", "/wallets/meteor.js"],
      ["intear-wallet", "/wallets/intear.js"],
    ]);
    for (const wallet of WALLET_MANIFEST.wallets) {
      expect(wallet.features.testnet).toBe(true);
      expect(wallet.type).toBe("sandbox");
      expect(wallet.icon).toMatch(/^data:image\/svg\+xml[;,]/);
    }
  });
});
