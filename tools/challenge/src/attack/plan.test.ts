import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  LIVE_METHODS,
  allCategories,
  buildPlan,
  liveCategories,
  notDeployed,
  notDeployedNote,
  roundBudgets,
  seededRandom,
  type Category,
} from "./plan.js";

const live = liveCategories();
const all = allCategories();

describe("roundBudgets", () => {
  it("splits n across rounds, remainder to the first rounds", () => {
    expect(roundBudgets(100, 3)).toEqual([34, 33, 33]);
    expect(roundBudgets(12, 1)).toEqual([12]);
    expect(roundBudgets(2, 3)).toEqual([1, 1]); // empty rounds dropped
  });
  it("rejects non-positive input", () => {
    expect(() => roundBudgets(0, 3)).toThrow();
    expect(() => roundBudgets(10, 0)).toThrow();
  });
});

describe("seededRandom", () => {
  it("is deterministic for a seed", () => {
    const a = Array.from({ length: 5 }, seededRandom(7));
    const b = Array.from({ length: 5 }, seededRandom(7));
    expect(a).toEqual(b);
    expect(Array.from({ length: 5 }, seededRandom(8))).not.toEqual(a);
  });
});

describe("buildPlan", () => {
  it("gives the same plan for the same seed", () => {
    const opts = { seed: 7, n: 100, rounds: 3, categories: all };
    expect(buildPlan(opts)).toEqual(buildPlan(opts));
  });

  it("differs for a different seed (the fill draw changes)", () => {
    const a = buildPlan({ seed: 7, n: 100, rounds: 3, categories: all });
    const b = buildPlan({ seed: 8, n: 100, rounds: 3, categories: all });
    expect(a.flatMap((r) => r.fill.map((f) => f.move))).not.toEqual(
      b.flatMap((r) => r.fill.map((f) => f.move)),
    );
  });

  it("respects the budget: scripted ≤ budget and fill length = budget", () => {
    for (const round of buildPlan({ seed: 1, n: 12, rounds: 1, categories: all })) {
      expect(round.scripted.length).toBeLessThanOrEqual(round.budget);
      expect(round.fill.length).toBe(round.budget);
    }
  });

  it("the live plan names no undeployed category", () => {
    const undeployedMethods = new Set(
      notDeployed(live)
        .map((c) => CATEGORIES[c].method)
        .filter((m): m is string => m !== null),
    );
    const plan = buildPlan({ seed: 3, n: 100, rounds: 3, categories: live });
    const used = new Set<Category>();
    for (const round of plan) {
      for (const a of [...round.scripted, ...round.fill]) used.add(a.category);
    }
    for (const c of used) {
      const method = CATEGORIES[c].method;
      if (method !== null) expect(LIVE_METHODS).toContain(method);
    }
    expect(undeployedMethods).not.toContain("refresh");
    expect(used.has("refresh")).toBe(true);
  });

  it("the dry-run plan covers all five Attempt Log action categories", () => {
    const plan = buildPlan({ seed: 7, n: 100, rounds: 3, categories: all });
    const used = new Set<Category>();
    for (const round of plan) {
      for (const a of [...round.scripted, ...round.fill]) used.add(a.category);
    }
    for (const c of [
      "withdrawal_request",
      "spend_allowance",
      "refresh",
      "policy_change",
      "early_execute",
    ] as const) {
      expect(used.has(c)).toBe(true);
    }
  });
});

describe("CATEGORIES", () => {
  it("names the story that deploys each Epic 4/5 method", () => {
    expect(CATEGORIES.refresh.story).toBe("4.1");
    expect(CATEGORIES.spend_allowance.story).toBe("5.2");
    expect(CATEGORIES.policy_change.story).toBe("5.1");
    expect(CATEGORIES.fast_approval.story).toBe("8.4");
  });
});

describe("notDeployed", () => {
  it("is empty for the live mix: every category is deployed", () => {
    expect(LIVE_METHODS).toContain("refresh");
    expect(LIVE_METHODS).toContain("propose_policy_change");
    expect(LIVE_METHODS).toContain("spend_allowance");
    expect(LIVE_METHODS).toContain("fast_approve");
    expect(notDeployed(live)).toEqual([]);
    expect(notDeployed(all)).toEqual([]);
  });
  it("writes a plain-words note naming the methods and stories", () => {
    const missing = liveCategories(LIVE_METHODS.filter((m) => m !== "spend_allowance"));
    const note = notDeployedNote(missing);
    expect(note).toContain("Allowance spend (spend_allowance, Story 5.2)");
    expect(note).not.toContain("propose_policy_change");
    expect(note).not.toContain("refresh");
    expect(notDeployedNote(live)).toBeNull();
    expect(notDeployedNote(all)).toBeNull();
  });
});
