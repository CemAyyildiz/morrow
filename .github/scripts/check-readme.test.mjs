import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkReadme,
  expectedLines,
  missingLines,
  parseReadmeTable,
  parseScenarios,
} from "./check-readme.mjs";

const SCRIPT = fileURLToPath(new URL("./check-readme.mjs", import.meta.url));

const SCENARIOS_TS = `
export const SCENARIOS: Scenario[] = [
  { id: "S-1", name: "Create", mandatory: true, run: runCreate },
  { id: "S-3", name: "Thief and Clawback", mandatory: true, run: runThief },
  { id: "S-6", name: "Policy Change", mandatory: false },
];
`;

const SOURCES = `
ctx.log("Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)");
ctx.log("You hold the Owner keys. Trying to rob the vault…");
ctx.log("Attacker received 0 sats");
`;

const row = (id, name, expected, progress) =>
  `| ${id} | ${name} | It proves something. | \`MORROW_SCENARIOS=${id} make demo\` | \`${expected}\` | ${progress ? `\`${progress}\`` : "-"} |`;

const S1 = row(
  "S-1",
  "Create",
  "S-1 Create PASS",
  "Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)",
);
const S3 = row(
  "S-3",
  "Thief and Clawback",
  "S-3 Thief and Clawback PASS",
  "Attacker received 0 sats",
);
const S6 = row("S-6", "Policy Change", "S-6 Policy Change SKIP (not built)");

const readme = (rows) => `# Morrow

## Scenarios

| Id | Scenario | What it proves | Command | Expected line | Progress line |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## You hold the Owner keys: try to rob it

\`\`\`text
You hold the Owner keys. Trying to rob the vault…
S-3 Thief and Clawback PASS
\`\`\`

## License
`;

const OK = readme([S1, S3, S6]);
const scenarios = parseScenarios(SCENARIOS_TS);

const LOG = `Morrow Judge Mode: Scenarios S-1, S-3, S-6
  Owner account morrow-judge-x.testnet created through the testnet faucet
  Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)
S-1 Create PASS
  You hold the Owner keys. Trying to rob the vault…
  Attacker received 0 sats
S-3 Thief and Clawback PASS
S-6 Policy Change SKIP (not built)
`;

test("SCENARIOS are read from the judge source, built or not", () => {
  assert.deepEqual(scenarios, [
    { id: "S-1", name: "Create", built: true },
    { id: "S-3", name: "Thief and Clawback", built: true },
    { id: "S-6", name: "Policy Change", built: false },
  ]);
});

test("static check passes when the README table equals SCENARIOS", () => {
  assert.deepEqual(checkReadme(OK, scenarios, SOURCES), []);
});

test("the real README matches the real tools/judge", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("a missing row fails naming the id", () => {
  assert.deepEqual(checkReadme(readme([S1, S6]), scenarios, SOURCES), [
    "S-3: missing from the README table",
  ]);
});

test("a renamed row fails naming the id", () => {
  const renamed = readme([S1, S3.replace("| Thief and Clawback |", "| Thief |"), S6]);
  assert.deepEqual(checkReadme(renamed, scenarios, SOURCES), [
    'S-3: README name "Thief", tools/judge name "Thief and Clawback"',
  ]);
});

test("a row with no command, a wrong expected line or a made-up progress line fails", () => {
  const bad = readme([
    S1.replace("`MORROW_SCENARIOS=S-1 make demo`", ""),
    S3.replace("`Attacker received 0 sats`", "`Attacker received nothing`"),
    S6.replace("SKIP (not built)`", "PASS`"),
  ]);
  assert.deepEqual(checkReadme(bad, scenarios, SOURCES), [
    "S-1: command must be `MORROW_SCENARIOS=S-1 make demo`",
    'S-3: progress line "Attacker received nothing" is not printed by tools/judge',
    "S-6: expected line must be `S-6 Policy Change SKIP (not built)`",
  ]);
});

test("a row for a Scenario tools/judge does not have fails", () => {
  const extra = readme([S1, S3, S6, row("S-9", "Extra", "S-9 Extra PASS", "x")]);
  assert.deepEqual(checkReadme(extra, scenarios, SOURCES), [
    "S-9: in the README but not in tools/judge SCENARIOS",
  ]);
});

test("a built row needs a progress line", () => {
  const bare = readme([row("S-1", "Create", "S-1 Create PASS"), S3, S6]);
  assert.deepEqual(checkReadme(bare, scenarios, SOURCES), [
    "S-1: built Scenario needs a progress line",
  ]);
});

test("log check passes when the log has every expected line", () => {
  const lines = expectedLines(OK);
  assert.deepEqual(lines, [
    "S-1 Create PASS",
    "Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)",
    "S-3 Thief and Clawback PASS",
    "Attacker received 0 sats",
    "S-6 Policy Change SKIP (not built)",
    "You hold the Owner keys. Trying to rob the vault…",
  ]);
  assert.deepEqual(missingLines(lines, LOG), []);
});

test("a SKIP row is held to its exact SKIP line in the log", () => {
  const rows = parseReadmeTable(OK);
  assert.equal(rows.find((r) => r.id === "S-6").expected, "S-6 Policy Change SKIP (not built)");
  const built = LOG.replace("S-6 Policy Change SKIP (not built)", "S-6 Policy Change PASS");
  assert.deepEqual(missingLines(expectedLines(OK), built), ["S-6 Policy Change SKIP (not built)"]);
});

test("log mismatch lists every missing line, and a longer line does not count", () => {
  const log = LOG.replace("Attacker received 0 sats", "Attacker received 900000 sats").replace(
    "S-1 Create PASS",
    "S-1 Create PASS (mock signer: testnet MPC unavailable)",
  );
  assert.deepEqual(missingLines(expectedLines(OK), log), [
    "S-1 Create PASS",
    "Attacker received 0 sats",
  ]);
});

test("the CLI log check exits 1 listing missing lines, and on a missing log file", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-readme-"));
  const log = join(dir, "judge.log");
  writeFileSync(log, "Morrow Judge Mode: Scenarios S-1\nS-1 Create PASS\n");
  const mismatch = spawnSync(process.execPath, [SCRIPT, "--log", log], { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /lacks \d+ README line/);
  assert.match(mismatch.stderr, /S-2 Withdraw after Delay PASS/);
  assert.doesNotMatch(mismatch.stderr, /^ {2}S-1 Create PASS$/m);

  const absent = spawnSync(process.execPath, [SCRIPT, "--log", join(dir, "none.log")], {
    encoding: "utf8",
  });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /Judge Mode log not found/);
});

test("the CLI log check exits 0 on a log with every README line", () => {
  const real = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "check-readme-"));
  const log = join(dir, "judge.log");
  writeFileSync(
    log,
    expectedLines(real)
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  const result = spawnSync(process.execPath, [SCRIPT, "--log", log], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
