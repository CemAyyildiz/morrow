import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "./browser.js";
import * as everything from "./index.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every module `entry` reaches through static imports and re-exports, and their bare imports. */
function graph(entry: string, root = SRC): { modules: string[]; bare: string[] } {
  const modules = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']/g)) {
      const specifier = match[1] as string;
      if (specifier.startsWith(".")) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else {
        bare.add(specifier);
      }
    }
    // Side-effect imports (`import "pkg"`) and dynamic imports (`import("pkg")`).
    for (const match of text.matchAll(/\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)) {
      const specifier = match[1] as string;
      if (specifier.startsWith("."))
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else bare.add(specifier);
    }
  };
  visit(join(root, entry));
  return { modules: [...modules].map((m) => m.slice(root.length + 1)), bare: [...bare] };
}

describe("@morrow/core-ts/browser", () => {
  it("reaches only pure modules: no package import at all", () => {
    const { modules, bare } = graph("browser.ts");
    expect(bare).toEqual([]);
    expect(modules.sort()).toEqual([
      "browser.ts",
      "contract/errors.ts",
      "contract/events.ts",
      "contract/types.ts",
      "xray/links.ts",
    ]);
  });

  it("the graph walk does see the heavy dependencies of the full entry", () => {
    const { bare } = graph("index.ts");
    expect(bare).toEqual(expect.arrayContaining(["near-api-js", "bitcoinjs-lib"]));
  });

  it("the graph walk follows side-effect and dynamic imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-graph-"));
    try {
      writeFileSync(join(dir, "a.ts"), 'import "side-effect-pkg";\nimport "./b.js";\n');
      writeFileSync(join(dir, "b.ts"), 'export const load = () => import("lazy-pkg");\n');
      const { modules, bare } = graph("a.ts", dir);
      expect(modules.sort()).toEqual(["a.ts", "b.ts"]);
      expect(bare.sort()).toEqual(["lazy-pkg", "side-effect-pkg"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports the same values as the full entry", () => {
    for (const name of Object.keys(browser)) {
      expect((everything as Record<string, unknown>)[name]).toBe(
        (browser as Record<string, unknown>)[name],
      );
    }
    expect(browser.nearTxUrl("testnet", "H")).toBe("https://testnet.nearblocks.io/txns/H");
    expect(browser.nearAccountUrl("mainnet", "a.near")).toBe(
      "https://nearblocks.io/address/a.near",
    );
    expect(browser.bitcoinTxUrl("signet", "ab")).toBe("https://mempool.space/signet/tx/ab");
    expect(browser.bitcoinTxUrl("regtest", "ab")).toBeNull();
    expect(browser.ERROR_CODES.ERR_NOT_EXECUTABLE).toMatch(/Delay/);
    expect(browser.EVENT_KINDS).toContain("withdrawal_requested");
  });
});
