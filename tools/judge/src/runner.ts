import type { Scenario } from "./scenarios.js";

export type Outcome = "PASS" | "FAIL" | "SKIP (not built)";

export interface ScenarioResult {
  scenario: Scenario;
  outcome: Outcome;
  detail?: string;
}

export interface RunOptions {
  /** Release builds treat a skipped mandatory Scenario as a failure. */
  release: boolean;
  write: (line: string) => void;
}

export function formatResult({ scenario, outcome, detail }: ScenarioResult): string {
  const line = `${scenario.id} ${scenario.name} ${outcome}`;
  return detail ? `${line}: ${detail}` : line;
}

export async function runScenarios(
  scenarios: Scenario[],
  options: RunOptions,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    let result: ScenarioResult;
    if (!scenario.run) {
      result =
        options.release && scenario.mandatory
          ? { scenario, outcome: "FAIL", detail: "mandatory Scenario not built" }
          : { scenario, outcome: "SKIP (not built)" };
    } else {
      try {
        await scenario.run({ log: (message) => options.write(`  ${message}`) });
        result = { scenario, outcome: "PASS" };
      } catch (error) {
        result = {
          scenario,
          outcome: "FAIL",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    options.write(formatResult(result));
    results.push(result);
  }
  return results;
}

export function exitCode(results: ScenarioResult[]): number {
  return results.some((r) => r.outcome === "FAIL") ? 1 : 0;
}
