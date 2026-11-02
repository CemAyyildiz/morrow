import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

// The production build must never carry the mockup's sample data: vite.config.ts's
// `morrow:no-fixtures-in-build` plugin fails the build when a src/fixtures module is bundled.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../src/fixtures/mockup-sample.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "morrow-build-guard-"));

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
