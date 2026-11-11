import { useId, useState, type FormEvent, type ReactNode } from "react";
import { nearAccountUrl } from "@morrow/core-ts/browser";
import { absoluteTime, nsToMs } from "@/app/challenge";
import { useAppData, type AppConfig } from "@/app/data";
import {
  canonicalVaultId,
  changeLine,
  guarantees,
  guardianLabel,
  hasWatcher,
  isDue,
  pendingChangeOf,
  policyRows,
  residualRisk,
  stateNotice,
  trustStatements,
  watcherLine,
  withdrawalLine,
  type ProofFacts,
  type Statement,
} from "@/app/proof";
import { Link, useRouter } from "@/app/router";
import { proofPath } from "@/app/routes";
import { useProof } from "@/app/useProof";
import { xrayOpPath } from "@/app/xray-paths";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";
import { AddressRecompute } from "./ScriptView";

const p = copy.proof;

// The Proof Page (story 6.1): a Vault's real rules, read live from the chain with no sign-in,
// no wallet and no server cache, every 30 s. `/proof/<id>` shows that Vault; bare `/proof`
// shows the live Challenge Vault while a round is open, otherwise a form to open one by id.
// The Address card's Recompute (story 6.2, ScriptView.tsx) is the page's one primary action.
export function ProofView({ vaultId }: { vaultId: string | null }) {
  const { challenge, challengeStatus, config } = useAppData();
  if (vaultId !== null) return <VaultProof vaultId={vaultId} config={config} />;
  const keys = challenge?.keys ?? null;
  // Why the form shows instead of the live round's Vault.
  let lead: string = p.open.noRound;
  if (challenge && keys) {
    const liveId = keys.vault_id === null ? null : canonicalVaultId(keys.vault_id);
    if (keys.vault_contract !== config.contractId) {
      lead = p.open.otherContract(keys.vault_contract, config.contractId);
    } else if (liveId === null) {
      lead = p.open.noVault(challenge.round);
    } else {
      return <VaultProof vaultId={liveId} config={config} round={challenge.round} />;
    }
  } else if (challengeStatus === "unreachable") {
    lead = p.open.feedDown;
  } else if (challengeStatus === "loading") {
    // Until `/round` first answers, nothing is claimed.
    return (
      <>
        <PageHeader title={copy.titles.proof} />
        <ProofSkeleton />
      </>
    );
  }
  return (
    <>
      <PageHeader title={copy.titles.proof} />
      <OpenVault contractId={config.contractId} lead={lead} />
    </>
  );
}

function VaultProof({
  vaultId,
  config,
  round,
}: {
  vaultId: string;
  config: AppConfig;
  round?: number;
}) {
  const { state, retry } = useProof(config.nearRpcUrl, config.contractId, vaultId);
  const chips = [p.vaultChip(vaultId)];
  if (round !== undefined) chips.push(p.liveRound(round));
  if (state.kind === "ok") chips.push(p.states[state.facts.vault.state]);
  const header = <PageHeader title={copy.titles.proof} chips={chips} />;

  if (state.kind === "no-rpc") {
    return (
      <>
        {header}
        <Notice testId="proof-no-rpc" title={p.noRpc} body={p.noRpcBody} />
      </>
    );
  }
  if (state.kind === "loading") {
    return (
      <>
        {header}
        <ProofSkeleton />
      </>
    );
  }
  if (state.kind === "missing") {
    return (
      <>
        {header}
        <Notice
          testId="proof-missing"
          title={p.missing(vaultId, config.contractId)}
          body={p.missingBody}
        >
          <Badge variant="chip" data-testid="proof-error-code">
            {state.code}
          </Badge>
        </Notice>
      </>
    );
  }
  if (state.kind === "misconfigured") {
    return (
      <>
        {header}
        <Notice
          testId="proof-misconfigured"
          title={p.misconfigured(config.contractId)}
          body={p.misconfiguredBody}
        >
          <Button variant="secondary" onClick={retry}>
            {p.retry}
          </Button>
        </Notice>
      </>
    );
  }
  if (state.kind === "unreachable") {
    return (
      <>
        {header}
        <Notice testId="proof-unreachable" title={p.unreachable} body={p.unreachableBody}>
          <Button variant="secondary" onClick={retry}>
            {p.retry}
          </Button>
        </Notice>
      </>
    );
  }
  return (
    <>
      {header}
      {state.stale && (
        <Card
          data-testid="proof-stale"
          className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:flex-row desktop:items-center desktop:justify-between desktop:p-card-pad"
        >
          <p className="text-[14px] text-alarm">
            {p.stale[state.stale](absoluteTime(state.readAt, state.now))}
          </p>
          <Button variant="secondary" onClick={retry}>
            {p.retry}
          </Button>
        </Card>
      )}
      <ProofBody facts={state.facts} now={state.now} config={config} />
    </>
  );
}

/** The cards of one read, in two columns on desktop and one on phones. */
function ProofBody({ facts, now, config }: { facts: ProofFacts; now: number; config: AppConfig }) {
  const { vault } = facts;
  const policy = vault.policy;
  const net = policy.btc_network;
  const change = pendingChangeOf(vault);
  const statementFacts = {
    now,
    contractId: config.contractId,
    coSigner: config.coSigner,
    codeHash: facts.codeHash,
    withdrawals: facts.withdrawals,
    clawedBack: facts.clawedBack,
    caughtUp: facts.history.caughtUp,
  };
  const residual = residualRisk(vault);
  const notice = stateNotice(vault);
  // The deployment's watcher matters to this Vault only through an Auto-Clawback Guardian.
  const watcher = hasWatcher(vault) ? watcherLine(config.heartbeat) : null;
  const near = config.network.near;
  const reading = !facts.history.caughtUp;

  return (
    <>
      {vault.state === "clawed_back" && (
        <Card
          data-testid="proof-clawed-back"
          className="p-card-pad-mobile text-[15px] [overflow-wrap:anywhere] desktop:p-card-pad"
        >
          {facts.clawedBack
            ? p.clawedBack(
                facts.clawedBack.recoveryAddress,
                absoluteTime(nsToMs(facts.clawedBack.at), now),
              )
            : p.clawedBackUntimed(policy.recovery_address)}
        </Card>
      )}
      <div
        data-testid="proof-columns"
        className="grid grid-cols-1 items-start gap-stack desktop:grid-cols-2"
      >
        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="policy" title={p.sections.policy}>
            <Rows>
              {policyRows(policy).map((row) => (
                <Row key={row.label} label={row.label} mono={row.mono}>
                  {row.value}
                </Row>
              ))}
              <Row label={p.rows.guardians}>
                <ul data-testid="proof-guardians" className="flex flex-col gap-1.5">
                  {policy.guardians.map((guardian) => (
                    <li key={guardian.guardian_account}>
                      <div data-testid="proof-guardian">{guardianLabel(guardian)}</div>
                      <div className="font-mono text-mono text-muted">
                        {p.rows.guardianKey(guardian.guardian_key)}
                      </div>
                    </li>
                  ))}
                </ul>
              </Row>
            </Rows>
          </Section>
          <Section id="pending" title={p.sections.pending}>
            {facts.withdrawals.length === 0 && change === null ? (
              // Nothing pending is claimed only once the whole history is read.
              !reading && <p className="text-[14px] text-muted">{p.noPending}</p>
            ) : (
              <ul className="divide-y divide-line">
                {facts.withdrawals.map((op) => (
                  <li key={op.opId} data-testid="proof-withdrawal" className="py-2.5 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2 text-[14px]">
                      <span>{withdrawalLine(op, net, now)}</span>
                      {op.frozen && <Badge variant="chip">{p.frozen}</Badge>}
                      {isDue(op, now) && (
                        <Badge variant="alarm" data-testid="proof-due">
                          {p.due}
                        </Badge>
                      )}
                      {near !== "mock" && (
                        <Link
                          to={xrayOpPath(op.opId)}
                          aria-label={p.xrayLabel(op.opId)}
                          data-testid="proof-xray"
                          className="inline-flex min-h-11 items-center text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink"
                        >
                          {p.xray}
                        </Link>
                      )}
                    </div>
                    {op.destination !== "" && (
                      <div className="mt-1 font-mono text-mono text-muted [overflow-wrap:anywhere]">
                        {p.destination(op.destination)}
                      </div>
                    )}
                  </li>
                ))}
                {change && (
                  <li
                    data-testid="proof-change"
                    className="py-2.5 text-[14px] [overflow-wrap:anywhere] first:pt-0"
                  >
                    {changeLine(change, net, now)}
                  </li>
                )}
              </ul>
            )}
            {reading && (
              <p data-testid="proof-reading" className="mt-3 text-[13px] text-muted">
                {p.reading(facts.history.read)}
              </p>
            )}
          </Section>
          <Section id="guarantees" title={p.sections.guarantees} intro={p.guaranteesIntro}>
            {notice === null ? (
              <Statements items={guarantees(vault, statementFacts)} />
            ) : (
              <p data-testid="proof-not-active" className="text-[14px] leading-[1.55]">
                {notice}
              </p>
            )}
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="contract" title={p.sections.contract}>
            <Rows>
              <Row label={p.rows.contract} mono>
                <span className="mr-2">{config.contractId}</span>
                {near !== "mock" && (
                  <a
                    href={nearAccountUrl(near, config.contractId)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={p.explorerLabel(config.contractId)}
                    data-testid="proof-explorer"
                    className="inline-flex min-h-11 items-center font-sans text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink"
                  >
                    {p.explorer}
                  </a>
                )}
              </Row>
              <Row label={p.rows.codeHash} mono>
                <span data-testid="proof-code-hash" className={cn(!facts.codeHash && "text-alarm")}>
                  {facts.codeHash ?? p.unread}
                </span>
              </Row>
              <Row label={p.rows.lock}>
                <span
                  data-testid="proof-lock"
                  data-locked={facts.fullAccessKeys === 0}
                  className={cn(facts.fullAccessKeys === 0 ? "text-ok" : "text-alarm")}
                >
                  {facts.fullAccessKeys === null
                    ? p.lockUnknown
                    : facts.fullAccessKeys === 0
                      ? p.locked
                      : p.unlocked(facts.fullAccessKeys)}
                </span>
              </Row>
              {watcher && (
                <Row label={p.rows.watcher}>
                  <span
                    data-testid="proof-heartbeat"
                    data-alarm={watcher.alarm}
                    className={cn(watcher.alarm && "text-alarm")}
                  >
                    {watcher.text}
                  </span>
                </Row>
              )}
            </Rows>
          </Section>
          <Section id="vault" title={p.sections.vault}>
            <Rows>
              <Row label={p.rows.state}>{p.states[vault.state]}</Row>
              <Row label={p.rows.owner} mono>
                {vault.owner_account}
              </Row>
              <Row label={p.rows.created}>{absoluteTime(nsToMs(vault.created_at), now)}</Row>
              <Row label={p.rows.network}>{policy.btc_network}</Row>
            </Rows>
          </Section>
          <Section id="address" title={p.sections.addresses}>
            {vault.addresses === null || vault.state === "pending_keys" ? (
              <>
                <p className="text-[14px] text-muted">{p.rows.notActive}</p>
                {/* No kit without keys: Recompute is unavailable, and says why. */}
                <p data-testid="recompute-unavailable" className="mt-2 text-[14px] text-muted">
                  {p.recompute.noScript}
                </p>
              </>
            ) : (
              <>
                <Rows>
                  <Row label={p.rows.vaultAddress} mono>
                    {vault.addresses.vault}
                  </Row>
                  <Row label={p.rows.allowanceAddress} mono>
                    {vault.addresses.allowance}
                  </Row>
                </Rows>
                <AddressRecompute key={vault.vault_id} vault={vault} config={config} />
              </>
            )}
          </Section>
          <Section id="trust" title={p.sections.trust} intro={p.trustIntro}>
            <Statements items={trustStatements(vault, statementFacts)} />
            {residual !== null && (
              <p data-testid="proof-residual" className="mt-4 text-[14px] leading-[1.55]">
                {residual}
              </p>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

/** A card that is a labelled region, with its heading. */
function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  const headingId = `proof-${id}-title`;
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      data-testid={`proof-${id}`}
      className="min-w-0 p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]"
    >
      <h2 id={headingId} className="text-label text-muted">
        {title}
      </h2>
      {intro !== undefined && <p className="mt-1 text-[13px] text-muted">{intro}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-line">{children}</dl>;
}

/** A label and its value; a `mono` value is an identifier, shown in full and wrapped. */
function Row({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 desktop:flex-row desktop:items-baseline desktop:justify-between desktop:gap-4">
      <dt className="shrink-0 text-[13px] text-muted">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-[14px] text-ink [overflow-wrap:anywhere] desktop:text-right",
          mono && "font-mono text-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Statements({ items }: { items: readonly Statement[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {items.map((item) => (
        <li key={item.id} data-testid="proof-statement" data-id={item.id}>
          <h3 className="flex items-baseline gap-2 text-[14px] font-semibold">
            <span className="font-mono text-mono font-medium text-muted">{item.id}</span>
            {item.title}
          </h3>
          <p className="mt-1 text-[14px] leading-[1.55] text-muted [overflow-wrap:anywhere]">
            {item.text}
          </p>
          {item.alert !== undefined && (
            <p data-testid="proof-statement-alert" className="mt-1 text-[14px] text-alarm">
              {item.alert}
            </p>
          )}
          {item.link !== undefined && (
            <a
              href={item.link.href}
              target="_blank"
              rel="noreferrer"
              data-testid="proof-statement-link"
              className="inline-flex min-h-11 items-center text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink"
            >
              {item.link.text}
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

function Notice({
  testId,
  title,
  body,
  children,
}: {
  testId: string;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <Card
      data-testid={testId}
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle className="[overflow-wrap:anywhere]">{title}</CardTitle>
      <CardDescription className="max-w-[520px]">{body}</CardDescription>
      {children}
    </Card>
  );
}

/** Skeleton cards in the page's two columns while the first read is out. */
function ProofSkeleton() {
  return (
    <div
      data-testid="proof-loading"
      aria-busy="true"
      className="grid grid-cols-1 items-start gap-stack desktop:grid-cols-2"
    >
      <p className="sr-only">{p.loading}</p>
      {[6, 4, 5, 3].map((lines, index) => (
        <Card key={index} className="p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: lines }, (_, line) => (
            <Skeleton key={line} className="mt-3 h-[18px] w-full" />
          ))}
        </Card>
      ))}
    </div>
  );
}

/** Bare `/proof` without a live round: open any Vault by its id. */
function OpenVault({ contractId, lead }: { contractId: string; lead: string }) {
  const { navigate } = useRouter();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const ids = { title: useId(), input: useId(), error: useId() };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = canonicalVaultId(value.trim());
    if (id === null) {
      setInvalid(true);
      return;
    }
    navigate(proofPath(id));
  };
  return (
    <Card
      role="region"
      aria-labelledby={ids.title}
      data-testid="proof-open"
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle id={ids.title}>{p.open.title}</CardTitle>
      <CardDescription data-testid="proof-open-lead" className="max-w-[520px]">
        {lead} {p.open.body(contractId)}
      </CardDescription>
      <form noValidate onSubmit={submit} className="flex w-full max-w-[420px] flex-col gap-2">
        <label htmlFor={ids.input} className="text-label text-muted">
          {p.open.label}
        </label>
        <div className="flex flex-col gap-2 desktop:flex-row">
          <input
            id={ids.input}
            data-testid="proof-open-id"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? ids.error : undefined}
            className="min-h-11 w-full min-w-0 rounded-[12px] border border-line bg-page px-3 font-mono text-[13px] text-ink aria-invalid:border-alarm"
          />
          <Button type="submit" variant="secondary">
            {p.open.submit}
          </Button>
        </div>
        {invalid && (
          <p id={ids.error} data-testid="proof-open-error" className="text-[13px] text-alarm">
            {p.open.invalid}
          </p>
        )}
      </form>
    </Card>
  );
}
