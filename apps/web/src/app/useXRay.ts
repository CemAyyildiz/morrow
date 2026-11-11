import { useCallback, useEffect, useRef, useState } from "react";
import type { XRay } from "@morrow/core-ts/browser";
import { fetchXRay, pollDelay, type XRayAnswer, type XRayEndpoints, type XRayTarget } from "./xray";

/** Where the X-Ray of one op or refused call stands. */
export type XRayState =
  /** The mock contract: there is no chain to read. */
  | { kind: "no-network" }
  /** The first read has not answered. */
  | { kind: "loading" }
  /**
   * The last read that answered, at `readAt`; `now` is the latest answer's time, which every
   * time on screen is formatted against. `stale` once a later read failed: the data stays.
   */
  | { kind: "ok"; xray: XRay; readAt: number; now: number; stale: boolean }
  /** The input names nothing to X-Ray (`XRayInputError`): its message. */
  | { kind: "input"; message: string }
  /** No read answered. */
  | { kind: "unreachable" };

export type HeldXRay = { key: string; state: XRayState };

/**
 * The state after `answer` for `key` at `now`. A failed read after a good one keeps the last
 * data of the same target, marked stale; without data the page says what failed. Pure.
 */
export function heldAfter(
  previous: HeldXRay | null,
  key: string,
  answer: XRayAnswer,
  now: number,
): HeldXRay {
  if (answer.kind === "ok") {
    return { key, state: { kind: "ok", xray: answer.xray, readAt: now, now, stale: false } };
  }
  const last = previous?.key === key ? previous.state : null;
  if (last?.kind === "ok") return { key, state: { ...last, now, stale: true } };
  if (answer.kind === "input") return { key, state: { kind: "input", message: answer.message } };
  return { key, state: { kind: "unreachable" } };
}

/** The key one target's reads are held under: another deployment or target starts over. */
export const xrayKey = (endpoints: XRayEndpoints | null, target: XRayTarget) =>
  JSON.stringify([endpoints, target]);

/**
 * Reads the X-Ray of `target` now, then again after `pollDelay`: every 10 s while a stage is
 * waiting, every 60 s while only the op is still open, and stops once nothing can change.
 * Nothing is cached beyond this page's memory. A failed read keeps the last data, marked stale,
 * and the re-reads go on at that data's delay. `retry` reads again at once. Every read is aborted on unmount or when the target changes.
 */
export function useXRay(
  endpoints: XRayEndpoints | null,
  target: XRayTarget,
): { state: XRayState; retry: () => void } {
  const [held, setHeld] = useState<HeldXRay | null>(null);
  const [ask, setAsk] = useState(0);
  const retry = useCallback(() => setAsk((n) => n + 1), []);
  const key = xrayKey(endpoints, target);
  // The values behind `key`, read when it changes.
  const latest = useRef({ endpoints, target });
  latest.current = { endpoints, target };
  // When the data held for `key` is read again (null: it cannot change). A failed read keeps
  // re-reading at the last good read's delay.
  const delay = useRef<{ key: string; ms: number | null }>({ key, ms: null });

  useEffect(() => {
    const { endpoints: at, target: what } = latest.current;
    if (at === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const answer = await fetchXRay(at, what, abort.signal);
      if (abort.signal.aborted) return;
      if (answer.kind === "ok") delay.current = { key, ms: pollDelay(answer.xray) };
      setHeld((previous) => heldAfter(previous, key, answer, Date.now()));
      const ms = delay.current.key === key ? delay.current.ms : null;
      if (ms !== null) timer = setTimeout(() => void read(), ms);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
    // `ask` reads again at once.
  }, [key, ask]);

  if (endpoints === null) return { state: { kind: "no-network" }, retry };
  // Another target's answer is never shown for this one.
  const state = held?.key === key ? held.state : { kind: "loading" as const };
  return { state, retry };
}
