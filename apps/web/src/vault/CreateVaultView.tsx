import { useEffect, useId, useMemo, useState } from "react";
import {
  MorrowContractError,
  decodeSegwitAddress,
  nearTxUrl,
  signetPolicy,
  validatePolicy,
  type SignetDelay,
} from "@morrow/core-ts/browser";
import { useAppData } from "@/app/data";
import { useRouter } from "@/app/router";
import { vaultPath } from "@/app/wallet-paths";
import { Button } from "@/components/ui/button";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";
import { createdVaultId, waitForActive } from "./actions";
import {
  generateKeys,
  generateRecoveryKey,
  handOffKeys,
  keyFileName,
  keyFileText,
  downloadText,
  type LoadedKeys,
  type RecoveryKey,
} from "./keys";
import {
  CREATE_DEPOSIT,
  CREATE_GAS,
  CREATE_NEEDS,
  NEAR_FAUCET_URL,
  accountBalance,
  callContract,
  formatNear,
  viewContract,
} from "./near";
import { Badge } from "@/components/ui/badge";
import { VaultIcon } from "@/shell/icons";
import {
  CheckIcon,
  DelayDiagram,
  HowStrip,
  KeyIcon,
  RailStep,
  shorten,
  type StepStatus,
} from "./visual";
import {
  OutcomeLine,
  WalletBody,
  body,
  inputClass,
  refusalText,
  softDisabled,
  type Outcome,
} from "./ui";
import { useWallet } from "./useWallet";
import { WalletPageProblem, walletPageProblem } from "./WalletPageProblem";

const t = copy.vault.create;
const DELAYS: readonly SignetDelay[] = ["1h", "24h"];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; outcome: Outcome }
  | { kind: "done"; outcome: Outcome; vaultId: string | null };

// `/vault/new` (story 1.11b): connect a NEAR wallet, choose the Delay, name a signet Recovery
// Address and re-type its end, download the key file, then create the Vault with the wallet.
// Only Connect is actionable until a wallet is connected; Create stays disabled until every
// condition holds, each one listed while it does not.
export function CreateVaultView() {
  const { config } = useAppData();
  const { navigate } = useRouter();
  const wallet = useWallet();
  const id = useId();

  const [keys] = useState(generateKeys);
  const [delay, setDelay] = useState<SignetDelay>("1h");
  const [recovery, setRecovery] = useState("");
  const [testRecovery, setTestRecovery] = useState<RecoveryKey | null>(null);
  const [retype, setRetype] = useState("");
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /**
   * Set once create_vault may have been sent with these keys without the page seeing the Vault
   * active: Create stays disabled, so the same keys never make a second Vault. A reload draws
   * new keys.
   */
  const [spent, setSpent] = useState(false);

  const connected = wallet.status.kind === "connected" ? wallet.status.connected : null;
  const address = recovery.trim();
  const decoded = address === "" ? null : decodeSegwitAddress(address, "signet");
  const addressOk = decoded?.ok === true;
  const retypeOk = addressOk && retype.trim() !== "" && retype.trim() === address.slice(-6);
  const retypeWrong = addressOk && retype.trim().length >= 6 && !retypeOk;
  // The test key goes into the key file only while its address is the Recovery Address.
  const recoveryKey =
    testRecovery !== null && testRecovery.address === address ? testRecovery : null;

  const fileText = useMemo(
    () =>
      connected === null
        ? null
        : keyFileText(
            keys,
            {
              nearNetwork: config.network.near,
              vaultContract: config.contractId,
              ownerAccount: connected.accountId,
            },
            recoveryKey,
          ),
    [keys, connected, config.network.near, config.contractId, recoveryKey],
  );
  // A download counts only for the file as it is now (account and test key included).
  const downloaded = fileText !== null && downloadedFile === fileText;

  // A new wallet account holds no testnet NEAR, and its wallet then never asks to approve
  // create_vault: read the balance and point to the faucet until it covers the deposit.
  const [balance, setBalance] = useState<{ account: string; yocto: bigint } | null>(null);
  const accountId = connected?.accountId ?? null;
  const rpcUrl = config.nearRpcUrl;
  useEffect(() => {
    if (accountId === null || rpcUrl === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const yocto = await accountBalance(rpcUrl, accountId, abort.signal);
      if (abort.signal.aborted) return;
      if (yocto !== null) setBalance({ account: accountId, yocto });
      if (yocto === null || yocto < CREATE_NEEDS) timer = setTimeout(() => void read(), 10_000);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [accountId, rpcUrl]);
  const lowFunds =
    balance !== null && balance.account === accountId && balance.yocto < CREATE_NEEDS
      ? balance.yocto
      : null;

  const problem = walletPageProblem(config, wallet.nonce);
  if (problem !== null) {
    return (
      <>
        <PageHeader title={t.title} />
        <WalletPageProblem problem={problem} />
      </>
    );
  }

  const missing: string[] = [];
  if (connected === null) missing.push(t.missing.wallet);
  if (lowFunds !== null) missing.push(t.missing.funds);
  if (!addressOk) missing.push(t.missing.address);
  if (!retypeOk) missing.push(t.missing.retype);
  if (!downloaded) missing.push(t.missing.download);
  if (spent) missing.push(t.missing.reload);
  const busy = phase.kind === "busy";
  const canCreate = missing.length === 0 && !busy;
  /** The NearBlocks link of a create_vault transaction, when its hash is known. */
  const txLink = (hash: string | null) => {
    const href = hash === null ? null : nearTxUrl("testnet", hash);
    return href === null ? {} : { link: { href, text: t.viewTx } };
  };

  const download = () => {
    if (fileText === null) return;
    downloadText(keyFileName(null), fileText);
    setDownloadedFile(fileText);
  };

  const generate = () => {
    const key = generateRecoveryKey();
    setTestRecovery(key);
    setRecovery(key.address);
    // This page made the address, so there is no pasted text to check: confirm it for the user.
    setRetype(key.address.slice(-6));
  };

  const create = async () => {
    if (!canCreate || connected === null || config.nearRpcUrl === null) return;
    const policy = signetPolicy({
      delay,
      recoveryAddress: address,
      guardianKey: keys.guardian.publicKey,
      guardianAccount: connected.accountId,
      watcherX25519Pk: keys.watcher.publicKey,
    });
    try {
      validatePolicy(policy, ["signet"]);
    } catch (error) {
      const code = error instanceof MorrowContractError ? error.code : "ERR_POLICY_BOUNDS";
      setPhase({
        kind: "done",
        vaultId: null,
        outcome: { tone: "alarm", text: t.invalidPolicy(code) },
      });
      return;
    }
    setPhase({ kind: "busy", outcome: { tone: "neutral", text: t.waitingWallet } });
    const outcome = await callContract(
      connected.wallet,
      config.contractId,
      "create_vault",
      { owner_key: keys.owner.publicKey, policy },
      { deposit: CREATE_DEPOSIT, gas: CREATE_GAS },
    );
    if (outcome.kind === "unreadable") {
      setSpent(true);
      setPhase({
        kind: "done",
        vaultId: null,
        outcome: { tone: "alarm", text: t.maybeCreated, ...txLink(outcome.hash) },
      });
      return;
    }
    if (outcome.kind !== "ok") {
      // Refused or cancelled: nothing was created, and the form is kept.
      setPhase({
        kind: "done",
        vaultId: null,
        outcome: {
          tone: "alarm",
          text:
            outcome.kind === "refused"
              ? refusalText(outcome.code, outcome.message)
              : copy.vault.page.outcome.rejected(outcome.message),
        },
      });
      return;
    }
    const vaultId = createdVaultId(outcome.value, outcome.logs);
    if (vaultId === null) {
      setSpent(true);
      setPhase({
        kind: "done",
        vaultId: null,
        outcome: { tone: "alarm", text: t.noVaultId, ...txLink(outcome.hash) },
      });
      return;
    }
    const loaded: LoadedKeys = {
      ...keys,
      nearNetwork: config.network.near,
      vaultContract: config.contractId,
      btcNetwork: "signet",
      ownerAccount: connected.accountId,
      vaultId,
      recovery: recoveryKey,
    };
    handOffKeys(vaultId, loaded);
    setPhase({ kind: "busy", outcome: { tone: "neutral", text: t.activating(vaultId) } });
    const rpcUrl = config.nearRpcUrl;
    const abort = new AbortController();
    const vault = await waitForActive(
      (method, args) => viewContract(rpcUrl, config.contractId, method, args, abort.signal),
      sleep,
      vaultId,
    );
    if (vault === null) {
      setSpent(true);
      setPhase({
        kind: "done",
        vaultId,
        outcome: { tone: "alarm", text: t.notActive(vaultId), ...txLink(outcome.hash) },
      });
      return;
    }
    setPhase({ kind: "done", vaultId, outcome: { tone: "ok", text: t.active(vaultId) } });
    navigate(vaultPath(vaultId));
  };

  const ids = {
    recovery: `${id}-recovery`,
    recoveryHint: `${id}-recovery-hint`,
    recoveryError: `${id}-recovery-error`,
    retype: `${id}-retype`,
    retypeError: `${id}-retype-error`,
    missing: `${id}-missing`,
  };

  // The rail: each step is done, the current one, or still to come.
  const doneFlags = [connected !== null && lowFunds === null, retypeOk, retypeOk, downloaded];
  const current = doneFlags.findIndex((done) => !done);
  const status = (index: number): StepStatus =>
    doneFlags[index] === true ? "done" : index === current ? "current" : "later";
  const delayLabel = t.delays[delay].label;

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="chip">NEAR testnet</Badge>
          <Badge variant="chip">Bitcoin signet</Badge>
          <Badge variant="ok">{t.free}</Badge>
        </div>
        <h1 className="font-display text-[34px] leading-[1.1] font-normal tracking-[-0.03em] desktop:text-[46px]">
          {t.title}
        </h1>
        <p className="max-w-[640px] text-[16px] leading-[1.55] text-muted">{t.lede}</p>
      </header>

      <HowStrip />

      <div className="grid grid-cols-1 items-start gap-8 desktop:grid-cols-[minmax(0,1fr)_minmax(0,400px)] desktop:gap-10">
        <div className="flex min-w-0 flex-col">
          <RailStep
            id="wallet"
            n={1}
            title={copy.vault.wallet.stepTitle}
            status={status(0)}
            summary={connected?.accountId}
          >
            <WalletBody
              status={wallet.status}
              onConnect={wallet.connect}
              onDisconnect={wallet.disconnect}
            />
            {lowFunds !== null && (
              <div
                data-testid="wallet-low-funds"
                className="flex flex-col gap-3 rounded-[12px] border border-orange/40 bg-orange/5 p-4"
              >
                <p className="text-[14px] font-semibold text-ink">
                  {t.lowFunds.title(formatNear(lowFunds))}
                </p>
                <p className={body}>{t.lowFunds.body}</p>
                <a
                  href={NEAR_FAUCET_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 w-fit items-center rounded-full border border-line bg-card-raised px-4 text-[14px] font-medium text-ink hover:bg-line"
                >
                  {t.lowFunds.faucet}
                </a>
              </div>
            )}
          </RailStep>

          <RailStep
            id="recovery"
            n={2}
            title={t.recoveryTitle}
            status={status(1)}
            summary={addressOk ? shorten(address) : null}
          >
            <p className={body}>{t.recoveryHint}</p>
            <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-page/60 p-3 desktop:flex-row desktop:items-center desktop:justify-between">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-ink">{t.generateTitle}</p>
                <p className={cn(body, "text-[13px]")}>{t.generateNote}</p>
              </div>
              <Button
                variant="secondary"
                data-testid="generate-recovery"
                aria-disabled={connected === null}
                className={softDisabled}
                onClick={() => connected !== null && generate()}
              >
                <KeyIcon className="size-4" />
                {t.generate}
              </Button>
            </div>
            <label htmlFor={ids.recovery} className="text-[14px] font-medium">
              {t.recoveryLabel}
            </label>
            <input
              id={ids.recovery}
              data-testid="recovery-address"
              value={recovery}
              placeholder="tb1q…"
              onChange={(event) => {
                setRecovery(event.target.value);
                setRetype("");
              }}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={decoded !== null && !decoded.ok}
              aria-describedby={
                decoded !== null && !decoded.ok
                  ? `${ids.recoveryError} ${ids.recoveryHint}`
                  : ids.recoveryHint
              }
              className={inputClass}
            />
            {decoded !== null && !decoded.ok && (
              <p
                id={ids.recoveryError}
                data-testid="recovery-error"
                className="text-[13px] text-alarm"
              >
                {t.addressProblem[decoded.problem]}
              </p>
            )}
            <p id={ids.recoveryHint} className="sr-only">
              {t.recoveryHint}
            </p>
            <label htmlFor={ids.retype} className="text-[14px] font-medium">
              {t.retypeLabel}
            </label>
            <div className="flex items-center gap-3">
              <input
                id={ids.retype}
                data-testid="recovery-retype"
                value={retype}
                maxLength={6}
                onChange={(event) => setRetype(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                aria-invalid={retypeWrong}
                aria-describedby={retypeWrong ? ids.retypeError : undefined}
                className={cn(inputClass, "max-w-[160px] tracking-[0.2em]")}
              />
              {retypeOk && <CheckIcon className="size-5 text-ok" />}
            </div>
            {retypeWrong && (
              <p id={ids.retypeError} data-testid="retype-error" className="text-[13px] text-alarm">
                {t.retypeMismatch}
              </p>
            )}
          </RailStep>

          <RailStep id="delay" n={3} title={t.delayTitle} status={status(2)} summary={delayLabel}>
            <fieldset className="flex flex-col gap-3">
              <legend className={cn(body, "mb-3")}>{t.delayLegend}</legend>
              <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
                {DELAYS.map((value) => (
                  <label
                    key={value}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[14px] border border-line bg-page/60 p-4 transition-colors hover:border-muted/60 has-checked:border-ink has-checked:bg-card-raised"
                  >
                    <input
                      type="radio"
                      name={`${id}-delay`}
                      value={value}
                      checked={delay === value}
                      onChange={() => setDelay(value)}
                      className="mt-1 size-4 accent-[var(--color-ink)]"
                    />
                    <span className="flex flex-col gap-1">
                      <span className="font-display text-[24px] leading-none font-light tracking-[-0.02em]">
                        {t.delays[value].label}
                      </span>
                      <span className="text-[13px] text-muted">{t.delays[value].note}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <details className="text-[13px]">
              <summary className="min-h-11 cursor-pointer content-center text-muted hover:text-ink">
                {t.detailsSummary}
              </summary>
              <p className={cn(body, "text-[13px]")}>{t.policyFacts}</p>
            </details>
          </RailStep>

          <RailStep
            id="keys"
            n={4}
            title={t.keysTitle}
            status={status(3)}
            summary={downloaded ? t.savedShort : null}
            last
          >
            <div className="flex gap-3">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] border border-line bg-card-raised text-ink">
                <KeyIcon className="size-5" />
              </span>
              <p className={body}>{t.keysBody}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                data-testid="download-keys"
                aria-disabled={fileText === null}
                className={softDisabled}
                onClick={download}
              >
                {t.download}
              </Button>
              {fileText === null && (
                <span className="text-[13px] text-muted">{t.missing.wallet}</span>
              )}
            </div>
            {downloaded && (
              <p data-testid="keys-downloaded" className="text-[13px] text-ok">
                {t.downloaded}
              </p>
            )}
          </RailStep>
        </div>

        <div className="min-w-0 desktop:sticky desktop:top-6">
          <section
            role="region"
            aria-labelledby="vault-create-title"
            data-testid="vault-create"
            className="bg-card-surface flex flex-col gap-5 rounded-xl border border-line p-5 desktop:p-6"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex size-11 items-center justify-center rounded-[14px] border border-line bg-card-raised text-ink">
                <VaultIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-mono text-muted">{t.previewEyebrow}</p>
                <h2 id="vault-create-title" className="font-display text-[22px] tracking-[-0.02em]">
                  {t.createTitle}
                </h2>
              </div>
              <Badge variant="chip">{t.draft}</Badge>
            </div>

            <DelayDiagram
              delay={delayLabel}
              recovery={addressOk ? shorten(address, 10, 8) : null}
            />

            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line pt-4 text-[13px]">
              <dt className="text-muted">{t.preview.owner}</dt>
              <dd className="truncate text-right font-mono text-ink">
                {connected?.accountId ?? t.preview.none}
              </dd>
              <dt className="text-muted">{t.preview.guardian}</dt>
              <dd className="truncate text-right font-mono text-ink">
                {connected?.accountId ?? t.preview.none}
              </dd>
              <dt className="text-muted">{t.preview.delay}</dt>
              <dd className="text-right font-mono text-ink">{delayLabel}</dd>
              <dt className="text-muted">{t.preview.recovery}</dt>
              <dd className="truncate text-right font-mono text-ink">
                {addressOk ? shorten(address) : t.preview.none}
              </dd>
              <dt className="text-muted">{t.preview.keys}</dt>
              <dd className={cn("text-right font-mono", downloaded ? "text-ok" : "text-muted")}>
                {downloaded ? t.savedShort : t.preview.notSaved}
              </dd>
            </dl>

            {missing.length > 0 && (
              <div id={ids.missing} data-testid="create-missing" className="flex flex-col gap-2">
                <h3 className="text-[13px] font-semibold text-muted">{t.missingTitle}</h3>
                <ul className="flex flex-col gap-1.5">
                  {missing.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-[13.5px] text-muted">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-faint" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              variant={connected === null ? "secondary" : "primary"}
              data-testid="create-vault"
              aria-disabled={!canCreate}
              aria-describedby={missing.length > 0 ? ids.missing : undefined}
              className={cn(softDisabled, "w-full text-[15px]")}
              onClick={() => void create()}
            >
              {t.submit}
            </Button>
            <p className="text-[12.5px] leading-[1.5] text-muted">{t.cost}</p>
            <OutcomeLine
              testId="create-outcome"
              outcome={phase.kind === "idle" ? null : phase.outcome}
            />
            {phase.kind === "done" && phase.vaultId !== null && phase.outcome.tone === "alarm" && (
              <Button variant="secondary" onClick={() => navigate(vaultPath(phase.vaultId ?? ""))}>
                {t.openVault(phase.vaultId)}
              </Button>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
