import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  parseNearKey,
  randomP2wpkhAddress,
  type NearKey,
  type Outpoint,
} from "@morrow/core-ts/browser";
import {
  ATTEMPTS_POLL_MS,
  BITCOIN_POLL_MS,
  ROUND_POLL_MS,
  challengeData,
  coreBtcNetwork,
  entryKey,
  fetchAttempts,
  fetchCoSigner,
  fetchRound,
  fetchTipHeight,
  fetchVaultFacts,
  fetchVaultUtxos,
  neededVaults,
  sameRound,
  type AttemptsFeed,
  type CoSigner,
  type FeedEntry,
  type VaultFacts,
} from "./challenge";
import type { ChallengeData, ChallengeKeys, ChallengeStatus } from "./data";
import { poll, type BaseConfig } from "./live";
import {
  EMPTY_TRY,
  planCall,
  rpcOver,
  runCall,
  tryReducer,
  tryView,
  type TryAction,
  type TryInputs,
  type TryOutcome,
  type TryView,
} from "./try";

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
  /** What "Try with these keys" reads; null without a round. */
  feed: TryFeed | null;
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
  const [balance, setBalance] = useState<{
    address: string;
    sats: number;
    outpoints: Outpoint[];
  } | null>(null);
  /** Bumped to ask `/round` again at once (a spent key waits for a fresh one). */
  const [roundAsk, setRoundAsk] = useState(0);
  const refreshRound = useCallback(() => setRoundAsk((n) => n + 1), []);
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
    // `roundAsk` restarts the poll, which asks at once.
  }, [challengeUrl, roundAsk]);

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
        Promise.all([fetchVaultUtxos(btcUrl, address, signal), fetchTipHeight(btcUrl, signal)]),
      ([utxos, height]) => {
        if (utxos !== null) setBalance({ address, ...utxos });
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

  const tryFeed = useMemo<TryFeed | null>(() => {
    if (round === null) return null;
    const facts = round.vault_id === null ? undefined : vaults[round.vault_id];
    return {
      round,
      outpoints:
        balance !== null && balance.address === round.vault_address ? balance.outpoints : null,
      balanceSats:
        balance !== null && balance.address === round.vault_address ? balance.sats : null,
      watcherPk: facts === undefined ? undefined : facts.watcherPk,
      entries: feed?.attempts.entries ?? null,
      refreshRound,
    };
  }, [round, balance, vaults, feed, refreshRound]);

  return { challenge, status, feed: tryFeed };
}

/** The parts of the challenge feed "Try with these keys" needs. */
export interface TryFeed {
  round: ChallengeKeys;
  /** Confirmed coins at the round's Vault Address; null until the backend answers. */
  outpoints: readonly Outpoint[] | null;
  /** Every coin at the Vault Address, confirmed or not; null until the backend answers. */
  balanceSats: number | null;
  /** `undefined` until `get_vault` answers. */
  watcherPk: string | null | undefined;
  entries: readonly FeedEntry[] | null;
  /** Asks `/round` again at once. */
  refreshRound: () => void;
}

/** "Try with these keys" for the round on screen: the panel's view plus its two actions. */
export interface TryControl extends TryView {
  setDestination: (value: string) => void;
  /** Runs `action`; `random` sends the full-balance request to the address made here. */
  run: (action: TryAction, options?: { random?: boolean }) => void;
}

/** How often the X-Ray's Bitcoin step counts while it waits for the Clawback. */
const COUNTER_MS = 1_000;

/**
 * The in-memory try session for the round on screen: null without a round. The published
 * function-call key is parsed here and lives only in this hook's memory (never storage, never
 * logged); the session is replaced when `/round` serves a new round or key. While the key is
 * out of allowance, `/round` is asked again with every Attempt Log poll until a fresh key is
 * served.
 */
export function useTrySession(config: BaseConfig | null, feed: TryFeed | null): TryControl | null {
  const round = feed?.round ?? null;
  const secret = round?.near_function_call_key ?? null;
  const btc = config ? coreBtcNetwork(config.network.btc) : null;
  const key = useMemo<NearKey | null>(() => {
    if (secret === null) return null;
    try {
      return parseNearKey(secret);
    } catch {
      return null;
    }
  }, [secret]);
  // Identified by the public key: the secret never enters reducer state.
  const sessionId =
    round === null
      ? null
      : `${round.round}:${round.vault_id ?? ""}:${key?.publicKeyString ?? "unreadable"}`;

  const [state, dispatch] = useReducer(tryReducer, EMPTY_TRY);
  const [now, setNow] = useState(() => Date.now());

  // A new round or key replaces the session (and its spent flag, attempt and destination).
  useEffect(() => {
    if (sessionId === null || btc === null) return;
    dispatch({ type: "reset", sessionId, randomDestination: randomP2wpkhAddress(btc) });
  }, [sessionId, btc]);

  // Attempts in flight are cut short only when the page goes away.
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    return () => abort.abort();
  }, []);

  const inputs = useMemo<TryInputs | null>(() => {
    if (feed === null || config === null || btc === null) return null;
    return {
      keys: feed.round,
      contractId: config.contractId,
      key,
      btc,
      near: config.network.near,
      rpcUrl: config.nearRpcUrl,
      outpoints: feed.outpoints,
      balanceSats: feed.balanceSats,
      watcherPk: feed.watcherPk,
      entries: feed.entries,
    };
  }, [feed, config, btc, key]);

  const current = state.sessionId === sessionId ? state : null;
  const view = useMemo(
    () => (inputs === null || current === null ? null : tryView(current, inputs, now)),
    [inputs, current, now],
  );

  // The Bitcoin step counts seconds while it waits.
  const waiting = view?.waiting ?? false;
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), COUNTER_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  // A spent key: ask `/round` for the fresh one with every Attempt Log poll.
  const spent = current?.spent ?? false;
  const refreshRound = feed?.refreshRound;
  useEffect(() => {
    if (!spent || !refreshRound) return;
    const timer = setInterval(refreshRound, ATTEMPTS_POLL_MS);
    return () => clearInterval(timer);
  }, [spent, refreshRound]);

  const latest = useRef({ state: current, inputs });
  latest.current = { state: current, inputs };
  /** The session an attempt is in flight for: a replaced session is never blocked by it. */
  const busy = useRef<string | null>(null);
  const ids = useRef(0);

  const run = useCallback((action: TryAction, options?: { random?: boolean }) => {
    const { state: session, inputs: ins } = latest.current;
    const signal = lifetime.current?.signal;
    if (session === null || ins === null || ins.key === null || !signal) return;
    if (busy.current !== null && busy.current === session.sessionId) return;
    if (ins.rpcUrl === null) return;
    const destination = options?.random ? session.randomDestination : session.destination;
    const planned = planCall(action, destination, session, ins);
    if (!planned.ok) {
      if (planned.problem === "seal") dispatch({ type: "problem", problem: "seal" });
      else if (planned.problem !== "unavailable") {
        dispatch({ type: "refuse-destination", problem: planned.problem });
      }
      return;
    }
    const owner = session.sessionId;
    busy.current = owner;
    ids.current += 1;
    const id = ids.current;
    setNow(Date.now());
    dispatch({ type: "start", id, action, at: Date.now() });
    const rpc = rpcOver(ins.rpcUrl, signal);
    void runCall(rpc, ins.key, action, planned.plan, (hash) =>
      dispatch({ type: "signed", id, hash }),
    )
      // A throw is settled like a result that cannot be read: nothing is made up.
      .catch((): TryOutcome => ({ kind: "unreadable" }))
      .then((outcome) => {
        if (signal.aborted) return;
        setNow(Date.now());
        dispatch({ type: "settled", id, outcome });
      })
      .finally(() => {
        if (busy.current === owner) busy.current = null;
      });
  }, []);

  const setDestination = useCallback(
    (value: string) => dispatch({ type: "destination", value }),
    [],
  );

  return useMemo(
    () => (view === null ? null : { ...view, run, setDestination }),
    [view, run, setDestination],
  );
}
