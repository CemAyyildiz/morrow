// Keeps the README's Scenario claims honest.
//
//   node .github/scripts/check-readme.mjs              static: the README matches tools/judge
//   node .github/scripts/check-readme.mjs --log FILE   static, then: the Judge Mode log has every
//                                                      expected line where the README says
//   --readme PATH   README to check (default: README.md at the repo root)
//   --root PATH     repository root holding tools/judge and the manifests (default: this repo)
//
// Static: the `## Scenarios` table equals `SCENARIOS` in tools/judge/src/scenarios.ts (ids, names,
// built or not); every row has the exact command and result line; every progress line, every line
// of the "You hold the Owner keys" excerpt and the `make kill-near-demo` line is a whole string
// literal in that Scenario's own file (or runner.ts / session.ts), where `${…}` in a template
// stands for one token; every runtime dependency is named under "How this was built"; every
// `Property suite: …` line the README quotes is the line contracts/vault/src/tests/property.rs
// prints with its DEFAULT_CASES and DEFAULT_SEED.
// Log: each result line is a whole line of the log, each progress line sits between the previous
// result line and its own, and the excerpt's lines appear in that order in S-3's output.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const JUDGE_SRC = "tools/judge/src";
const SHARED_FILES = ["runner.ts", "session.ts"];
const WORKSPACE_DIRS = ["apps", "packages", "services", "tools"];
const ELISION = "…";
const PROPERTY_SUITE = "contracts/vault/src/tests/property.rs";

// ---------------------------------------------------------------------------------------------
// TypeScript source: comments blanked, string interiors masked, literals collected.

function decode(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
    if (e[0] === "u" || e[0] === "x") {
      return String.fromCodePoint(parseInt(e.replace(/^u\{?|^x|\}$/g, ""), 16));
    }
    return { n: "\n", t: "\t", r: "\r", 0: "\0" }[e] ?? e;
  });
}

/** `masked`: the source with comments and string contents blanked (same length). */
export function scanSource(source) {
  const masked = source.split("");
  const literals = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (masked[k] !== "\n") masked[k] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n")
        j += source[j] === "\\" ? 2 : 1;
      const text = decode(source.slice(i + 1, j));
      literals.push({ start: i, text, parts: [text] });
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`") {
      const parts = [];
      let chunk = "";
      let j = i + 1;
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\") {
          chunk += source.slice(j, j + 2);
          j += 2;
        } else if (source[j] === "$" && source[j + 1] === "{") {
          parts.push(decode(chunk));
          chunk = "";
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
        } else {
          chunk += source[j];
          j++;
        }
      }
      parts.push(decode(chunk));
      literals.push({ start: i, text: parts.join("${}"), parts });
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return { masked: masked.join(""), literals };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `line` is a whole string literal of `source`; `${…}` matches one token. */
export function printedBy(line, sources) {
  return sources.some((source) =>
    scanSource(source).literals.some(({ parts }) =>
      parts.length === 1
        ? parts[0] === line
        : new RegExp(`^${parts.map(escapeRegExp).join("\\S+")}$`).test(line),
    ),
  );
}

/** An entry's masked text with everything nested inside it blanked: only its own keys remain. */
function topLevel(masked) {
  let depth = 0;
  return masked
    .split("")
    .map((ch) => {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      const out = depth > 1 && ch !== "\n" ? " " : ch;
      if (ch === "}" || ch === "]" || ch === ")") depth--;
      return out;
    })
    .join("");
}

/**
 * `SCENARIOS` from the source of tools/judge/src/scenarios.ts. Each entry is read field by field
 * (any order, nested braces and comments ignored): id, name, mandatory, and `run` (its identifier,
 * or true for an inline function). Returns the entries and any reading errors.
 */
export function parseScenarios(source) {
  const { masked, literals } = scanSource(source);
  const decl = /\bSCENARIOS\b[^=;]*=\s*\[/.exec(masked);
  if (!decl) return { scenarios: [], errors: ["no `SCENARIOS = [` array"] };
  const open = decl.index + decl[0].length - 1;
  const entries = [];
  let depth = 0;
  let start = -1;
  let close = masked.length;
  for (let j = open + 1; j < masked.length; j++) {
    const ch = masked[j];
    if (ch === "{" || ch === "[" || ch === "(") {
      if (depth === 0 && ch === "{") start = j;
      depth++;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) {
        close = j;
        break;
      }
      depth--;
      if (depth === 0 && ch === "}") entries.push([start, j + 1]);
    }
  }

  const errors = [];
  const literalAt = (pos) => literals.find((l) => l.start === pos)?.text;
  const scenarios = [];
  for (const [from, to] of entries) {
    const top = topLevel(masked.slice(from, to));
    const field = (key) => {
      const m = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*`).exec(top);
      return m ? from + m.index + m[0].length : -1;
    };
    const id = literalAt(field("id"));
    const name = literalAt(field("name"));
    const mandatory = /(?:^|[{,\s])mandatory\s*:\s*true\b/.test(top);
    const runAt = field("run");
    const run = runAt === -1 ? null : (/^[A-Za-z_$][\w$]*/.exec(masked.slice(runAt))?.[0] ?? true);
    if (!id || !name) errors.push(`SCENARIOS entry ${scenarios.length + 1} has no id or name`);
    else scenarios.push({ id, name, mandatory, built: run !== null, run });
  }
  const idKeys = (masked.slice(open, close).match(/(?:^|[{,\s])id\s*:/g) ?? []).length;
  if (idKeys !== entries.length) {
    errors.push(`SCENARIOS has ${idKeys} \`id:\` keys but ${entries.length} entries were read`);
  }
  return { scenarios, errors };
}

/** Imported identifier -> module path, as written. */
function imports(source) {
  const map = new Map();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const spec of m[1].split(",")) {
      const local = spec
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (local) map.set(local, m[2]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// The README.

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
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** A cell holding one code span gives its text; an empty cell or a dash gives null. */
function code(cell) {
  if (cell === "" || cell === "-" || cell === "—") return null;
  const match = /^`([^`]+)`$/.exec(cell);
  return match ? match[1] : undefined;
}

/**
 * The data rows of the first table under `## Scenarios` (it ends at the first line that is not a
 * table row). Columns: id, name, what it proves, command, expected line, progress line.
 */
export function parseReadmeTable(readme) {
  const lines = section(readme, /^##\s+Scenarios\b/);
  if (!lines) return null;
  const first = lines.findIndex((line) => line.trim().startsWith("|"));
  if (first === -1) return [];
  const end = lines.findIndex((line, i) => i > first && !line.trim().startsWith("|"));
  return lines
    .slice(first + 2, end === -1 ? undefined : end)
    .map(cells)
    .map((row) => {
      const [id, name = "", proves = "", command = "", expected = "", progress = ""] = row;
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

/** The raw lines of the `text` block under "You hold the Owner keys"; null when absent. */
export function parseRobLines(readme) {
  const lines = section(readme, /^##\s+You hold the Owner keys/);
  if (!lines) return null;
  const open = lines.findIndex((line) => /^```text\s*$/.test(line));
  if (open === -1) return [];
  const close = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line));
  return lines.slice(open + 1, close === -1 ? undefined : close).filter((l) => l.trim() !== "");
}

const robOutput = (rob) => rob.filter((line) => line.trim() !== ELISION);

/** The `make kill-near-demo` paragraph: the line it quotes and whether it says "not run in CI". */
export function parseKillNear(readme) {
  const paragraph = readme.split(/\n\s*\n/).find((p) => p.includes("`make kill-near-demo`"));
  if (!paragraph) return null;
  const quoted = /`make kill-near-demo`[^`]*`([^`]+)`/.exec(paragraph)?.[1] ?? null;
  return { quoted, labelled: /not run in CI/.test(paragraph) };
}

// ---------------------------------------------------------------------------------------------
// The property suite's printed line.

/**
 * The line the property suite prints on a default run: its `Property suite:` `println!` format
 * with `DEFAULT_CASES` and `DEFAULT_SEED` filled in. `{ line }`, or `{ error }`.
 */
export function propertyLine(source) {
  const cases = /\bconst DEFAULT_CASES: u32 = ([0-9_]+);/.exec(source);
  const seed = /\bconst DEFAULT_SEED: u64 = 0x([0-9a-fA-F_]+);/.exec(source);
  const prints = [...source.matchAll(/println!\(\s*"(Property suite: [^"]*)"/g)];
  if (!cases || !seed || prints.length !== 1) {
    return {
      error: `${PROPERTY_SUITE}: expected DEFAULT_CASES, DEFAULT_SEED and one \`Property suite:\` println!`,
    };
  }
  const format = prints[0][1];
  // The format takes the case count as its first argument, `{}`, and the seed as `{seed:x}`.
  if (!format.includes("{}") || !format.includes("0x{seed:x}")) {
    return { error: `${PROPERTY_SUITE}: unexpected \`Property suite:\` format "${format}"` };
  }
  const line = format
    .replace("{}", BigInt(cases[1].replaceAll("_", "")).toString())
    .replace("{seed:x}", BigInt(`0x${seed[1].replaceAll("_", "")}`).toString(16));
  if (/[{}]/.test(line)) {
    return { error: `${PROPERTY_SUITE}: unexpected \`Property suite:\` format "${format}"` };
  }
  return { line };
}

// ---------------------------------------------------------------------------------------------
// Checks.

/** The line tools/judge prints when a Scenario ends without a FAIL. */
const resultLine = ({ id, name, built }) => `${id} ${name} ${built ? "PASS" : "SKIP (not built)"}`;

/**
 * Static check. `judge` = { scenarios, errors, files: { [id]: source[] }, shared: source[],
 * dependencies: [{ where, name }] }.
 */
export function checkReadme(readme, judge) {
  const { scenarios } = judge;
  const errors = [...judge.errors];
  if (scenarios.length === 0) errors.push("no Scenarios read from tools/judge SCENARIOS");
  const sourcesOf = (id) => [...(judge.files[id] ?? []), ...judge.shared];

  for (const s of scenarios) {
    if (s.mandatory && !s.built) errors.push(`${s.id}: mandatory Scenario is not built`);
  }

  const rows = parseReadmeTable(readme);
  if (!rows) return [...errors, "README has no `## Scenarios` section"];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`${row.id}: listed twice in the README`);
    seen.add(row.id);
  }
  for (const s of scenarios) {
    if (!seen.has(s.id)) errors.push(`${s.id}: missing from the README table`);
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
    } else if (row.progress !== null && !printedBy(row.progress, sourcesOf(row.id))) {
      errors.push(`${row.id}: progress line "${row.progress}" is not printed by its Scenario`);
    }
  }

  const rob = parseRobLines(readme);
  const s3 = scenarios.find((s) => s.id === "S-3");
  if (rob === null) errors.push('README has no "You hold the Owner keys" section');
  else if (robOutput(rob).length === 0) {
    errors.push('"You hold the Owner keys" section has no `text` excerpt');
  } else {
    const output = robOutput(rob);
    const last = output.pop();
    if (!s3 || last !== resultLine(s3)) {
      errors.push(
        `"You hold the Owner keys" excerpt must end with \`${s3 ? resultLine(s3) : "S-3"}\``,
      );
    }
    for (const line of output) {
      if (!/^ {2}\S/.test(line)) {
        errors.push(`"You hold the Owner keys" line "${line}" must be indented two spaces`);
      } else if (!printedBy(line.trim(), sourcesOf("S-3"))) {
        errors.push(`"You hold the Owner keys" line "${line.trim()}" is not printed by S-3`);
      }
    }
  }

  const kill = parseKillNear(readme);
  if (kill?.quoted && !printedBy(kill.quoted, sourcesOf("S-5"))) {
    errors.push(`\`make kill-near-demo\` line "${kill.quoted}" is not printed by S-5`);
  }
  if (kill && !kill.labelled) errors.push("`make kill-near-demo` must be labelled not run in CI");

  if (judge.property?.error) errors.push(judge.property.error);
  else if (judge.property) {
    const { line } = judge.property;
    // `<N>`-style placeholders describe the format; every concrete line must be the real one.
    const quoted = [...readme.matchAll(/`(Property suite: [^`]*)`/g)]
      .map((m) => m[1])
      .filter((q) => !q.includes("<"));
    if (quoted.length === 0) errors.push(`README must quote the property suite line \`${line}\``);
    for (const q of quoted) {
      if (q !== line)
        errors.push(`README property suite line \`${q}\` is not printed; expected \`${line}\``);
    }
  }

  const built = section(readme, /^##\s+How this was built/)?.join("\n") ?? "";
  for (const { where, name } of judge.dependencies) {
    if (!built.includes(`\`${name}\``)) {
      errors.push(`dependency \`${name}\` (${where}) is not listed under "How this was built"`);
    }
  }
  return errors;
}

/** Every line a `make demo` log must hold. */
export function expectedLines(readme) {
  const rows = parseReadmeTable(readme) ?? [];
  const lines = rows.flatMap((row) => [row.expected, row.progress]).filter((l) => l);
  for (const line of robOutput(parseRobLines(readme) ?? [])) {
    if (!lines.includes(line.trim())) lines.push(line.trim());
  }
  return lines;
}

/**
 * Deployments older than Policy Changes (Story 5.1). Against one of these, S-6 ends
 * `S-6 Policy Change SKIP (<contract> predates Policy Changes)` and sends nothing, and the log
 * check accepts that line in place of S-6's PASS. Against any other contract the PASS is required,
 * so once the default contract moves on (Story 7.5b) the SKIP no longer counts.
 */
export const LEGACY_CONTRACTS = ["morrow-vault-dev3.testnet"];

/** The lines a log may hold in place of a row's expected line: only S-6's legacy SKIP. */
function substitutes(row) {
  if (row.id !== "S-6" || row.expected !== `${row.id} ${row.name} PASS`) return [];
  return LEGACY_CONTRACTS.map(
    (contract) => `${row.id} ${row.name} SKIP (${contract} predates Policy Changes)`,
  );
}

/**
 * Log check: what the log lacks. A Scenario's output runs from the line after the previous
 * unindented line (banner or result) to its own result line. A legacy SKIP (`substitutes`) stands
 * for the expected line and its progress line, but only as the Scenario's whole output (the
 * unindented result line alone, with no progress line before it) and only in a log without a FAIL
 * line for that Scenario.
 */
export function checkLog(readme, log) {
  const lines = log.split(/\r?\n/).map((line) => line.trimEnd());
  const rows = parseReadmeTable(readme) ?? [];
  if (expectedLines(readme).length === 0) return ["the README has no expected lines"];
  const missing = [];
  const outputOf = (expected) => {
    const at = lines.indexOf(expected);
    if (at === -1) return null;
    let from = at;
    while (from > 0 && /^\s/.test(lines[from - 1])) from--;
    return lines.slice(from, at + 1);
  };
  const legacySkip = (row) =>
    !lines.some((line) => line.startsWith(`${row.id} ${row.name} FAIL`)) &&
    substitutes(row).some((skip) => outputOf(skip)?.length === 1);
  for (const row of rows) {
    if (!row.expected) continue;
    const output = outputOf(row.expected);
    if (!output) {
      if (!legacySkip(row)) missing.push(row.expected);
      continue;
    }
    if (row.progress && !output.some((line) => line.trim() === row.progress)) {
      missing.push(`${row.progress} (in ${row.id}'s output)`);
    }
  }
  const rob = robOutput(parseRobLines(readme) ?? []);
  const s3 = rows.find((row) => row.id === "S-3")?.expected;
  const output = s3 ? outputOf(s3) : null;
  if (rob.length > 0 && output) {
    let k = 0;
    for (const line of rob) {
      while (k < output.length && output[k] !== line.trimEnd()) k++;
      if (k === output.length) {
        missing.push(`${line.trim()} (in order in S-3's output)`);
        break;
      }
      k++;
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Files.

function cargoDependencies(toml) {
  const names = [];
  let inDeps = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) inDeps = header[1].trim() === "dependencies";
    else if (inDeps) {
      const m = /^\s*([A-Za-z0-9_-]+)(?:\.workspace)?\s*=/.exec(line);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** Reads tools/judge and the manifests under `root`. */
export function loadJudge(root) {
  const src = join(root, JUDGE_SRC);
  const scenariosFile = join(src, "scenarios.ts");
  const source = readFileSync(scenariosFile, "utf8");
  const { scenarios, errors } = parseScenarios(source);
  const modules = imports(source);
  const files = {};
  for (const s of scenarios) {
    const module = typeof s.run === "string" ? modules.get(s.run) : null;
    const path = module ? resolve(dirname(scenariosFile), module.replace(/\.js$/, ".ts")) : null;
    files[s.id] = path && existsSync(path) ? [readFileSync(path, "utf8")] : [source];
  }
  const shared = SHARED_FILES.map((f) => join(src, f))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"));

  const dependencies = [];
  for (const dir of WORKSPACE_DIRS) {
    for (const name of listDir(join(root, dir))) {
      const manifest = join(root, dir, name, "package.json");
      if (!existsSync(manifest)) continue;
      const deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
      for (const [dep, version] of Object.entries(deps)) {
        if (!String(version).startsWith("workspace:")) {
          dependencies.push({ where: `${dir}/${name}`, name: dep });
        }
      }
    }
  }
  for (const name of listDir(join(root, "contracts"))) {
    const manifest = join(root, "contracts", name, "Cargo.toml");
    if (!existsSync(manifest)) continue;
    for (const dep of cargoDependencies(readFileSync(manifest, "utf8"))) {
      dependencies.push({ where: `contracts/${name}`, name: dep });
    }
  }
  const propertyFile = join(root, PROPERTY_SUITE);
  const property = existsSync(propertyFile)
    ? propertyLine(readFileSync(propertyFile, "utf8"))
    : null;
  return { scenarios, errors, files, shared, dependencies, property };
}

// ---------------------------------------------------------------------------------------------
// CLI.

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--log", "--readme", "--root"].includes(flag)) return { error: `unknown option ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a path` };
    values[flag.slice(2)] = value;
    i++;
  }
  return values;
}

export function main(argv) {
  const opts = options(argv);
  if (opts.error) {
    console.error(
      `${opts.error}. Usage: check-readme.mjs [--log FILE] [--readme FILE] [--root DIR]`,
    );
    return 1;
  }
  const root = resolve(opts.root ?? DEFAULT_ROOT);
  const readme = readFileSync(resolve(opts.readme ?? join(root, "README.md")), "utf8");
  const errors = checkReadme(readme, loadJudge(root));
  if (errors.length > 0) {
    console.error("README does not match tools/judge:");
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  if (opts.log === undefined) {
    console.log("README Scenario table: OK");
    return 0;
  }

  const log = resolve(opts.log);
  if (!existsSync(log) || !statSync(log).isFile()) {
    console.error(
      `Judge Mode log not found or not a file: ${log}. Run make demo 2>&1 | tee judge.log`,
    );
    return 1;
  }
  const missing = checkLog(readme, readFileSync(log, "utf8"));
  if (missing.length > 0) {
    console.error(`The Judge Mode log lacks ${missing.length} README line(s):`);
    for (const line of missing) console.error(`  ${line}`);
    return 1;
  }
  console.log(`Judge Mode log has all ${expectedLines(readme).length} README lines: OK`);
  return 0;
}

/** The real path of the script node was asked to run; null under `node -e` or an import. */
function invokedPath() {
  if (!process.argv[1]) return null;
  try {
    return realpathSync(resolve(process.argv[1]));
  } catch {
    return null;
  }
}

if (invokedPath() === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
