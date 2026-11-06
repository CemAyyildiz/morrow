import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LEGACY_CONTRACTS,
  LEGACY_SKIPS,
  checkLog,
  checkReadme,
  expectedLines,
  loadJudge,
  parseReadmeTable,
  parseScenarios,
  propertyLine,
} from "./check-readme.mjs";

const SCRIPT = fileURLToPath(new URL("./check-readme.mjs", import.meta.url));

// A small judge: field order varies, one import is aliased, a commented-out entry and a `run:`
// inside a comment must both be ignored.
const FILES = {
  "tools/judge/src/scenarios.ts": `
import { runCreate } from "./scenarios/s1-create.js";
import { runThief } from "./scenarios/s3-thief.js";
import { runEscapeScenario as runEscape } from "./scenarios/s5-escape.js";

export const SCENARIOS: Scenario[] = [
  { id: "S-1", name: "Create", mandatory: true, run: runCreate },
  // { id: "S-2", name: "Withdraw after Delay", mandatory: true, run: runWithdraw },
  { name: "Thief and Clawback", id: "S-3", run: runThief, mandatory: true },
  {
    id: "S-5",
    name: "Escape",
    mandatory: true,
    run: runEscape,
  },
  { id: "S-6", name: "Policy Change", mandatory: false /* run: later */ },
];
`,
  "tools/judge/src/scenarios/s1-create.ts": `
export async function runCreate(ctx) {
  ctx.log(\`Co-signer keys derived by the NEAR MPC network (\${signer})\`);
}
`,
  "tools/judge/src/scenarios/s3-thief.ts": `
export async function runThief(ctx) {
  ctx.log("You hold the Owner keys. Trying to rob the vault…");
  ctx.log("Thief tries to execute: ERR_CLAWED_BACK");
  ctx.log("Attacker received 0 sats");
}
`,
  "tools/judge/src/scenarios/s5-escape.ts": `
export async function runEscapeScenario(ctx) {
  ctx.log("Vault Kit saved; from here on NEAR is not used");
  ctx.log("NEAR is gone: the contract cannot be reached");
  ctx.log(\`Escape \${txid} confirmed. NEAR not used.\`);
}
`,
  "tools/judge/package.json": JSON.stringify({
    dependencies: { "@morrow/core-ts": "workspace:*", "near-api-js": "7.4.0" },
  }),
  "contracts/vault/src/tests/property.rs": `
const DEFAULT_SEED: u64 = 0x6d6f_7272_6f77; // "morrow"
const DEFAULT_CASES: u32 = 1_000;
fn main() {
    println!(
        "Property suite: {} cases, seed 0x{seed:x}, 0 violations",
        run.cases
    );
}
`,
  "contracts/vault/Cargo.toml": `
[dependencies]
near-sdk.workspace = true
sha2 = { version = "=0.10.9", default-features = false }

[dev-dependencies]
proptest = "1"
`,
};

function writeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "check-readme-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const ROOT = writeTree(FILES);
const judge = loadJudge(ROOT);

const row = (id, name, expected, progress, proves = "It proves something.") =>
  `| ${id} | ${name} | ${proves} | \`MORROW_SCENARIOS=${id} make demo\` | \`${expected}\` | ${progress ? `\`${progress}\`` : "-"} |`;

const ROWS = {
  "S-1": row(
    "S-1",
    "Create",
    "S-1 Create PASS",
    "Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)",
  ),
  "S-3": row(
    "S-3",
    "Thief and Clawback",
    "S-3 Thief and Clawback PASS",
    "Attacker received 0 sats",
  ),
  "S-5": row("S-5", "Escape", "S-5 Escape PASS", "Vault Kit saved; from here on NEAR is not used"),
  "S-6": row("S-6", "Policy Change", "S-6 Policy Change SKIP (not built)"),
};

const ROB = [
  "  …",
  "  You hold the Owner keys. Trying to rob the vault…",
  "  …",
  "  Thief tries to execute: ERR_CLAWED_BACK",
  "  Attacker received 0 sats",
  "S-3 Thief and Clawback PASS",
];

const KILL =
  "`make kill-near-demo` (not run in CI) runs S-5 and prints `NEAR is gone: the contract cannot be reached`.";

function readme({
  rows = Object.values(ROWS),
  rob = ROB,
  kill = KILL,
  libraries = "`near-api-js`, `near-sdk`, `sha2`",
  property = "It prints `Property suite: <N> cases, seed <hex>, 0 violations`; by default `Property suite: 1000 cases, seed 0x6d6f72726f77, 0 violations`.",
} = {}) {
  return `# Morrow

## Scenarios

| Id | Scenario | What it proves | Command | Expected line | Progress line |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

${kill}

${property}
${rob === null ? "" : `\n## You hold the Owner keys: try to rob it\n\n\`\`\`text\n${rob.join("\n")}\n\`\`\`\n`}
## How this was built

- ${libraries}.
`;
}

const OK = readme();

const LOG = `Morrow Judge Mode: Scenarios S-1, S-3, S-5, S-6
  Owner account morrow-judge-x.testnet created through the testnet faucet
  Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)
S-1 Create PASS
  Vault 1 holds 0.01 BTC on regtest
  You hold the Owner keys. Trying to rob the vault…
  Thief's withdrawal 2 is public and waits the Delay
  Thief tries to execute: ERR_CLAWED_BACK
  Attacker received 0 sats
S-3 Thief and Clawback PASS
  Vault Kit saved; from here on NEAR is not used
S-5 Escape PASS
S-6 Policy Change SKIP (not built)
`;

const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const fixture = (content) => {
  const path = join(mkdtempSync(join(tmpdir(), "check-readme-")), "file");
  writeFileSync(path, content);
  return path;
};

// --- SCENARIOS --------------------------------------------------------------------------------

test("SCENARIOS are read field by field, in any order, ignoring comments", () => {
  assert.deepEqual(judge.errors, []);
  assert.deepEqual(judge.scenarios, [
    { id: "S-1", name: "Create", mandatory: true, built: true, run: "runCreate" },
    { id: "S-3", name: "Thief and Clawback", mandatory: true, built: true, run: "runThief" },
    { id: "S-5", name: "Escape", mandatory: true, built: true, run: "runEscape" },
    { id: "S-6", name: "Policy Change", mandatory: false, built: false, run: null },
  ]);
});

test("nested braces in an entry do not split it, and an inline run counts as built", () => {
  const { scenarios, errors } = parseScenarios(`
export const SCENARIOS = [
  { id: "S-1", name: "Create", run: async (ctx) => { if (ctx) { ctx.log("{"); } } },
];`);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    scenarios.map(({ id, built }) => ({ id, built })),
    [{ id: "S-1", built: true }],
  );
});

test("an entry without a name, or an `id:` the reader missed, is an error", () => {
  assert.deepEqual(
    parseScenarios(`export const SCENARIOS = [{ id: "S-1", name: "A" }, { id: "S-2" }];`).errors,
    ["SCENARIOS entry 2 has no id or name"],
  );
  assert.deepEqual(
    parseScenarios(`export const SCENARIOS = [{ id: "S-1", name: "A", meta: { id: "x" } }];`)
      .errors,
    ["SCENARIOS has 2 `id:` keys but 1 entries were read"],
  );
});

test("a mandatory Scenario that is not built is an error", () => {
  const unbuilt = { ...judge, scenarios: judge.scenarios.map((s) => ({ ...s, built: false })) };
  assert.ok(checkReadme(OK, unbuilt).includes("S-1: mandatory Scenario is not built"));
});

// --- Static check -----------------------------------------------------------------------------

test("static check passes when the README matches tools/judge", () => {
  assert.deepEqual(checkReadme(OK, judge), []);
});

test("a missing row fails naming the id", () => {
  const rows = [ROWS["S-1"], ROWS["S-5"], ROWS["S-6"]];
  assert.ok(checkReadme(readme({ rows }), judge).includes("S-3: missing from the README table"));
});

test("a renamed Scenario fails naming the id", () => {
  const rows = { ...ROWS, "S-3": ROWS["S-3"].replace("| Thief and Clawback |", "| Thief |") };
  assert.deepEqual(checkReadme(readme({ rows: Object.values(rows) }), judge), [
    'S-3: README name "Thief", tools/judge name "Thief and Clawback"',
  ]);
});

test("a wrong command or expected line fails", () => {
  const rows = {
    ...ROWS,
    "S-1": ROWS["S-1"].replace("`MORROW_SCENARIOS=S-1 make demo`", ""),
    "S-6": ROWS["S-6"].replace("SKIP (not built)`", "PASS`"),
  };
  assert.deepEqual(checkReadme(readme({ rows: Object.values(rows) }), judge), [
    "S-1: command must be `MORROW_SCENARIOS=S-1 make demo`",
    "S-6: expected line must be `S-6 Policy Change SKIP (not built)`",
  ]);
});

test("wrong column count, duplicate row, extra row, malformed or misplaced progress cells fail", () => {
  const rows = [
    `${ROWS["S-1"]} extra |`,
    ROWS["S-3"].replace("`Attacker received 0 sats`", "Attacker received 0 sats"),
    ROWS["S-3"].replace("`Attacker received 0 sats`", "`Attacker received 0 sats`"),
    ROWS["S-5"],
    row("S-6", "Policy Change", "S-6 Policy Change SKIP (not built)", "Vault Kit saved"),
    row("S-9", "Extra", "S-9 Extra PASS", "x"),
  ];
  assert.deepEqual(checkReadme(readme({ rows }), judge), [
    "S-3: listed twice in the README",
    "S-1: row has 7 columns, expected 6",
    "S-3: progress line must be one code span",
    "S-6: a Scenario that is not built prints no progress line",
    "S-9: in the README but not in tools/judge SCENARIOS",
  ]);
});

test("a built row needs a progress line", () => {
  const rows = { ...ROWS, "S-1": row("S-1", "Create", "S-1 Create PASS") };
  assert.deepEqual(checkReadme(readme({ rows: Object.values(rows) }), judge), [
    "S-1: built Scenario needs a progress line",
  ]);
});

test("an escaped pipe stays inside its cell", () => {
  const rows = {
    ...ROWS,
    "S-6": row("S-6", "Policy Change", "S-6 Policy Change SKIP (not built)", null, "a \\| b"),
  };
  const doc = readme({ rows: Object.values(rows) });
  assert.equal(parseReadmeTable(doc).find((r) => r.id === "S-6").proves, "a | b");
  assert.deepEqual(checkReadme(doc, judge), []);
});

test("a second table in the Scenarios section is not read as Scenario rows", () => {
  const doc = OK.replace(
    "\n`make kill-near-demo`",
    "\n| Id | Other |\n| --- | --- |\n| S-9 | not a Scenario row |\n\n`make kill-near-demo`",
  );
  assert.deepEqual(
    parseReadmeTable(doc).map((r) => r.id),
    ["S-1", "S-3", "S-5", "S-6"],
  );
  assert.deepEqual(checkReadme(doc, judge), []);
});

test("a progress line must be a whole literal in that Scenario's own file", () => {
  const rows = {
    ...ROWS,
    "S-1": ROWS["S-1"].replace("(v1.signer-prod.testnet)", "(v1.signer-prod.testnet) now"),
    "S-3": ROWS["S-3"].replace("Attacker received 0 sats", "Attacker received"),
    "S-5": ROWS["S-5"].replace(
      "Vault Kit saved; from here on NEAR is not used",
      "Attacker received 0 sats",
    ),
  };
  assert.deepEqual(checkReadme(readme({ rows: Object.values(rows) }), judge), [
    'S-1: progress line "Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet) now" is not printed by its Scenario',
    'S-3: progress line "Attacker received" is not printed by its Scenario',
    'S-5: progress line "Attacker received 0 sats" is not printed by its Scenario',
  ]);
  const tail = {
    ...ROWS,
    "S-5": ROWS["S-5"].replace("Vault Kit saved; from here on NEAR is not used", "NEAR not used."),
  };
  assert.deepEqual(checkReadme(readme({ rows: Object.values(tail) }), judge), [
    'S-5: progress line "NEAR not used." is not printed by its Scenario',
  ]);
});

test("the rob excerpt must exist, be indented like the output, and be printed by S-3", () => {
  assert.deepEqual(checkReadme(readme({ rob: null }), judge), [
    'README has no "You hold the Owner keys" section',
  ]);
  const madeUp = ROB.toSpliced(4, 0, "  The vault gave up");
  assert.deepEqual(checkReadme(readme({ rob: madeUp }), judge), [
    '"You hold the Owner keys" line "The vault gave up" is not printed by S-3',
  ]);
  const flat = ROB.map((line) => line.trim());
  assert.deepEqual(checkReadme(readme({ rob: flat }), judge), [
    '"You hold the Owner keys" line "You hold the Owner keys. Trying to rob the vault…" must be indented two spaces',
    '"You hold the Owner keys" line "Thief tries to execute: ERR_CLAWED_BACK" must be indented two spaces',
    '"You hold the Owner keys" line "Attacker received 0 sats" must be indented two spaces',
  ]);
  assert.deepEqual(checkReadme(readme({ rob: ROB.slice(0, -1) }), judge), [
    '"You hold the Owner keys" excerpt must end with `S-3 Thief and Clawback PASS`',
  ]);
  assert.deepEqual(checkReadme(readme({ rob: ["  …"] }), judge), [
    '"You hold the Owner keys" section has no `text` excerpt',
  ]);
});

test("the make kill-near-demo line must be printed by S-5 and labelled not run in CI", () => {
  const madeUp = KILL.replace("NEAR is gone: the contract cannot be reached", "NEAR is gone");
  assert.deepEqual(checkReadme(readme({ kill: madeUp }), judge), [
    '`make kill-near-demo` line "NEAR is gone" is not printed by S-5',
  ]);
  const unlabelled = KILL.replace(" (not run in CI)", "");
  assert.deepEqual(checkReadme(readme({ kill: unlabelled }), judge), [
    "`make kill-near-demo` must be labelled not run in CI",
  ]);
});

test("every runtime dependency must be named under How this was built", () => {
  assert.deepEqual(checkReadme(readme({ libraries: "`near-api-js`, `near-sdk`" }), judge), [
    'dependency `sha2` (contracts/vault) is not listed under "How this was built"',
  ]);
});

// --- Property suite line ----------------------------------------------------------------------

test("the property suite line is the println! format with DEFAULT_CASES and DEFAULT_SEED", () => {
  assert.deepEqual(judge.property, {
    line: "Property suite: 1000 cases, seed 0x6d6f72726f77, 0 violations",
  });
  const real = readFileSync(
    fileURLToPath(new URL("../../contracts/vault/src/tests/property.rs", import.meta.url)),
    "utf8",
  );
  assert.match(
    propertyLine(real).line,
    /^Property suite: \d+ cases, seed 0x[0-9a-f]+, 0 violations$/,
  );
  assert.match(propertyLine("const DEFAULT_CASES: u32 = 1;").error, /expected DEFAULT_CASES/);
  const odd = FILES["contracts/vault/src/tests/property.rs"].replace("{seed:x}", "{seed}");
  assert.match(propertyLine(odd).error, /unexpected `Property suite:` format/);
});

test("a README property suite line that the suite does not print fails", () => {
  assert.deepEqual(checkReadme(OK, judge), []);
  const wrong = readme({
    property: "It prints `Property suite: 500 cases, seed 0x6d6f72726f77, 0 violations`.",
  });
  assert.deepEqual(checkReadme(wrong, judge), [
    "README property suite line `Property suite: 500 cases, seed 0x6d6f72726f77, 0 violations` is not printed; expected `Property suite: 1000 cases, seed 0x6d6f72726f77, 0 violations`",
  ]);
  assert.deepEqual(checkReadme(readme({ property: "" }), judge), [
    "README must quote the property suite line `Property suite: 1000 cases, seed 0x6d6f72726f77, 0 violations`",
  ]);
});

// --- Log check --------------------------------------------------------------------------------

test("log check passes when every expected line is where the README says", () => {
  assert.deepEqual(expectedLines(OK), [
    "S-1 Create PASS",
    "Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)",
    "S-3 Thief and Clawback PASS",
    "Attacker received 0 sats",
    "S-5 Escape PASS",
    "Vault Kit saved; from here on NEAR is not used",
    "S-6 Policy Change SKIP (not built)",
    "You hold the Owner keys. Trying to rob the vault…",
    "Thief tries to execute: ERR_CLAWED_BACK",
  ]);
  assert.deepEqual(checkLog(OK, LOG), []);
});

test("a SKIP row is held to its exact SKIP line in the log", () => {
  const built = LOG.replace("S-6 Policy Change SKIP (not built)", "S-6 Policy Change PASS");
  assert.deepEqual(checkLog(OK, built), ["S-6 Policy Change SKIP (not built)"]);
});

test("a legacy contract's S-6 SKIP stands for the PASS; any other contract's does not", () => {
  assert.deepEqual(LEGACY_CONTRACTS, ["morrow-vault-dev3.testnet"]);
  const progress = "Unconfirmed loosening change auto-vetoed by the Guardian Watcher";
  const built = readme({
    rows: Object.values({
      ...ROWS,
      "S-6": row("S-6", "Policy Change", "S-6 Policy Change PASS", progress),
    }),
  });
  const skipped = (contract) =>
    LOG.replace(
      "S-6 Policy Change SKIP (not built)",
      `S-6 Policy Change SKIP (${contract} predates Policy Changes)`,
    );
  const passed = LOG.replace(
    "S-6 Policy Change SKIP (not built)",
    `  ${progress}\nS-6 Policy Change PASS`,
  );
  assert.deepEqual(checkLog(built, passed), []);
  assert.deepEqual(checkLog(built, skipped("morrow-vault-dev3.testnet")), []);
  assert.deepEqual(checkLog(built, skipped("morrow-vault-dev4.testnet")), [
    "S-6 Policy Change PASS",
  ]);
  assert.deepEqual(checkLog(built, LOG), ["S-6 Policy Change PASS"]);
  // A PASS still needs its progress line, and the SKIP stands in for S-6 only.
  const bare = LOG.replace("S-6 Policy Change SKIP (not built)", "S-6 Policy Change PASS");
  assert.deepEqual(checkLog(built, bare), [`${progress} (in S-6's output)`]);
  // The SKIP must be S-6's whole output, in a log with no S-6 FAIL.
  const dev3 = "S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)";
  const withFail = LOG.replace(
    "S-6 Policy Change SKIP (not built)",
    `S-6 Policy Change FAIL: ERR_SCRIPT_BOUND expected\n${dev3}`,
  );
  assert.deepEqual(checkLog(built, withFail), ["S-6 Policy Change PASS"]);
  const withProgress = LOG.replace(
    "S-6 Policy Change SKIP (not built)",
    `  Script-bound change rejected: ERR_SCRIPT_BOUND\n${dev3}`,
  );
  assert.deepEqual(checkLog(built, withProgress), ["S-6 Policy Change PASS"]);
  const indented = LOG.replace("S-6 Policy Change SKIP (not built)", `  ${dev3}`);
  assert.deepEqual(checkLog(built, indented), ["S-6 Policy Change PASS"]);
  const s5 = skipped("morrow-vault-dev3.testnet").replace(
    "S-5 Escape PASS",
    "S-5 Escape SKIP (morrow-vault-dev3.testnet predates Policy Changes)",
  );
  assert.deepEqual(checkLog(built, s5), ["S-5 Escape PASS"]);
});

test("each legacy Scenario has its own SKIP reason, held to the same rules", () => {
  assert.deepEqual(LEGACY_SKIPS, {
    "S-6": "predates Policy Changes",
    "S-7": "predates Fast Approval",
  });
  const s6 = "Unconfirmed loosening change auto-vetoed by the Guardian Watcher";
  const s7 = "Fast-approved by the Trusted Contact: the Delay now ends at the Fast Approval Floor";
  const built = readme({
    rows: Object.values({
      ...ROWS,
      "S-6": row("S-6", "Policy Change", "S-6 Policy Change PASS", s6),
      "S-7": row("S-7", "Fast Approval", "S-7 Fast Approval PASS", s7),
    }),
  });
  const skip6 = "S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)";
  const skip7 = (contract, reason = "predates Fast Approval") =>
    `S-7 Fast Approval SKIP (${contract} ${reason})`;
  const log = (s7Output) =>
    LOG.replace("S-6 Policy Change SKIP (not built)", `${skip6}\n${s7Output}`);
  assert.deepEqual(checkLog(built, log(skip7("morrow-vault-dev3.testnet"))), []);
  assert.deepEqual(checkLog(built, log(`  ${s7}\nS-7 Fast Approval PASS`)), []);
  for (const loosened of [
    skip7("morrow-vault-dev4.testnet"),
    skip7("morrow-vault-dev3.testnet", "predates Policy Changes"),
    `  ${s7}\n${skip7("morrow-vault-dev3.testnet")}`,
    `S-7 Fast Approval FAIL: ERR_UNAUTHORIZED expected\n${skip7("morrow-vault-dev3.testnet")}`,
    `  ${skip7("morrow-vault-dev3.testnet")}`,
  ]) {
    assert.deepEqual(checkLog(built, log(loosened)), ["S-7 Fast Approval PASS"], loosened);
  }
});

test("log mismatch lists every missing line, and a longer line does not count", () => {
  const log = LOG.replace("Attacker received 0 sats", "Attacker received 900000 sats").replace(
    "S-1 Create PASS",
    "S-1 Create PASS (mock signer: testnet MPC unavailable)",
  );
  assert.deepEqual(checkLog(OK, log), [
    "S-1 Create PASS",
    "Attacker received 0 sats (in S-3's output)",
    "Attacker received 0 sats (in order in S-3's output)",
  ]);
});

test("a progress line printed under another Scenario does not count", () => {
  const log = LOG.replace("  Vault Kit saved; from here on NEAR is not used\n", "").replace(
    "S-3 Thief and Clawback PASS\n",
    "S-3 Thief and Clawback PASS\n  Vault Kit saved; from here on NEAR is not used\nS-4 Duress SKIP (not built)\n",
  );
  assert.deepEqual(checkLog(OK, log), [
    "Vault Kit saved; from here on NEAR is not used (in S-5's output)",
  ]);
});

test("the rob excerpt must appear in order in S-3's output", () => {
  const log = LOG.replace(
    "  Thief tries to execute: ERR_CLAWED_BACK\n  Attacker received 0 sats",
    "  Attacker received 0 sats\n  Thief tries to execute: ERR_CLAWED_BACK",
  );
  assert.deepEqual(checkLog(OK, log), ["Attacker received 0 sats (in order in S-3's output)"]);
});

test("a README with no expected lines fails the log check", () => {
  assert.deepEqual(checkLog("# Morrow\n", LOG), ["the README has no expected lines"]);
});

// --- CLI --------------------------------------------------------------------------------------

test("CLI: static mismatch exits 1 naming the id; a match exits 0", () => {
  const bad = cli(["--root", ROOT, "--readme", fixture(readme({ rows: [ROWS["S-1"]] }))]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /S-3: missing from the README table/);
  const good = cli(["--root", ROOT, "--readme", fixture(OK)]);
  assert.equal(good.status, 0, good.stderr);
});

test("CLI: log mode runs the static check first", () => {
  const result = cli([
    "--root",
    ROOT,
    "--readme",
    fixture(readme({ rows: [] })),
    "--log",
    fixture(LOG),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing from the README table/);
});

test("CLI: log match exits 0, mismatch exits 1 listing the missing lines", () => {
  const args = ["--root", ROOT, "--readme", fixture(OK), "--log"];
  const good = cli([...args, fixture(LOG)]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /all 9 README lines: OK/);
  const bad = cli([...args, fixture("S-1 Create PASS\n")]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /lacks \d+ README line/);
  assert.match(bad.stderr, /^ {2}S-5 Escape PASS$/m);
});

test("CLI: a missing log, a directory or a flag in place of the path exits 1 clearly", () => {
  const base = ["--root", ROOT, "--readme", fixture(OK), "--log"];
  const missing = cli([...base, join(ROOT, "none.log")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Judge Mode log not found or not a file/);
  const directory = cli([...base, ROOT]);
  assert.equal(directory.status, 1);
  assert.match(directory.stderr, /not a file/);
  const flag = cli(["--log", "--readme", fixture(OK)]);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /--log needs a path/);
});

test("CLI: run through a symlink, the script still checks and reports the real result", () => {
  const link = join(mkdtempSync(join(tmpdir(), "check-readme-")), "check-readme.mjs");
  symlinkSync(SCRIPT, link);
  const run = (doc) =>
    spawnSync(process.execPath, [link, "--root", ROOT, "--readme", fixture(doc)], {
      encoding: "utf8",
    });
  assert.equal(run(readme({ rows: [ROWS["S-1"]] })).status, 1);
  assert.equal(run(OK).status, 0);
});

test("importing the script without a script path neither throws nor runs the check", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
