import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { AppDataContext, type AppData, type ContractState, type HeartbeatState } from "./data";
import {
  fetchConfig,
  fetchContractState,
  fetchHeartbeat,
  HEARTBEAT_POLL_MS,
  type BaseConfig,
} from "./live";

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; config: BaseConfig };

/**
 * Runs `check` now and every `HEARTBEAT_POLL_MS`, handing each answer to `apply`. A tick is
 * skipped while the previous check is still pending (each request times out after 10 s), so
 * checks never stack and an older answer never overwrites a newer one. Returns the cleanup.
 */
function poll<T>(check: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void) {
  const abort = new AbortController();
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void check(abort.signal).then((value) => {
      inFlight = false;
      if (!abort.signal.aborted) apply(value);
    });
  };
  tick();
  const timer = setInterval(tick, HEARTBEAT_POLL_MS);
  return () => {
    clearInterval(timer);
    abort.abort();
  };
}

// The production data provider. Reads `/config.json` once, then checks the contract's lock
// state over NEAR RPC and the watcher heartbeat every 30 s for the system card. No
// Challenge round data exists yet (stories 7.1 and 7.2), so `challenge` is null.
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

  const data = useMemo<AppData | null>(
    () => (config ? { config: { ...config, contract, heartbeat }, challenge: null } : null),
    [config, contract, heartbeat],
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
