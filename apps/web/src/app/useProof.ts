import { useCallback, useEffect, useRef, useState } from "react";
import { poll } from "./live";
import { PROOF_POLL_MS, proofRpc, readProof, type ProofAnswer, type ProofFacts } from "./proof";

/** Where the Proof Page of one Vault stands. */
export type ProofState =
  /** No NEAR RPC is configured: nothing can be read. */
  | { kind: "no-rpc" }
  /** The first read has not answered. */
  | { kind: "loading" }
  /** `stale` once a later read failed: the last answer stays on screen. */
  | { kind: "ok"; facts: ProofFacts; now: number; stale: boolean }
  /** `get_vault` failed in the contract. */
  | { kind: "missing"; code: string | null }
  /** The RPC did not answer before any read succeeded. */
  | { kind: "unreachable" };

export type Held = { vaultId: string; state: ProofState };

/**
 * The state after `answer` for `vaultId`. A failed read keeps the last answer of the same
 * Vault, marked stale; without one the page says the RPC is unreachable. Pure.
 */
export function heldAfter(
  previous: Held | null,
  vaultId: string,
  answer: ProofAnswer,
  now: number,
): Held {
  if (answer.kind === "ok") {
    return { vaultId, state: { kind: "ok", facts: answer.facts, now, stale: false } };
  }
  if (answer.kind === "missing") return { vaultId, state: { kind: "missing", code: answer.code } };
  const last = previous?.vaultId === vaultId ? previous.state : null;
  if (last?.kind === "ok") return { vaultId, state: { ...last, stale: true } };
  return { vaultId, state: { kind: "unreachable" } };
}

/**
 * Reads the Proof Page of `vaultId` over `rpcUrl` now and every 30 s, with no cache beyond
 * this page's memory. A failed read keeps the last answer and marks it stale; `retry` asks
 * again at once. Every read is aborted on unmount or when the Vault changes.
 */
export function useProof(
  rpcUrl: string | null,
  contractId: string,
  vaultId: string,
): { state: ProofState; retry: () => void } {
  const [held, setHeld] = useState<Held | null>(null);
  const [ask, setAsk] = useState(0);
  const retry = useCallback(() => setAsk((n) => n + 1), []);
  // The scan's first cursor per Vault: the binary search runs once per page visit.
  const starts = useRef(new Map<string, bigint>());

  useEffect(() => {
    if (rpcUrl === null) return;
    return poll(
      (signal) =>
        readProof(proofRpc(rpcUrl, contractId, signal), contractId, vaultId, starts.current),
      (answer) => setHeld((previous) => heldAfter(previous, vaultId, answer, Date.now())),
      PROOF_POLL_MS,
    );
    // `ask` restarts the poll, which reads at once.
  }, [rpcUrl, contractId, vaultId, ask]);

  if (rpcUrl === null) return { state: { kind: "no-rpc" }, retry };
  // Another Vault's answer is never shown for this one.
  const state = held?.vaultId === vaultId ? held.state : { kind: "loading" as const };
  return { state, retry };
}
