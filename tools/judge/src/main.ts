import { exitCode, runScenarios, selectScenarios } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

const release = process.env.MORROW_RELEASE === "1";
const write = (line: string) => process.stdout.write(`${line}\n`);

const { scenarios, unknown } = selectScenarios(SCENARIOS, process.env.MORROW_SCENARIOS);
if (unknown.length > 0 || scenarios.length === 0) {
  const problem =
    unknown.length > 0 ? `unknown Scenario ids ${unknown.join(", ")}` : "no Scenario selected";
  process.stderr.write(
    `MORROW_SCENARIOS: ${problem}. Known: ${SCENARIOS.map((s) => s.id).join(", ")}\n`,
  );
  process.exit(1);
}

write(
  `Morrow Judge Mode: Scenarios ${scenarios.map((s) => s.id).join(", ")}${release ? " (release)" : ""}`,
);
const results = await runScenarios(scenarios, { release, write });
process.exitCode = exitCode(results);
