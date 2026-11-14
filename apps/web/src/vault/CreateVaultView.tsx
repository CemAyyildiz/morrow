import { useId, useMemo, useState } from "react";
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
import { CREATE_DEPOSIT, CREATE_GAS, callContract, viewContract } from "./near";
import {
  OutcomeLine,
  Section,
  WalletCard,
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

  return (
    <>
      <PageHeader title={t.title} chips={["signet", "NEAR testnet"]} />
      <section
        aria-labelledby={`${id}-how`}
        data-testid="vault-how"
        className="max-w-[720px] rounded-[16px] border border-line p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]"
      >
        <h2 id={`${id}-how`} className="text-[16px] font-semibold text-ink">
          {t.howTitle}
        </h2>
        <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-[15px] leading-[1.55] text-ink">
          {t.how.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <p className={cn(body, "mt-3 text-[13px]")}>{t.howNote}</p>
      </section>

      <div className="flex max-w-[720px] flex-col gap-stack">
        <WalletCard
          step={1}
          status={wallet.status}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
        />

        <Section id="recovery" step={2} title={t.recoveryTitle}>
          <label htmlFor={ids.recovery} className="text-[14px] font-medium">
            {t.recoveryLabel}
          </label>
          <input
            id={ids.recovery}
            data-testid="recovery-address"
            value={recovery}
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
          <p id={ids.recoveryHint} className={cn(body, "text-[13px]")}>
            {t.recoveryHint}
          </p>
          <div className="flex flex-col items-start gap-1">
            <Button
              variant="secondary"
              data-testid="generate-recovery"
              aria-disabled={connected === null}
              className={softDisabled}
              onClick={() => connected !== null && generate()}
            >
              {t.generate}
            </Button>
            <p className={cn(body, "text-[13px]")}>{t.generateNote}</p>
          </div>
          <label htmlFor={ids.retype} className="text-[14px] font-medium">
            {t.retypeLabel}
          </label>
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
            className={cn(inputClass, "max-w-[160px]")}
          />
          {retypeWrong && (
            <p id={ids.retypeError} data-testid="retype-error" className="text-[13px] text-alarm">
              {t.retypeMismatch}
            </p>
          )}
        </Section>

        <Section id="delay" step={3} title={t.delayTitle}>
          <fieldset className="flex flex-col gap-2">
            <legend className={cn(body, "mb-2")}>{t.delayLegend}</legend>
            {DELAYS.map((value) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[12px] border border-line px-3 py-2 has-checked:border-muted has-checked:bg-card-raised"
              >
                <input
                  type="radio"
                  name={`${id}-delay`}
                  value={value}
                  checked={delay === value}
                  onChange={() => setDelay(value)}
                  className="size-4 accent-[var(--color-ink)]"
                />
                <span className="text-[14px] font-semibold">{t.delays[value].label}</span>
                <span className="text-[13px] text-muted">{t.delays[value].note}</span>
              </label>
            ))}
          </fieldset>
          <details className="text-[13px]">
            <summary className="min-h-11 cursor-pointer content-center text-muted">
              {t.detailsSummary}
            </summary>
            <p className={cn(body, "text-[13px]")}>{t.policyFacts}</p>
          </details>
        </Section>

        <Section id="keys" step={4} title={t.keysTitle}>
          <p className={body}>{t.keysBody}</p>
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
          </div>
          {downloaded && (
            <p data-testid="keys-downloaded" className="text-[13px] text-ok">
              {t.downloaded}
            </p>
          )}
        </Section>

        <Section id="create" step={5} title={t.createTitle}>
          {missing.length > 0 && (
            <div id={ids.missing} data-testid="create-missing">
              <h3 className="text-[14px] font-semibold">{t.missingTitle}</h3>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
                {missing.map((item) => (
                  <li key={item} className={body}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Button
              variant={connected === null ? "secondary" : "primary"}
              data-testid="create-vault"
              aria-disabled={!canCreate}
              aria-describedby={missing.length > 0 ? ids.missing : undefined}
              className={softDisabled}
              onClick={() => void create()}
            >
              {t.submit}
            </Button>
          </div>
          <p className={cn(body, "text-[13px]")}>{t.cost}</p>
          <OutcomeLine
            testId="create-outcome"
            outcome={phase.kind === "idle" ? null : phase.outcome}
          />
          {phase.kind === "done" && phase.vaultId !== null && phase.outcome.tone === "alarm" && (
            <Button variant="secondary" onClick={() => navigate(vaultPath(phase.vaultId ?? ""))}>
              {t.openVault(phase.vaultId)}
            </Button>
          )}
        </Section>
      </div>
    </>
  );
}
