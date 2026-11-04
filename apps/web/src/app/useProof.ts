import { useCallback, useEffect, useRef, useState } from "react";
import { poll } from "./live";
import {
  PROOF_POLL_MS,
  proofRpc,
  readProof,
  type ProofAnswer,
  type ProofFacts,
  type ScanHolder,
} from "./proof";

/** Why the data on screen is not from the latest read. */
export type StaleReason = "unreachable" | "missing" | "misconfigured";

/** Where the Proof Page of one Vault stands. */
export type ProofState =
  /** No NEAR RPC is configured: nothing can be read. */
  | { kind: "no-rpc" }
  /** The first read has not answered. */
  | { kind: "loading" }
  /**
   * The last read that answered, at `readAt`; `now` is the latest answer's time, which every
   * time on screen is formatted against. `stale` once a later read failed: the data stays.
   */
  | { kind: "ok"; facts: ProofFacts; readAt: number; now: number; stale: StaleReason | null }
  /** `get_vault` failed with `ERR_VAULT_NOT_FOUND`. */
  | { kind: "missing"; code: string }
  /** The contract account did not answer as a Vault Contract. */
  | { kind: "misconfigured" }
  /** The RPC did not answer before any read succeeded. */
  | { kind: "unreachable" };

export type Held = { vaultId: string; state: ProofState };

/**
 * The state after `answer` for `vaultId` at `now`. After a first read, any failed one keeps
 * the last data of the same Vault, marked stale with its reason; without data the page says
 * what failed. Pure.
 */
export function heldAfter(
  previous: Held | null,
  vaultId: string,
  answer: ProofAnswer,
  now: number,
): Held {
  if (answer.kind === "ok") {
    return {
      vaultId,
      state: { kind: "ok", facts: answer.facts, readAt: now, now, stale: null },
    };
  }
  const last = previous?.vaultId === vaultId ? previous.state : null;
  if (last?.kind === "ok") return { vaultId, state: { ...last, now, stale: answer.kind } };
  if (answer.kind === "missing") return { vaultId, state: { kind: "missing", code: answer.code } };
  return { vaultId, state: { kind: answer.kind } };
}

/**
 * Reads the Proof Page of `vaultId` over `rpcUrl` now and every 30 s, with no cache beyond
 * this page's memory. The history scan is kept between refreshes and read on from its
 * cursor; it starts over when the Vault changes. `retry` asks again at once. Every read is
 * aborted on unmount or when the Vault changes.
 */
export function useProof(
  rpcUrl: string | null,
  contractId: string,
  vaultId: string,
): { state: ProofState; retry: () => void } {
  const [held, setHeld] = useState<Held | null>(null);
  const [ask, setAsk] = useState(0);
  const retry = useCallback(() => setAsk((n) => n + 1), []);
  const scan = useRef<ScanHolder>({ current: null });

  useEffect(() => {
    if (rpcUrl === null) return;
    // Another Vault starts its own scan.
    if (scan.current.current?.vaultId !== vaultId) scan.current = { current: null };
    const holder = scan.current;
    return poll(
      (signal) => readProof(proofRpc(rpcUrl, contractId, signal), contractId, vaultId, holder),
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
