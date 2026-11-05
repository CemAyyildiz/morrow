import type { Scenario } from "./scenarios.js";

export type Outcome = "PASS" | "FAIL" | "SKIP (not built)" | `SKIP (${string})`;

/**
 * Thrown by a Scenario that cannot run against this deployment, before it sends anything. Its
 * outcome is `SKIP (<reason>)`, never a FAIL, even for a mandatory Scenario in a release build.
 */
export class ScenarioSkip extends Error {
  override readonly name = "ScenarioSkip";

  constructor(readonly reason: string) {
    super(reason);
  }
}

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

/**
 * The Scenarios a `MORROW_SCENARIOS` value (comma-separated ids) selects, in registry order, and
 * the ids it names that do not exist. Unset selects every Scenario.
 */
export function selectScenarios(
  all: Scenario[],
  value: string | undefined,
): { scenarios: Scenario[]; unknown: string[] } {
  if (value === undefined) return { scenarios: all, unknown: [] };
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return {
    scenarios: all.filter((s) => ids.includes(s.id)),
    unknown: ids.filter((id) => !all.some((s) => s.id === id)),
  };
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
        result =
          error instanceof ScenarioSkip
            ? { scenario, outcome: `SKIP (${error.reason})` }
            : {
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
