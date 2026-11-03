import { describe, expect, it } from "vitest";
import type { ChallengeData } from "@/app/data";
import type { TryControl } from "@/app/useChallengeFeed";
import { demoReducer, demoView, IDLE, LOG_ROWS, STEP_DELAYS, type DemoState } from "./demo";
import { illustrationChallenge } from "./illustration";

function run(state: DemoState, n: number, at = "04:20"): DemoState {
  let next = demoReducer(state, { type: "start", n });
  STEP_DELAYS.forEach((_, index) => {
    next = demoReducer(next, { type: "step", index });
  });
  return demoReducer(next, { type: "finish", at });
}

describe('"Try with these keys" simulation', () => {
  it("dims every step, then lights them in order: done, refused, ok, ok", () => {
    let state = demoReducer(IDLE, { type: "start", n: 14 });
    expect(state.steps).toEqual(["pending", "pending", "pending", "pending"]);
    expect(state.running).toBe(14);
    state = demoReducer(state, { type: "step", index: 0 });
    state = demoReducer(state, { type: "step", index: 1 });
    expect(state.steps).toEqual(["done", "refused", "pending", "pending"]);
    state = demoReducer(state, { type: "step", index: 2 });
    state = demoReducer(state, { type: "step", index: 3 });
    expect(state.steps).toEqual(["done", "refused", "ok", "ok"]);
  });

  it("runs one animation at a time", () => {
    const started = demoReducer(IDLE, { type: "start", n: 14 });
    expect(demoReducer(started, { type: "start", n: 15 })).toBe(started);
  });

  it("adds a fresh clawed-back row, announces it and keeps sats out at 0", () => {
    const state = run(IDLE, 14);
    expect(state.running).toBeNull();
    expect(state.added).toEqual([
      {
        n: 14,
        at: "04:20",
        action: "full withdrawal",
        outcome: { tone: "ok", text: "clawed back · 36 s" },
        fresh: true,
      },
    ]);
    // Announced as an illustration, never as a live outcome.
    expect(state.announcement).toBe("Illustration: attempt #14 clawed back · 0 sats out");
    const view = demoView(null, state);
    expect(view.data.attempts?.count).toBe(14);
    expect(view.data.attempts?.satsOut).toBe(0);
    expect(view.data.satsTaken).toBe(0);
  });

  it("adds one attempt per run, newest first, and keeps five rows", () => {
    let state = IDLE;
    for (let n = 14; n <= 20; n += 1) state = run(state, n);
    const view = demoView(null, state);
    expect(view.data.attempts?.count).toBe(13 + 7);
    expect(view.rows).toHaveLength(LOG_ROWS);
    expect(view.rows?.map((row) => row.n)).toEqual([20, 19, 18, 17, 16]);
    expect(view.rows?.filter((row) => row.fresh).map((row) => row.n)).toEqual([20]);
  });
});

describe("what the laptop shows", () => {
  it("without a round: the mockup illustration, marked as such", () => {
    const view = demoView(null, IDLE);
    expect(view.illustration).toBe(true);
    expect(view.data).toEqual(illustrationChallenge);
    expect(view.rows?.map((row) => row.n)).toEqual([13, 12, 11, 10, 9]);
    expect(view.steps.map((step) => step.state)).toEqual(["done", "refused", "ok", "ok"]);
  });

  it("with a live round: its values, the log waiting for the feed and X-Ray steps that wait", () => {
    const live: ChallengeData = {
      ...illustrationChallenge,
      round: 2,
      attempts: { ...illustrationChallenge.attempts!, count: 3, lastAt: "09:41" },
    };
    const view = demoView(live, IDLE);
    expect(view.illustration).toBe(false);
    expect(view.data.round).toBe(2);
    expect(view.data.attempts?.count).toBe(3);
    expect(view.rows).toBeNull();
    expect(view.steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("with a live round: the feed's newest five rows, without their explorer links", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      key: `2-${7 - i}`,
      n: 7 - i,
      at: "09:41",
      action: "Withdrawal Request",
      outcome: { tone: "ok" as const, text: "Clawed back in 41 s" },
      links: {
        near: { href: "https://testnet.nearblocks.io/txns/H", text: "NEAR", label: "x" },
        bitcoin: null,
      },
    }));
    const view = demoView({ ...illustrationChallenge, log: rows }, IDLE);
    expect(view.rows?.map((row) => row.n)).toEqual([7, 6, 5, 4, 3]);
    expect(view.rows?.every((row) => row.links === undefined)).toBe(true);
  });

  it("with a live round: simulated runs never touch live data", () => {
    const live: ChallengeData = {
      ...illustrationChallenge,
      round: 2,
      attempts: { ...illustrationChallenge.attempts!, count: 3, lastAt: "09:41" },
      log: [],
    };
    const after = demoView(live, run(run(IDLE, 4), 5));
    expect(after.data).toBe(live);
    expect(after.data.attempts?.count).toBe(3);
    expect(after.rows).toEqual([]);
    expect(after.steps.every((step) => step.state === "pending")).toBe(true);
    expect(after.announcement).toBe("");
  });

  it("with a live round: the X-Ray and the announcement follow the real attempt", () => {
    const steps = [
      { title: "Request", detail: "request_withdrawal · 9pAbCd…wxyz", state: "done" as const },
      {
        title: "Contract rule",
        detail: "Accepted · executable at 4 Nov 09:30",
        state: "done" as const,
      },
      { title: "MPC co-signature", detail: "x", state: "unreached" as const },
      { title: "Bitcoin", detail: "Waiting for the guardian · 3 s", state: "pending" as const },
    ];
    const attempt = {
      steps,
      busy: false,
      announcement: "Contract rule: Accepted · executable at 4 Nov 09:30",
    } as unknown as TryControl;
    const live: ChallengeData = { ...illustrationChallenge, round: 2, log: [] };
    const view = demoView(live, run(IDLE, 4), attempt);
    expect(view.illustration).toBe(false);
    expect(view.steps).toBe(steps);
    expect(view.running).toBe(false);
    expect(view.announcement).toBe("Contract rule: Accepted · executable at 4 Nov 09:30");
    expect(demoView(live, IDLE, { ...attempt, busy: true } as TryControl).running).toBe(true);
    // The illustration never takes the live attempt's steps.
    expect(demoView(null, IDLE, attempt).steps.map((step) => step.state)).toEqual([
      "done",
      "refused",
      "ok",
      "ok",
    ]);
  });
});
