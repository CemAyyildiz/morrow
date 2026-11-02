import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findViolations } from "./check-hygiene.mjs";
import { filesOutsideLane, laneOf } from "./check-lanes.mjs";
import { globToRegExp } from "./lib.mjs";

const config = JSON.parse(readFileSync(new URL("../lanes.json", import.meta.url), "utf8"));

test("hygiene allows code, configs and README files", () => {
  assert.deepEqual(
    findViolations(["README.md", "apps/web/README.md", "contracts/vault/src/lib.rs", "LICENSE"]),
    [],
  );
});

test("hygiene rejects stray Markdown and private directories", () => {
  assert.deepEqual(
    findViolations([
      "notes.md",
      "packages/core-ts/CHANGELOG.MD",
      "_bmad/config.toml",
      "_bmad-output/epics.md",
      ".claude/settings.json",
      "docs/research/x.mjs",
      "CLAUDE.md",
      "services/watcher/AGENTS.md",
    ]),
    [
      "notes.md",
      "packages/core-ts/CHANGELOG.MD",
      "_bmad/config.toml",
      "_bmad-output/epics.md",
      ".claude/settings.json",
      "docs/research/x.mjs",
      "CLAUDE.md",
      "services/watcher/AGENTS.md",
    ],
  );
});

test("lane is derived from the branch prefix", () => {
  assert.equal(laneOf("lane-a/1-3-spikes"), "a");
  assert.equal(laneOf("lane-c/1-9-web"), "c");
  assert.equal(laneOf("main"), null);
  assert.equal(laneOf("integration/day-4"), null);
});

test("lane C may not touch contracts", () => {
  assert.deepEqual(
    filesOutsideLane("c", ["apps/web/src/main.tsx", "contracts/vault/src/lib.rs"], config),
    ["contracts/vault/src/lib.rs"],
  );
});

test("shared files are allowed for every lane", () => {
  for (const lane of ["a", "b", "c"]) {
    assert.deepEqual(
      filesOutsideLane(lane, ["pnpm-lock.yaml", ".github/workflows/ci.yml"], config),
      [],
    );
  }
});

test("lane A owns contracts and the escape tool only", () => {
  assert.deepEqual(
    filesOutsideLane(
      "a",
      ["contracts/mock-signer/src/lib.rs", "tools/escape/src/index.ts", "tools/judge/src/index.ts"],
      config,
    ),
    ["tools/judge/src/index.ts"],
  );
});

test("glob matching respects segment boundaries", () => {
  assert.ok(globToRegExp("apps/web/**").test("apps/web/src/a.ts"));
  assert.ok(!globToRegExp("apps/web/**").test("apps/webby/a.ts"));
  assert.ok(!globToRegExp("README.md").test("apps/README.md"));
});
