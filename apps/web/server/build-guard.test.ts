import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { forbiddenPackage } from "../vite.config.ts";

// The production build must never carry the mockup's sample data: vite.config.ts's
// `morrow:no-fixtures-in-build` plugin fails the build when a src/fixtures module is bundled.
// Nor may it carry near-api-js, libsodium or bitcoinjs-lib (`morrow:no-node-packages-in-build`):
// the web imports only `@morrow/core-ts/browser`.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../src/fixtures/mockup-sample.ts", import.meta.url));
// Inside apps/web, so a bare `@morrow/core-ts` import resolves through its node_modules.
mkdirSync(join(ROOT, "node_modules"), { recursive: true });
const dir = mkdtempSync(join(ROOT, "node_modules", ".morrow-build-guard-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Builds `source` as the only entry with the project's vite config, writing nothing. */
function buildEntry(name: string, source: string) {
  const entry = join(dir, name);
  writeFileSync(entry, source);
  return build({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: entry } },
  });
}

describe("no fixtures in the production build", () => {
  it("fails when an entry statically imports the mockup fixture", async () => {
    await expect(
      buildEntry(
        "leak.ts",
        `import { sampleConfig } from ${JSON.stringify(FIXTURE)};\nconsole.log(sampleConfig);\n`,
      ),
    ).rejects.toThrow(
      /src\/fixtures must not be in the production bundle; found mockup-sample\.ts/,
    );
  }, 60_000);

  it("passes an entry that does not", async () => {
    await expect(buildEntry("clean.ts", 'console.log("clean");\n')).resolves.toBeDefined();
  }, 60_000);
});

describe("no Node-only packages in the production build", () => {
  it("knows the packages by their module ids", () => {
    const pnpm = "/repo/node_modules/.pnpm";
    expect(
      forbiddenPackage(`${pnpm}/near-api-js@7.4.0/node_modules/near-api-js/lib/index.js`),
    ).toBe("near-api-js");
    expect(
      forbiddenPackage(
        `${pnpm}/libsodium-sumo@0.8.4/node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js`,
      ),
    ).toBe("libsodium");
    expect(
      forbiddenPackage(
        `\0${pnpm}/bitcoinjs-lib@7.0.5/node_modules/bitcoinjs-lib/src/index.js?commonjs-proxy`,
      ),
    ).toBe("bitcoinjs-lib");
    expect(forbiddenPackage("/repo/packages/core-ts/src/xray/links.ts")).toBeNull();
    expect(
      forbiddenPackage("/repo/node_modules/.pnpm/react@19/node_modules/react/index.js"),
    ).toBeNull();
  });

  it("fails when an entry imports the full @morrow/core-ts", async () => {
    await expect(
      buildEntry(
        "heavy.ts",
        'import { NearContractClient } from "@morrow/core-ts";\nconsole.log(NearContractClient);\n',
      ),
    ).rejects.toThrow(/near-api-js.* must not be in the production bundle/);
  }, 120_000);

  it("passes an entry that imports @morrow/core-ts/browser", async () => {
    await expect(
      buildEntry(
        "light.ts",
        'import { nearTxUrl } from "@morrow/core-ts/browser";\nconsole.log(nearTxUrl("testnet", "h"));\n',
      ),
    ).resolves.toBeDefined();
  }, 60_000);
});
