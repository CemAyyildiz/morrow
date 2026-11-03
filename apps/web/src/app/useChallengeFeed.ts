import { useEffect, useMemo, useRef, useState } from "react";
import {
  ATTEMPTS_POLL_MS,
  BITCOIN_POLL_MS,
  ROUND_POLL_MS,
  challengeData,
  entryKey,
  fetchAttempts,
  fetchCoSigner,
  fetchRound,
  fetchTipHeight,
  fetchVaultFacts,
  fetchVaultSats,
  neededVaults,
  sameRound,
  type AttemptsFeed,
  type CoSigner,
  type VaultFacts,
} from "./challenge";
import type { ChallengeData, ChallengeKeys, ChallengeStatus } from "./data";
import { poll, type BaseConfig } from "./live";

/** How often the screen's clock moves (remaining time, the 24 h chart, today's times). */
const CLOCK_MS = 10_000;

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The challenge feed for `config`: null without `MORROW_CHALLENGE_URL` (no request goes to a
 * challenge origin) and until `GET /round` answers 200, and again once it answers 404. Then
 * `/round` every 30 s, `/attempts` every 10 s, the Vault's balance and the tip every 30 s,
 * `get_vault` once per vault id and the signer's threshold once. A failed poll keeps the last
 * answer; every poll is aborted on unmount.
 */
export function useChallengeFeed(config: BaseConfig | null): {
  challenge: ChallengeData | null;
  status: ChallengeStatus;
} {
  const challengeUrl = config?.challengeUrl ?? null;
  const btcUrl = config?.btcBackendUrl ?? null;
  const rpcUrl = config?.nearRpcUrl ?? null;
  const contractId = config?.contractId ?? null;
  const signerAccount = config?.coSigner ?? null;

  const [round, setRound] = useState<ChallengeKeys | null>(null);
  /** The last `/round` answer that was not a round: 404 or unreachable. */
  const [answer, setAnswer] = useState<"none" | "unreachable" | null>(null);
  const [feed, setFeed] = useState<{ attempts: AttemptsFeed; fresh: ReadonlySet<string> } | null>(
    null,
  );
  const [balance, setBalance] = useState<{ address: string; sats: number } | null>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [vaults, setVaults] = useState<Readonly<Record<string, VaultFacts>>>({});
  const [coSigner, setCoSigner] = useState<CoSigner | null | "unreadable">(null);
  const [now, setNow] = useState(() => Date.now());

  const hasRound = round !== null;
  const address = round?.vault_address ?? null;

  useEffect(() => {
    if (challengeUrl === null) return;
    return poll(
      (signal) => fetchRound(challengeUrl, signal),
      (answer) => {
        if (answer.kind === "round") {
          setRound((previous) => (sameRound(previous, answer.round) ? previous : answer.round));
          setAnswer(null);
        } else if (answer.kind === "none") {
          setRound(null);
          setAnswer("none");
        } else {
          // A round already shown stays; without one the feed reads as unreachable.
          setAnswer("unreachable");
        }
      },
      ROUND_POLL_MS,
    );
  }, [challengeUrl]);

  // Row keys seen in earlier answers: a key that was not is a new row (it flashes once).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (challengeUrl === null || !hasRound) return;
    return poll(
      (signal) => fetchAttempts(challengeUrl, signal),
      (attempts) => {
        // Feed down: the last answer stands, nothing is made up.
        if (attempts === null) return;
        const keys = attempts.entries.map(entryKey);
        const before = seen.current;
        const fresh = before === null ? NO_KEYS : new Set(keys.filter((key) => !before.has(key)));
        seen.current = new Set([...(before ?? []), ...keys]);
        setFeed({ attempts, fresh });
        setNow(Date.now());
      },
      ATTEMPTS_POLL_MS,
    );
  }, [challengeUrl, hasRound]);

  useEffect(() => {
    if (btcUrl === null || address === null) return;
    return poll(
      (signal) =>
        Promise.all([fetchVaultSats(btcUrl, address, signal), fetchTipHeight(btcUrl, signal)]),
      ([sats, height]) => {
        if (sats !== null) setBalance({ address, sats });
        if (height !== null) setTip(height);
      },
      BITCOIN_POLL_MS,
    );
  }, [btcUrl, address]);

  // Reads that outlive one effect run (get_vault) are aborted only on unmount.
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    return () => abort.abort();
  }, []);

  // get_vault once per vault id; a failed read is retried with the next `/attempts` answer.
  const requested = useRef(new Set<string>());
  const neededKey = neededVaults(round, feed?.attempts ?? null).join(",");
  useEffect(() => {
    const signal = lifetime.current?.signal;
    if (rpcUrl === null || contractId === null || neededKey === "" || !signal) return;
    for (const vaultId of neededKey.split(",")) {
      if (requested.current.has(vaultId)) continue;
      requested.current.add(vaultId);
      void fetchVaultFacts(rpcUrl, contractId, vaultId, signal).then((facts) => {
        // A failed or cut-short read is asked again on a later run.
        if (facts === null || signal.aborted) requested.current.delete(vaultId);
        else setVaults((all) => ({ ...all, [vaultId]: facts }));
      });
    }
    // `feed` re-runs the effect so that a failed read is retried.
  }, [rpcUrl, contractId, neededKey, feed]);

  useEffect(() => {
    if (!hasRound || signerAccount === null) return;
    if (rpcUrl === null) {
      setCoSigner("unreadable");
      return;
    }
    const abort = new AbortController();
    void fetchCoSigner(rpcUrl, signerAccount, abort.signal).then((value) => {
      if (!abort.signal.aborted) setCoSigner(value ?? "unreadable");
    });
    return () => abort.abort();
  }, [hasRound, rpcUrl, signerAccount]);

  useEffect(() => {
    if (!hasRound) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [hasRound]);

  const network = config?.network ?? null;
  const bountyUrl = config?.bountyUrl ?? null;
  const status: ChallengeStatus =
    challengeUrl === null ? "none" : round !== null ? "round" : (answer ?? "loading");
  const challenge = useMemo(() => {
    if (round === null || network === null) return null;
    return challengeData(
      {
        round,
        attempts: feed?.attempts ?? null,
        fresh: feed?.fresh ?? NO_KEYS,
        balanceSats:
          balance !== null && balance.address === round.vault_address ? balance.sats : null,
        tip,
        vaults,
        coSigner,
      },
      { network, bountyUrl },
      now,
    );
  }, [round, feed, balance, tip, vaults, coSigner, network, bountyUrl, now]);
  return { challenge, status };
}
