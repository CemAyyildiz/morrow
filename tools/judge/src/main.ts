import { exitCode, runScenarios } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

const release = process.env.MORROW_RELEASE === "1";
const write = (line: string) => process.stdout.write(`${line}\n`);

write(`Morrow Judge Mode: Scenarios S-1..S-7${release ? " (release)" : ""}`);
const results = await runScenarios(SCENARIOS, { release, write });
process.exitCode = exitCode(results);
