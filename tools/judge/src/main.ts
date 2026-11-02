import { exitCode, runScenarios } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

const release = process.env.MORROW_RELEASE === "1";
const write = (line: string) => process.stdout.write(`${line}\n`);

const selected = process.env.MORROW_SCENARIOS?.split(",").map((id) => id.trim());
const scenarios = selected ? SCENARIOS.filter((s) => selected.includes(s.id)) : SCENARIOS;

write(
  `Morrow Judge Mode: Scenarios ${scenarios.map((s) => s.id).join(", ")}${release ? " (release)" : ""}`,
);
const results = await runScenarios(scenarios, { release, write });
process.exitCode = exitCode(results);
