import { useCallback, useEffect, useId, useState, type ChangeEvent } from "react";
import { bitcoinTxUrl, type SpendOp, type Vault } from "@morrow/core-ts/browser";
import {
  absoluteTime,
  fetchTipHeight,
  fetchVaultUtxos,
  formatBtc,
  formatDuration,
  nsToMs,
  type VaultUtxos,
} from "@/app/challenge";
import { useAppData } from "@/app/data";
import { poll } from "@/app/live";
import { Link } from "@/app/router";
import { proofPath } from "@/app/routes";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";
import {
  actionGate,
  asSpendOp,
  asVault,
  broadcastTx,
  maxWithdrawal,
  planWithdrawal,
  runClawback,
  runExecute,
  runRequest,
  spendableCoins,
  type ActionDeps,
  type ActionResult,
  type ActionStep,
  type VaultAction,
} from "./actions";
import {
  downloadText,
  handedOffKeys,
  keyFileName,
  keyFileText,
  keyMismatch,
  parseKeyFile,
  type LoadedKeys,
} from "./keys";
import { callContract, viewContract } from "./near";
import {
  OutcomeLine,
  Section,
  WalletCard,
  body,
  inputClass,
  linkClass,
  refusalText,
  softDisabled,
  type Outcome,
} from "./ui";
import { useWallet } from "./useWallet";
import { WalletPageProblem, walletPageProblem } from "./WalletPageProblem";

const t = copy.vault.page;
const FAUCET_URL = "https://signetfaucet.com";
const COINS_POLL_MS = 30_000;
const CLOCK_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type VaultRead =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "refused"; code: string | null }
  | { kind: "ok"; vault: Vault };

type CoinsRead =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "ok"; coins: VaultUtxos; tip: number | null };

type Action = VaultAction;

/** Where the page remembers this viewer's last Withdrawal Request op id: a convenience only. */
const opKey = (vaultId: string) => `morrow:vault:${vaultId}:request-op`;

function rememberedOp(vaultId: string): string | null {
  try {
    const value = localStorage.getItem(opKey(vaultId));
    return value !== null && /^\d{1,20}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberOp(vaultId: string, opId: string): void {
  try {
    localStorage.setItem(opKey(vaultId), opId);
  } catch {
    // Storage blocked: the outcome line still names the op id.
  }
}

/** The text of an action's current step. */
function stepText(step: ActionStep): string {
  if (step.kind === "reading") return t.steps.reading;
  if (step.kind === "broadcasting") return t.steps.broadcasting;
  if (step.method === "sign_input" && step.input !== undefined && step.inputs !== undefined) {
    return t.steps.signInput(String(step.input + 1), String(step.inputs));
  }
  return t.steps.wallet(step.method);
}

/** The outcome line of a finished action. */
function resultOutcome(result: ActionResult, now: number): Outcome {
  switch (result.kind) {
    case "requested": {
      const at = result.op?.executable_at ?? null;
      return {
        tone: "ok",
        text:
          at === null
            ? t.outcome.requestedNoTime(result.opId)
            : t.outcome.requested(result.opId, absoluteTime(nsToMs(at), now)),
      };
    }
    case "broadcast": {
      const href = bitcoinTxUrl("signet", result.txid);
      return {
        tone: "ok",
        text: t.outcome.broadcast(result.txid),
        ...(href === null ? {} : { link: { href, text: t.outcome.viewTx } }),
      };
    }
    case "refused":
      return { tone: "alarm", text: refusalText(result.code, result.message) };
    case "rejected":
      return { tone: "alarm", text: t.outcome.rejected(result.message) };
    case "unreadable":
      return { tone: "alarm", text: t.outcome.unreadable };
    case "broadcast-failed":
      return {
        tone: "alarm",
        text:
          result.message === null
            ? t.outcome.broadcastUnreachable
            : t.outcome.broadcastFailed(result.message),
      };
  }
}

// `/vault/<vault_id>` (story 1.11b): the Vault read live from NEAR and its coins from the
// Bitcoin backend, the connected wallet, the key file (memory only), and the three actions:
// request a withdrawal, execute it after the Delay, and claw back. Every action says why it is
// disabled; every outcome is shown and announced.
export function VaultView({ vaultId }: { vaultId: string }) {
  const { config } = useAppData();
  const wallet = useWallet();
  const id = useId();
  const rpcUrl = config.nearRpcUrl;
  const backendUrl = config.btcBackendUrl;
  const contractId = config.contractId;

  const [read, setRead] = useState<VaultRead>({ kind: "loading" });
  const [readTick, setReadTick] = useState(0);
  const [coins, setCoins] = useState<CoinsRead>({ kind: "loading" });
  const [coinsTick, setCoinsTick] = useState(0);
  const [keys, setKeys] = useState<LoadedKeys | null>(() => handedOffKeys(vaultId));
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [op, setOp] = useState<SpendOp | null>(null);
  const [opInput, setOpInput] = useState(() => rememberedOp(vaultId) ?? "");
  /** A Clawback this page started that has not reached Bitcoin: resumed on the next press. */
  const [pendingClawback, setPendingClawback] = useState<{
    opId: string;
    hex: string | null;
  } | null>(null);
  const [opProblem, setOpProblem] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [running, setRunning] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  // The Vault, from NEAR.
  useEffect(() => {
    if (rpcUrl === null) return;
    const abort = new AbortController();
    setRead((current) => (current.kind === "ok" ? current : { kind: "loading" }));
    void viewContract(rpcUrl, contractId, "get_vault", { vault_id: vaultId }, abort.signal).then(
      (answer) => {
        if (abort.signal.aborted) return;
        if (answer.kind === "unreachable") return setRead({ kind: "unreachable" });
        if (answer.kind === "error") return setRead({ kind: "refused", code: answer.code });
        const vault = asVault(answer.value);
        setRead(vault === null ? { kind: "unreachable" } : { kind: "ok", vault });
      },
    );
    return () => abort.abort();
  }, [rpcUrl, contractId, vaultId, readTick]);

  const vault = read.kind === "ok" ? read.vault : null;
  const address = vault?.addresses?.vault ?? null;

  // Its coins and the tip, from the Bitcoin backend, every 30 s.
  useEffect(() => {
    if (address === null) return;
    setCoins({ kind: "loading" });
    return poll(
      async (signal) => {
        const [utxos, tip] = await Promise.all([
          fetchVaultUtxos(backendUrl, address, signal),
          fetchTipHeight(backendUrl, signal),
        ]);
        return utxos === null ? null : { coins: utxos, tip };
      },
      (value) => setCoins(value === null ? { kind: "unreachable" } : { kind: "ok", ...value }),
      COINS_POLL_MS,
    );
  }, [address, backendUrl, coinsTick]);

  // The open request, read again from NEAR: on load (the op id this viewer last requested) and
  // after every broadcast.
  const [opTick, setOpTick] = useState(0);
  const opToRead = op?.op_id ?? (opTick === 0 ? rememberedOp(vaultId) : null);
  const vaultReadId = vault?.vault_id ?? null;
  useEffect(() => {
    if (rpcUrl === null || vaultReadId === null || opToRead === null) return;
    const abort = new AbortController();
    void viewContract(rpcUrl, contractId, "get_op", { op_id: opToRead }, abort.signal).then(
      (answer) => {
        if (abort.signal.aborted || answer.kind !== "ok") return;
        const read = asSpendOp(answer.value);
        if (read !== null && read.vault_id === vaultReadId && read.kind === "withdrawal") {
          setOp(read);
        }
      },
    );
    return () => abort.abort();
    // `opToRead` is read when the tick or the Vault changes, not on every new op state.
  }, [rpcUrl, contractId, vaultReadId, opTick]);

  // Keys handed over by the wizard, or loaded earlier, must still match the Vault read now.
  const mismatch =
    keys !== null && vault !== null
      ? keyMismatch(keys, { nearNetwork: config.network.near, contractId }, vault)
      : null;
  const usableKeys = mismatch === null ? keys : null;

  const loadKeys = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (file === undefined || vault === null) return;
      const parsed = parseKeyFile(await file.text());
      if (!parsed.ok) {
        setKeys(null);
        return setKeyProblem(t.keyProblem[parsed.problem]);
      }
      const wrong = keyMismatch(
        parsed.keys,
        { nearNetwork: config.network.near, contractId },
        vault,
      );
      if (wrong !== null) {
        setKeys(null);
        return setKeyProblem(t.keyProblem[wrong]);
      }
      setKeyProblem(null);
      setKeys(parsed.keys);
    },
    [vault, config.network.near, contractId],
  );

  const problem = walletPageProblem(config, wallet.nonce);
  if (problem !== null || rpcUrl === null) {
    return (
      <>
        <PageHeader title={t.title(vaultId)} />
        <WalletPageProblem problem={problem ?? "network"} />
      </>
    );
  }

  if (read.kind !== "ok" || vault === null) {
    return (
      <>
        <PageHeader title={t.title(vaultId)} />
        <Card
          data-testid="vault-read"
          data-state={read.kind}
          className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
        >
          <CardTitle>
            {read.kind === "loading"
              ? t.loading
              : read.kind === "refused" && read.code !== null
                ? refusalText(read.code, read.code)
                : t.unreachable}
          </CardTitle>
          {read.kind !== "loading" && (
            <>
              <CardDescription>{t.unreachableBody}</CardDescription>
              <Button variant="secondary" onClick={() => setReadTick((n) => n + 1)}>
                {t.retry}
              </Button>
            </>
          )}
        </Card>
      </>
    );
  }

  if (vault.policy.btc_network !== "signet") {
    return (
      <>
        <PageHeader title={t.title(vaultId)} />
        <Card data-testid="vault-not-signet" className="p-card-pad-mobile desktop:p-card-pad">
          <CardDescription>{t.notSignet}</CardDescription>
        </Card>
      </>
    );
  }

  const connected = wallet.status.kind === "connected" ? wallet.status.connected : null;
  const account = connected?.accountId ?? null;
  const confirmed = coins.kind === "ok" ? coins.coins.outpoints : [];
  const totalSats = coins.kind === "ok" ? coins.coins.sats : 0;
  const confirmedSats = confirmed.reduce((sum, o) => sum + Number(o.value_sats), 0);
  const max = maxWithdrawal(spendableCoins(confirmed));

  /** Why an action is disabled, or null when it can run. */
  const gate = (action: Action): string | null =>
    actionGate(action, {
      running,
      account,
      vault,
      keysLoaded: usableKeys !== null,
      op,
      coins: coins.kind === "ok" ? confirmed : coins.kind,
      nowMs: now,
    });

  const deps: ActionDeps = {
    call: (method, args) => {
      if (connected === null) return Promise.resolve({ kind: "rejected", message: "no wallet" });
      return callContract(connected.wallet, contractId, method, args);
    },
    view: (method, args) =>
      viewContract(rpcUrl, contractId, method, args, new AbortController().signal),
    broadcast: (hex) => broadcastTx(backendUrl, hex, new AbortController().signal),
    sleep,
  };

  const run = async (action: Action, start: () => Promise<ActionResult>) => {
    setRunning(action);
    let result: ActionResult;
    try {
      result = await start();
    } catch (error) {
      // Nothing an action throws may leave the page stuck: say so, and free the buttons.
      const message = error instanceof Error ? error.message : String(error);
      setOutcome({ tone: "alarm", text: t.outcome.failed(message) });
      return;
    } finally {
      setRunning(null);
    }
    setOutcome(resultOutcome(result, Date.now()));
    if (result.kind === "requested") {
      rememberOp(vault.vault_id, result.opId);
      setOpInput(result.opId);
      setOp(result.op);
    }
    if (action === "clawback") {
      if (result.kind === "broadcast") setPendingClawback(null);
      else if (result.kind === "broadcast-failed") {
        setPendingClawback({ opId: result.opId, hex: result.hex });
      } else if ("opId" in result && result.opId !== undefined) {
        setPendingClawback({ opId: result.opId, hex: null });
      }
    }
    if (result.kind === "broadcast") {
      setReadTick((n) => n + 1);
      setCoinsTick((n) => n + 1);
      setOpTick((n) => n + 1);
    }
  };
  const onStep = (step: ActionStep) => setOutcome({ tone: "neutral", text: stepText(step) });

  const requestPlan = planWithdrawal(vault, confirmed, destination, amount);
  const requestGate =
    gate("request") ??
    (requestPlan.ok
      ? null
      : requestPlan.problem.kind === "destination"
        ? copy.vault.create.addressProblem[requestPlan.problem.problem]
        : requestPlan.problem.kind === "funds"
          ? t.request.fundsProblem
          : requestPlan.problem.kind === "seal"
            ? t.request.sealProblem
            : t.request.amountProblem);
  const executeGate = gate("execute") ?? (op === null ? t.pending.none : null);
  const clawbackGate = gate("clawback");

  const request = () => {
    if (requestGate !== null || !requestPlan.ok) return;
    void run("request", () => runRequest(deps, requestPlan.args, onStep));
  };
  const execute = () => {
    if (executeGate !== null || op === null || usableKeys === null) return;
    void run("execute", () =>
      runExecute(deps, { vault, opId: op.op_id, ownerSecret: usableKeys.owner.secret }, onStep),
    );
  };
  const clawback = () => {
    if (clawbackGate !== null || usableKeys === null) return;
    void run("clawback", () =>
      runClawback(
        deps,
        {
          vault,
          outpoints: confirmed,
          guardianSecret: usableKeys.guardian.secret,
          resumeOpId: pendingClawback?.opId ?? null,
        },
        onStep,
      ),
    );
  };
  /** Sends the kept signed Clawback transaction to the Bitcoin backend again. */
  const broadcastAgain = () => {
    const kept = pendingClawback;
    if (kept?.hex == null || running !== null) return;
    const hex = kept.hex;
    void run("clawback", async () => {
      onStep({ kind: "broadcasting" });
      const sent = await deps.broadcast(hex);
      return sent.ok
        ? { kind: "broadcast", txid: sent.txid, opId: kept.opId }
        : { kind: "broadcast-failed", message: sent.message, hex, opId: kept.opId };
    });
  };

  const openOp = async () => {
    const text = opInput.trim();
    if (!/^\d{1,20}$/.test(text)) return setOpProblem(t.pending.badOp);
    const answer = await deps.view("get_op", { op_id: text });
    const read = answer.kind === "ok" ? asSpendOp(answer.value) : null;
    if (answer.kind === "error") {
      return setOpProblem(
        answer.code === null ? t.unreachable : refusalText(answer.code, answer.code),
      );
    }
    if (read === null) return setOpProblem(t.unreachable);
    if (read.vault_id !== vault.vault_id || read.kind !== "withdrawal") {
      return setOpProblem(t.pending.notThisVault);
    }
    setOpProblem(null);
    setOp(read);
  };

  // One orange action per screen: Connect until a wallet is connected, then Execute while a
  // request is open, else Request.
  const primary = connected === null ? "connect" : op !== null ? "execute" : "request";
  const ids = {
    destination: `${id}-destination`,
    amount: `${id}-amount`,
    amountHint: `${id}-amount-hint`,
    request: `${id}-request`,
    execute: `${id}-execute`,
    clawback: `${id}-clawback`,
    op: `${id}-op`,
    keys: `${id}-keys`,
  };

  return (
    <>
      <PageHeader title={t.title(vault.vault_id)} chips={[t.states[vault.state], "signet"]} />

      <div className="grid grid-cols-1 items-start gap-stack desktop:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="address" title={t.addressTitle}>
            {address === null ? (
              <p className={body}>{t.addressPending}</p>
            ) : (
              <>
                <p
                  data-testid="vault-address-text"
                  className="font-mono text-[13px] text-ink [overflow-wrap:anywhere]"
                >
                  {address}
                </p>
                {coins.kind === "ok" && (
                  <div className="flex flex-col gap-1">
                    <p
                      data-testid="vault-balance"
                      className="font-display text-numeral font-light tabular-nums"
                    >
                      {t.balance(formatBtc(confirmedSats))}
                    </p>
                    {totalSats > confirmedSats && (
                      <p className={body}>{t.unconfirmed(formatBtc(totalSats - confirmedSats))}</p>
                    )}
                    {coins.tip !== null && (
                      <p className="font-mono text-mono text-muted">{t.tip(String(coins.tip))}</p>
                    )}
                  </div>
                )}
                {coins.kind === "ok" && confirmed.length === 0 && (
                  <div data-testid="vault-unfunded" className="flex flex-col items-start gap-1">
                    <p className={body}>{t.unfunded}</p>
                    <a href={FAUCET_URL} target="_blank" rel="noreferrer" className={linkClass}>
                      {t.faucet}
                    </a>
                  </div>
                )}
                {coins.kind === "unreachable" && (
                  <div
                    data-testid="vault-btc-unreachable"
                    className="flex flex-col items-start gap-2"
                  >
                    <p className="text-[14px] text-alarm">{t.btcUnreachable}</p>
                    <Button variant="secondary" onClick={() => setCoinsTick((n) => n + 1)}>
                      {t.retry}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>

          <Section id="facts" title={t.factsTitle}>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
              <dt className="text-muted">{t.facts.owner}</dt>
              <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">
                {vault.owner_account}
              </dd>
              {vault.policy.guardians.length > 0 && (
                <>
                  <dt className="text-muted">{t.facts.guardian}</dt>
                  <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">
                    {vault.policy.guardians.map((g) => g.guardian_account).join(", ")}
                  </dd>
                </>
              )}
              <dt className="text-muted">{t.facts.delay}</dt>
              <dd className="font-mono text-[13px]">
                {formatDuration(nsToMs(vault.policy.delay_ns))}
              </dd>
              <dt className="text-muted">{t.facts.recovery}</dt>
              <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">
                {vault.policy.recovery_address}
              </dd>
            </dl>
            <Link to={proofPath(vault.vault_id)} className={linkClass}>
              {t.proof}
            </Link>
          </Section>

          <WalletCard
            status={wallet.status}
            onConnect={wallet.connect}
            onDisconnect={wallet.disconnect}
          />

          <Section id="keys" title={t.keysTitle}>
            <p className={body}>{t.keysBody}</p>
            <div className="flex flex-wrap items-center gap-3">
              <label
                className={cn(
                  buttonVariants({ variant: "secondary" }),
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink",
                )}
              >
                {t.loadKeys}
                <input
                  type="file"
                  accept="application/json,.json"
                  data-testid="load-keys"
                  className="sr-only"
                  aria-describedby={ids.keys}
                  onChange={(event) => void loadKeys(event)}
                />
              </label>
              {usableKeys !== null && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    downloadText(
                      keyFileName(vault.vault_id),
                      keyFileText(
                        usableKeys,
                        {
                          nearNetwork: usableKeys.nearNetwork,
                          vaultContract: usableKeys.vaultContract,
                          ownerAccount: usableKeys.ownerAccount,
                          vaultId: vault.vault_id,
                        },
                        usableKeys.recovery,
                      ),
                    )
                  }
                >
                  {t.downloadKeys}
                </Button>
              )}
            </div>
            <p
              id={ids.keys}
              data-testid="keys-status"
              className={cn(
                "text-[13px]",
                keyProblem !== null || mismatch !== null
                  ? "text-alarm"
                  : usableKeys !== null
                    ? "text-ok"
                    : "text-muted",
              )}
            >
              {keyProblem ??
                (mismatch !== null
                  ? t.keyProblem[mismatch]
                  : usableKeys !== null
                    ? t.keysLoaded
                    : "")}
            </p>
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="request" title={t.request.title}>
            <p className={body}>{t.request.body}</p>
            <label htmlFor={ids.destination} className="text-[14px] font-medium">
              {t.request.destination}
            </label>
            <input
              id={ids.destination}
              data-testid="withdraw-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={inputClass}
            />
            <label htmlFor={ids.amount} className="text-[14px] font-medium">
              {t.request.amount}
            </label>
            <input
              id={ids.amount}
              data-testid="withdraw-amount"
              inputMode="numeric"
              value={amount}
              placeholder={max > 0n ? max.toString() : ""}
              onChange={(event) => setAmount(event.target.value)}
              aria-describedby={ids.amountHint}
              className={cn(inputClass, "max-w-[220px]")}
            />
            <p id={ids.amountHint} className={cn(body, "text-[13px]")}>
              {t.request.max(max.toString())}
            </p>
            <div>
              <Button
                variant={primary === "request" ? "primary" : "secondary"}
                data-testid="withdraw-request"
                aria-disabled={requestGate !== null}
                aria-describedby={requestGate === null ? undefined : ids.request}
                className={softDisabled}
                onClick={request}
              >
                {t.request.submit}
              </Button>
            </div>
            {requestGate !== null && (
              <p id={ids.request} data-testid="withdraw-reason" className="text-[13px] text-muted">
                {requestGate}
              </p>
            )}
          </Section>

          <Section id="pending" title={t.pending.title}>
            {op === null ? (
              <p className={body}>{t.pending.none}</p>
            ) : (
              <div data-testid="pending-op" className="flex flex-col gap-1">
                <p className="font-mono text-[13px] text-ink [overflow-wrap:anywhere]">
                  {t.pending.summary(op.op_id, op.amount_sats, op.destination)}
                </p>
                <p className={body}>{t.pending.state(op.state)}</p>
                {op.executable_at !== null && (
                  <p data-testid="pending-executable-at" className="text-[14px] text-ink">
                    {t.pending.executableAt(absoluteTime(nsToMs(op.executable_at), now))}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.op} className="text-[14px] font-medium">
                  {t.pending.opLabel}
                </label>
                <input
                  id={ids.op}
                  data-testid="op-input"
                  inputMode="numeric"
                  value={opInput}
                  onChange={(event) => setOpInput(event.target.value)}
                  className={cn(inputClass, "max-w-[160px]")}
                />
              </div>
              <Button variant="secondary" data-testid="op-open" onClick={() => void openOp()}>
                {t.pending.open}
              </Button>
            </div>
            {opProblem !== null && <p className="text-[13px] text-alarm">{opProblem}</p>}
            <div>
              <Button
                variant={primary === "execute" ? "primary" : "secondary"}
                data-testid="withdraw-execute"
                aria-disabled={executeGate !== null}
                aria-describedby={executeGate === null ? undefined : ids.execute}
                className={softDisabled}
                onClick={execute}
              >
                {t.pending.execute}
              </Button>
            </div>
            {executeGate !== null && (
              <p id={ids.execute} data-testid="execute-reason" className="text-[13px] text-muted">
                {executeGate}
              </p>
            )}
          </Section>

          <Section id="clawback" title={t.clawback.title}>
            <p className={body}>{t.clawback.body}</p>
            <div>
              <Button
                variant="clawback"
                data-testid="clawback"
                aria-disabled={clawbackGate !== null}
                aria-describedby={clawbackGate === null ? undefined : ids.clawback}
                className={softDisabled}
                onClick={clawback}
              >
                {t.clawback.submit}
              </Button>
            </div>
            {clawbackGate !== null && (
              <p id={ids.clawback} data-testid="clawback-reason" className="text-[13px] text-muted">
                {clawbackGate}
              </p>
            )}
            {pendingClawback !== null && (
              <div data-testid="clawback-pending" className="flex flex-col items-start gap-2">
                <p className={body}>{t.clawback.resumeNote(pendingClawback.opId)}</p>
                {pendingClawback.hex !== null && (
                  <Button
                    variant="secondary"
                    data-testid="clawback-rebroadcast"
                    aria-disabled={running !== null}
                    className={softDisabled}
                    onClick={broadcastAgain}
                  >
                    {t.clawback.rebroadcast}
                  </Button>
                )}
              </div>
            )}
          </Section>

          {outcome !== null && (
            <Card
              aria-busy={running !== null}
              className="p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]"
            >
              <OutcomeLine testId="vault-outcome" outcome={outcome} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
