// "Try with these keys" on the landing while no round is live: the mockup's simulated attempt
// over the illustration. The X-Ray lights its four steps one by one, then the attempt log
// gains a row and the outcome is announced as an illustration. Attempts go up by one per run;
// sats out never moves. With a live round nothing is simulated: the landing sends the visitor
// to the real Challenge screen, and live data is shown untouched.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AttemptRow, ChallengeData } from "@/app/data";
import type { XRayState, XRayStep } from "@/components/XRaySteps";
import { landingCopy } from "./copy";
import { illustrationChallenge, illustrationLog, xrayScript } from "./illustration";

/** The state each step ends in for a clawed-back attempt. */
export const STEP_RESULTS: readonly XRayState[] = ["done", "refused", "ok", "ok"];
/** Wait before each step lights, in ms, from the mockup script. */
export const STEP_DELAYS: readonly number[] = [250, 800, 900, 800];
/** Rows the log keeps. */
export const LOG_ROWS = 5;

export interface DemoState {
  /** Runs started on this page. */
  runs: number;
  /** null until the first run: the base picture's steps show. */
  steps: readonly XRayState[] | null;
  /** Rows added by runs, newest first. */
  added: readonly AttemptRow[];
  /** The attempt number of the run in progress, or null when idle. */
  running: number | null;
  announcement: string;
}

export type DemoEvent =
  { type: "start"; n: number } | { type: "step"; index: number } | { type: "finish"; at: string };

export const IDLE: DemoState = { runs: 0, steps: null, added: [], running: null, announcement: "" };

export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  switch (event.type) {
    case "start":
      // One animation at a time.
      if (state.running !== null) return state;
      return {
        ...state,
        runs: state.runs + 1,
        steps: STEP_RESULTS.map(() => "pending"),
        running: event.n,
      };
    case "step": {
      if (state.running === null || state.steps === null) return state;
      const steps = [...state.steps];
      steps[event.index] = STEP_RESULTS[event.index] ?? "done";
      return { ...state, steps };
    }
    case "finish": {
      if (state.running === null) return state;
      const n = state.running;
      const row: AttemptRow = {
        n,
        at: event.at,
        action: landingCopy.attempt.action,
        outcome: { tone: "ok", text: landingCopy.attempt.outcome },
        fresh: true,
      };
      const older = state.added.map((r) => ({ ...r, fresh: false }));
      return {
        ...state,
        added: [row, ...older].slice(0, LOG_ROWS),
        running: null,
        announcement: landingCopy.attempt.announce(n),
      };
    }
  }
}

export interface DemoView {
  /** The round the laptop shows, with the attempts count of this page's runs added. */
  data: ChallengeData;
  /** True when `data` is the mockup illustration, not a live round. */
  illustration: boolean;
  /** Null while the live feed has not answered: the log shows skeleton lines. */
  rows: readonly AttemptRow[] | null;
  steps: readonly XRayStep[];
  running: boolean;
  announcement: string;
}

function withoutLinks(row: AttemptRow): AttemptRow {
  const copy = { ...row };
  delete copy.links;
  return copy;
}

/**
 * What the laptop shows. A live round (`challenge` non-null) is shown as it is: simulated runs
 * never touch it, the log shows the newest rows of the feed (without their explorer links: the
 * laptop copy keeps the mockup's row height) and the X-Ray steps wait (story 7.2b). Without
 * one, the illustration plus the runs in `state`.
 */
export function demoView(challenge: ChallengeData | null, state: DemoState): DemoView {
  if (challenge !== null) {
    return {
      data: challenge,
      illustration: false,
      rows: challenge.log === null ? null : challenge.log.slice(0, LOG_ROWS).map(withoutLinks),
      steps: xrayScript.map((step) => ({ ...step, state: "pending" })),
      running: false,
      announcement: "",
    };
  }
  const base = illustrationChallenge;
  const states = state.steps ?? STEP_RESULTS;
  return {
    data: {
      ...base,
      attempts: base.attempts && {
        ...base.attempts,
        count: base.attempts.count + state.runs,
      },
    },
    illustration: true,
    rows: [...state.added, ...illustrationLog].slice(0, LOG_ROWS),
    steps: xrayScript.map((step, index) => ({ ...step, state: states[index] ?? "pending" })),
    running: state.running !== null,
    announcement: state.announcement,
  };
}

/** `HH:MM` local time, as the mockup stamps a new row. */
function clock(): string {
  return new Date().toTimeString().slice(0, 5);
}

export function useAttemptDemo(challenge: ChallengeData | null) {
  const [state, dispatch] = useReducer(demoReducer, IDLE);
  const view = demoView(challenge, state);
  const timers = useRef<number[]>([]);
  const running = useRef(false);
  const count = useRef(view.data.attempts?.count ?? 0);
  count.current = view.data.attempts?.count ?? 0;

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const illustration = view.illustration;
  const run = useCallback(() => {
    // Live data is never simulated on (the landing routes "Try" to /challenge instead).
    if (!illustration || running.current) return;
    running.current = true;
    dispatch({ type: "start", n: count.current + 1 });
    let at = 0;
    STEP_DELAYS.forEach((delay, index) => {
      at += delay;
      timers.current.push(window.setTimeout(() => dispatch({ type: "step", index }), at));
    });
    timers.current.push(
      window.setTimeout(() => {
        dispatch({ type: "finish", at: clock() });
        running.current = false;
        timers.current = [];
      }, at),
    );
  }, [illustration]);

  return { ...view, run };
}
