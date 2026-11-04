// Keeps the README's Scenario table honest.
//
//   node .github/scripts/check-readme.mjs              static: the table matches tools/judge
//   node .github/scripts/check-readme.mjs --log FILE   every expected line is in a Judge Mode log
//
// The static check compares the README's Scenario rows with `SCENARIOS` in
// tools/judge/src/scenarios.ts (ids, names, built or not) and checks each row's command, expected
// line and progress line. The log check runs after `make demo 2>&1 | tee judge.log` and fails
// listing every expected line the log does not contain.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const SCENARIOS_FILE = "tools/judge/src/scenarios.ts";
const SCENARIO_SOURCES_DIR = "tools/judge/src/scenarios";
const TABLE_HEADING = /^##\s+Scenarios\b/;
const ROB_HEADING = /^##\s+You hold the Owner keys/;

/** `SCENARIOS` from the source of tools/judge/src/scenarios.ts: id, name and whether it is built. */
export function parseScenarios(source) {
  const scenarios = [];
  const entry = /\{\s*id:\s*"(S-\d+)",\s*name:\s*"([^"]+)",([^}]*)\}/g;
  for (const match of source.matchAll(entry)) {
    scenarios.push({ id: match[1], name: match[2], built: /\brun:/.test(match[3]) });
  }
  return scenarios;
}

/** The lines of one `## ` section, without its heading; null when the heading is absent. */
function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

function cells(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** A cell holding one code span gives its text; an empty cell or a dash gives null. */
function code(cell) {
  if (cell === "" || cell === "-" || cell === "—") return null;
  const match = /^`([^`]+)`$/.exec(cell);
  return match ? match[1] : undefined;
}

/**
 * The Scenario table: the rows of the first table under `## Scenarios` whose first cell is a
 * Scenario id. Columns: id, name, what it proves, command, expected line, progress line.
 */
export function parseReadmeTable(readme) {
  const lines = section(readme, TABLE_HEADING);
  if (!lines) return null;
  return lines
    .filter((line) => line.trim().startsWith("|"))
    .map(cells)
    .filter((row) => /^S-\d+$/.test(row[0]))
    .map((row) => {
      const [id, name, proves = "", command = "", expected = "", progress = ""] = row;
      return {
        id,
        name,
        proves,
        command: code(command),
        expected: code(expected),
        progress: code(progress),
        columns: row.length,
      };
    });
}

/** The lines of the code block in the "You hold the Owner keys" section; null when absent. */
export function parseRobLines(readme) {
  const lines = section(readme, ROB_HEADING);
  if (!lines) return null;
  const open = lines.findIndex((line) => /^```text\s*$/.test(line));
  if (open === -1) return [];
  const close = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line));
  return lines.slice(open + 1, close === -1 ? undefined : close).filter((l) => l.trim() !== "");
}

/** The line tools/judge prints when a Scenario ends without a FAIL. */
const resultLine = ({ id, name, built }) => `${id} ${name} ${built ? "PASS" : "SKIP (not built)"}`;

/**
 * Static check. `sources` is the concatenated Scenario source code: every progress line and
 * every line of the "try to rob it" block must be printed by it verbatim.
 */
export function checkReadme(readme, scenarios, sources) {
  const errors = [];
  const rows = parseReadmeTable(readme);
  if (scenarios.length === 0) errors.push(`no Scenarios found in ${SCENARIOS_FILE}`);
  if (!rows) return [...errors, "README has no `## Scenarios` section"];

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`${row.id}: listed twice in the README`);
    seen.add(row.id);
  }
  for (const scenario of scenarios) {
    if (!seen.has(scenario.id)) errors.push(`${scenario.id}: missing from the README table`);
  }

  for (const row of rows) {
    const scenario = scenarios.find((s) => s.id === row.id);
    if (!scenario) {
      errors.push(`${row.id}: in the README but not in tools/judge SCENARIOS`);
      continue;
    }
    if (row.columns !== 6) errors.push(`${row.id}: row has ${row.columns} columns, expected 6`);
    if (row.name !== scenario.name) {
      errors.push(`${row.id}: README name "${row.name}", tools/judge name "${scenario.name}"`);
    }
    if (row.proves === "") errors.push(`${row.id}: "what it proves" is empty`);
    const command = `MORROW_SCENARIOS=${row.id} make demo`;
    if (row.command !== command) errors.push(`${row.id}: command must be \`${command}\``);
    const expected = resultLine(scenario);
    if (row.expected !== expected) errors.push(`${row.id}: expected line must be \`${expected}\``);
    if (row.progress === undefined) {
      errors.push(`${row.id}: progress line must be one code span`);
    } else if (scenario.built && row.progress === null) {
      errors.push(`${row.id}: built Scenario needs a progress line`);
    } else if (!scenario.built && row.progress !== null) {
      errors.push(`${row.id}: a Scenario that is not built prints no progress line`);
    } else if (row.progress !== null && !sources.includes(row.progress)) {
      errors.push(`${row.id}: progress line "${row.progress}" is not printed by tools/judge`);
    }
  }

  const rob = parseRobLines(readme);
  if (rob === null) errors.push('README has no "You hold the Owner keys" section');
  else if (rob.length === 0) errors.push('"You hold the Owner keys" section has no text block');
  else {
    const results = scenarios.map(resultLine);
    for (const line of rob) {
      if (!results.includes(line) && !sources.includes(line)) {
        errors.push(`"You hold the Owner keys" line "${line}" is not printed by tools/judge`);
      }
    }
  }
  return errors;
}

/** Every line a `make demo` log must contain: expected, progress and "try to rob it" lines. */
export function expectedLines(readme) {
  const rows = parseReadmeTable(readme) ?? [];
  const lines = rows.flatMap((row) => [row.expected, row.progress]).filter((l) => l);
  for (const line of parseRobLines(readme) ?? []) if (!lines.includes(line)) lines.push(line);
  return lines;
}

/** The expected lines that are not a whole line of the log (ignoring indentation). */
export function missingLines(expected, log) {
  const present = new Set(log.split(/\r?\n/).map((line) => line.trim()));
  return expected.filter((line) => !present.has(line));
}

function read(path) {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function scenarioSources() {
  const dir = new URL(`${SCENARIO_SOURCES_DIR}/`, ROOT);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => readFileSync(new URL(file, dir), "utf8"))
    .join("\n");
}

export function main(argv) {
  const readme = read("README.md");
  const logIndex = argv.indexOf("--log");
  if (logIndex === -1) {
    const errors = checkReadme(readme, parseScenarios(read(SCENARIOS_FILE)), scenarioSources());
    if (errors.length > 0) {
      console.error("README Scenario table does not match tools/judge:");
      for (const error of errors) console.error(`  ${error}`);
      return 1;
    }
    console.log("README Scenario table: OK");
    return 0;
  }

  const logFile = argv[logIndex + 1];
  if (!logFile) {
    console.error("--log needs the path of a Judge Mode log (make demo 2>&1 | tee judge.log)");
    return 1;
  }
  const resolved = resolve(logFile);
  if (!existsSync(resolved)) {
    console.error(`Judge Mode log not found: ${resolved}. Run make demo 2>&1 | tee ${logFile}`);
    return 1;
  }
  const lines = expectedLines(readme);
  const missing = missingLines(lines, readFileSync(resolved, "utf8"));
  if (missing.length > 0) {
    console.error(`The Judge Mode log lacks ${missing.length} README line(s):`);
    for (const line of missing) console.error(`  ${line}`);
    return 1;
  }
  console.log(`Judge Mode log has all ${lines.length} README lines: OK`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
