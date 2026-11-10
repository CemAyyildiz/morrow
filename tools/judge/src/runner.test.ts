import { describe, expect, it } from "vitest";
import { ScenarioSkip, exitCode, runScenarios, selectScenarios } from "./runner.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

async function run(scenarios: Scenario[], release = false) {
  const lines: string[] = [];
  const results = await runScenarios(scenarios, { release, write: (line) => lines.push(line) });
  return { lines, code: exitCode(results) };
}

/** The registry with every Scenario marked as not built. */
const UNBUILT: Scenario[] = SCENARIOS.map(({ id, name, mandatory }) => ({ id, name, mandatory }));

describe("judge runner", () => {
  it("has every Scenario built, S-4 Duress included", () => {
    expect(SCENARIOS.filter((s) => !s.run).map((s) => s.id)).toEqual([]);
    expect(SCENARIOS.find((s) => s.id === "S-4")).toMatchObject({ mandatory: false });
  });

  it("prints one SKIP line per unbuilt Scenario and exits 0", async () => {
    const { lines, code } = await run(UNBUILT);
    expect(lines).toEqual([
      "S-1 Create SKIP (not built)",
      "S-2 Withdraw after Delay SKIP (not built)",
      "S-3 Thief and Clawback SKIP (not built)",
      "S-4 Duress SKIP (not built)",
      "S-5 Escape SKIP (not built)",
      "S-6 Policy Change SKIP (not built)",
      "S-7 Fast Approval SKIP (not built)",
    ]);
    expect(code).toBe(0);
  });

  it("fails a release build when a mandatory Scenario is not built", async () => {
    const { lines, code } = await run(UNBUILT, true);
    expect(lines[0]).toBe("S-1 Create FAIL: mandatory Scenario not built");
    expect(lines[3]).toBe("S-4 Duress SKIP (not built)");
    expect(code).toBe(1);
  });

  it("reports PASS, and FAIL with the error message", async () => {
    const { lines, code } = await run([
      {
        id: "S-1",
        name: "Create",
        mandatory: true,
        run: async (ctx) => ctx.log("vault 1 created"),
      },
      {
        id: "S-2",
        name: "Withdraw after Delay",
        mandatory: true,
        run: async () => {
          throw new Error("ERR_NOT_EXECUTABLE expected");
        },
      },
    ]);
    expect(lines).toEqual([
      "  vault 1 created",
      "S-1 Create PASS",
      "S-2 Withdraw after Delay FAIL: ERR_NOT_EXECUTABLE expected",
    ]);
    expect(code).toBe(1);
  });

  it("reports a ScenarioSkip as SKIP with its reason, and exits 0", async () => {
    const skip = async () => {
      throw new ScenarioSkip("morrow-vault-dev3.testnet predates Policy Changes");
    };
    const scenarios: Scenario[] = [
      { id: "S-6", name: "Policy Change", mandatory: false, run: skip },
      { id: "S-1", name: "Create", mandatory: true, run: skip },
    ];
    const { lines, code } = await run(scenarios);
    expect(lines).toEqual([
      "S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)",
      "S-1 Create SKIP (morrow-vault-dev3.testnet predates Policy Changes)",
    ]);
    expect(code).toBe(0);

    // A release build fails a mandatory Scenario that skips; a non-mandatory one still skips.
    const release = await run(scenarios, true);
    expect(release.lines).toEqual([
      "S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)",
      "S-1 Create FAIL: mandatory Scenario skipped: morrow-vault-dev3.testnet predates Policy Changes",
    ]);
    expect(release.code).toBe(1);
  });
});

describe("selectScenarios", () => {
  it("selects every Scenario when MORROW_SCENARIOS is unset", () => {
    expect(selectScenarios(SCENARIOS, undefined)).toEqual({ scenarios: SCENARIOS, unknown: [] });
  });

  it("selects the named ids in registry order", () => {
    const { scenarios, unknown } = selectScenarios(SCENARIOS, " S-5,S-1 ");
    expect(scenarios.map((s) => s.id)).toEqual(["S-1", "S-5"]);
    expect(unknown).toEqual([]);
  });

  it("names ids that do not exist, so main exits 1 instead of running nothing", () => {
    const { scenarios, unknown } = selectScenarios(SCENARIOS, "S-1,S-9,s-2");
    expect(scenarios.map((s) => s.id)).toEqual(["S-1"]);
    expect(unknown).toEqual(["S-9", "s-2"]);
    expect(selectScenarios(SCENARIOS, ",").scenarios).toEqual([]);
  });
});
