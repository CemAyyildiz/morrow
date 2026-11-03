import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { AppDataContext, type AppData, type ContractState, type HeartbeatState } from "./data";
import { fetchConfig, fetchContractState, fetchHeartbeat, poll, type BaseConfig } from "./live";
import { useChallengeFeed } from "./useChallengeFeed";

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; config: BaseConfig };

// The production data provider. Reads `/config.json` once, then checks the contract's lock
// state over NEAR RPC and the watcher heartbeat every 30 s for the system card, and follows
// the challenge feed (`MORROW_CHALLENGE_URL`) for `challenge`: null without a feed or an open
// round.
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [contract, setContract] = useState<ContractState>("checking");
  const [heartbeat, setHeartbeat] = useState<HeartbeatState>({ kind: "checking" });

  useEffect(() => {
    const abort = new AbortController();
    fetchConfig(abort.signal).then((config) => {
      if (abort.signal.aborted) return;
      setLoad(config ? { kind: "ready", config } : { kind: "failed" });
    });
    return () => abort.abort();
  }, []);

  const config = load.kind === "ready" ? load.config : null;
  const rpcUrl = config?.nearRpcUrl ?? null;
  const contractId = config?.contractId ?? null;
  const watcherUrl = config?.watcherUrl ?? null;
  const ready = config !== null;

  useEffect(() => {
    if (contractId === null) return;
    // The mock contract without an RPC cannot be checked.
    if (rpcUrl === null) {
      setContract("unknown");
      return;
    }
    return poll((signal) => fetchContractState(rpcUrl, contractId, signal), setContract);
  }, [rpcUrl, contractId]);

  useEffect(() => {
    if (!ready) return;
    if (watcherUrl === null) {
      setHeartbeat({ kind: "none" });
      return;
    }
    return poll((signal) => fetchHeartbeat(watcherUrl, signal), setHeartbeat);
  }, [ready, watcherUrl]);

  const { challenge, status: challengeStatus } = useChallengeFeed(config);

  const data = useMemo<AppData | null>(
    () =>
      config ? { config: { ...config, contract, heartbeat }, challenge, challengeStatus } : null,
    [config, contract, heartbeat, challenge, challengeStatus],
  );

  if (load.kind === "failed") return <ConfigFailed />;
  if (data === null) return <LoadingShell />;
  return <AppDataContext.Provider value={data}>{children}</AppDataContext.Provider>;
}

/** Shown until `/config.json` arrives: the page background and a busy note for readers. */
function LoadingShell() {
  return (
    <div data-testid="loading-shell" aria-busy="true" className="min-h-dvh bg-page">
      <p className="sr-only">{copy.config.loading}</p>
    </div>
  );
}

function ConfigFailed() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-page p-gutter-mobile">
      <Card
        role="alert"
        data-testid="config-failed"
        className="flex max-w-[460px] flex-col gap-3 p-card-pad-mobile desktop:p-card-pad"
      >
        <CardTitle>{copy.config.failedTitle}</CardTitle>
        <CardDescription>{copy.config.failedBody}</CardDescription>
      </Card>
    </div>
  );
}
