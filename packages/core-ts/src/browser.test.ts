import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "./browser.js";
import * as everything from "./index.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/** The only packages the browser entry may reach: small, pure, audited. */
const ALLOWED_PACKAGES = /^(@noble\/(curves|hashes|ciphers)|@scure\/base)$/;

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
  it("reaches only pure modules, and of packages only the small pure ones allowed", () => {
    const { modules, bare } = graph("browser.ts");
    const packageOf = (specifier: string) =>
      specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
    expect([...new Set(bare.map(packageOf))].sort()).toEqual([
      "@noble/ciphers",
      "@noble/curves",
      "@noble/hashes",
      "@scure/base",
    ]);
    for (const specifier of bare) expect(packageOf(specifier)).toMatch(ALLOWED_PACKAGES);
    expect(modules.sort()).toEqual([
      "bitcoin/browser-address.ts",
      "bitcoin/browser-script.ts",
      "browser.ts",
      "contract/errors.ts",
      "contract/events.ts",
      "contract/policy.ts",
      "contract/types.ts",
      "crypto/browser-envelope.ts",
      "near/browser-tx.ts",
      "xray/failure.ts",
      "xray/links.ts",
      "xray/ports.ts",
      "xray/types.ts",
    ]);
  });

  it("the allowlist keeps out the heavy packages", () => {
    for (const heavy of [
      "near-api-js",
      "libsodium-wrappers-sumo",
      "bitcoinjs-lib",
      "@near-js/crypto",
    ]) {
      expect(heavy).not.toMatch(ALLOWED_PACKAGES);
    }
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

  it("exports the get_vault view types for the Proof Page, as types only", () => {
    const guardian: browser.Guardian = {
      guardian_key: `02${"11".repeat(32)}`,
      guardian_account: "g.testnet",
      kind: "auto_clawback" satisfies browser.GuardianKind,
    };
    const change: browser.PolicyChange = {
      change_id: "4",
      vault_id: "7",
      changes: { recovery_address: "tb1qnew" },
      proposed_at: "1",
      effective_at: "2",
      state: "pending",
      vetoed_by: null,
    };
    const policy: browser.Policy = {
      delay_ns: "86400000000000",
      policy_change_delay_ns: "604800000000000",
      escape_timelock_blocks: 26_280,
      recovery_address: "tb1qhome",
      allowance_limit_sats: "0",
      fee_cap_sats: "20000",
      fast_approval: false,
      fast_approval_floor_ns: "3600000000000",
      guardians: [guardian],
      btc_network: "signet",
      watcher_x25519_pk: "33".repeat(32),
    };
    const vault: browser.Vault = {
      vault_id: "7",
      owner_account: "o.testnet",
      owner_key: `02${"22".repeat(32)}`,
      policy,
      state: "active" satisfies browser.VaultState,
      cosigner_pubkeys: null,
      addresses: null,
      storage_balance: "0",
      created_at: "1",
      pending_change: change,
    };
    expect(vault.pending_change?.changes.recovery_address).toBe("tb1qnew");
    // Types leave nothing behind at run time.
    for (const name of [
      "Vault",
      "Policy",
      "Guardian",
      "GuardianKind",
      "VaultState",
      "PolicyChange",
    ]) {
      expect(Object.keys(browser)).not.toContain(name);
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
    expect(
      browser.failureKind({
        ActionError: { kind: { FunctionCallError: { ExecutionError: "x" } } },
      }),
    ).toBe("ActionError.FunctionCallError.ExecutionError");
    expect(
      browser.decodeSegwitAddress(
        "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
        "signet",
      ).ok,
    ).toBe(true);
    expect(
      browser.p2wshAddress(
        Uint8Array.from(
          Buffer.from(
            "210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
            "hex",
          ),
        ),
        "signet",
      ),
    ).toBe("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7");
    expect(browser.decodeScript(Uint8Array.of(0x63, 0x68)).map((op) => op.name)).toEqual([
      "OP_IF",
      "OP_ENDIF",
    ]);
  });
});
