import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { absoluteTime } from "@/app/challenge";
import { useAppData } from "@/app/data";
import { useRouter } from "@/app/router";
import type { XRayRouteTarget } from "@/app/routes";
import { useXRay } from "@/app/useXRay";
import {
  REVEAL_STEP_MS,
  parseXRayEntry,
  senderHint,
  xrayEndpoints,
  xrayModel,
  type DecodedScript,
  type RowGroup,
  type StageTone,
  type StageView,
  type XRayModel,
  type XRayRow,
  type XRayTarget,
} from "@/app/xray";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/copy";
import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";

const x = copy.xrayPage;

// The X-Ray page (story 6.4): one op (`/xray/<op_id>`) or one refused call (`/xray/tx/<hash>`)
// through four numbered stages — Bitcoin script path, Vault Contract rule, NEAR MPC signature,
// Bitcoin transaction — assembled by core-ts `buildXRay` in this browser from chain data only.
// Stages light up 1 → 4, 450 ms apart, up to the first one still waiting; every value links to
// its explorer when it has one and names, on hover and under Sources, the call it came from.
// Bare `/xray` is a form. Public and shareable: no sign-in.
export function XRayView({ target }: { target: XRayRouteTarget | null }) {
  const { config } = useAppData();
  const endpoints = useMemo(
    () => xrayEndpoints(config),
    // The fields X-Ray reads; the config object itself changes with every heartbeat.
    [
      config.network.near,
      config.contractId,
      config.nearRpcUrl,
      config.nearArchivalRpcUrl,
      config.nearTxIndexerUrl,
      config.btcBackendUrl,
    ],
  );
  if (endpoints === null) {
    return (
      <>
        <PageHeader title={copy.titles.xray} />
        <Notice testId="xray-no-network" title={x.noNetwork} body={x.noNetworkBody} />
      </>
    );
  }
  if (target === null) {
    return (
      <>
        <PageHeader title={copy.titles.xray} />
        <OpenXRay contractId={config.contractId} />
      </>
    );
  }
  return <XRayOf target={target} endpoints={endpoints} contractId={config.contractId} />;
}

function XRayOf({
  target,
  endpoints,
  contractId,
}: {
  target: XRayRouteTarget;
  endpoints: NonNullable<ReturnType<typeof xrayEndpoints>>;
  contractId: string;
}) {
  // A refused call's signer, when the link names it (`?sender=`): no wait for the indexer.
  const full = useMemo<XRayTarget>(
    () =>
      target.kind === "op"
        ? target
        : { kind: "tx", hash: target.hash, sender: senderHint(window.location.search) },
    [target],
  );
  const { state, retry } = useXRay(endpoints, full);
  const model = state.kind === "ok" ? xrayModel(state.xray, state.now) : null;
  const reveal = useReveal(model?.reveal ?? 0, JSON.stringify(full));
  const chips = model?.chips ?? (target.kind === "op" ? [x.opChip(target.opId)] : [x.refusedChip]);
  const header = <PageHeader title={copy.titles.xray} chips={chips} />;

  if (state.kind === "loading" || state.kind === "no-network") {
    return (
      <>
        {header}
        <PipelineSkeleton />
      </>
    );
  }
  if (state.kind === "input") {
    return (
      <>
        {header}
        <Notice testId="xray-input" title={x.input} body={state.message} />
        <OpenXRay contractId={contractId} />
      </>
    );
  }
  if (state.kind === "unreachable") {
    return (
      <>
        {header}
        <Notice testId="xray-unreachable" title={x.unreachable} body={x.unreachableBody}>
          <Button variant="secondary" onClick={retry}>
            {x.retry}
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
          data-testid="xray-stale"
          className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:flex-row desktop:items-center desktop:justify-between desktop:p-card-pad"
        >
          <p className="text-[14px] text-alarm">{x.stale(absoluteTime(state.readAt, state.now))}</p>
          <Button variant="secondary" onClick={retry}>
            {x.retry}
          </Button>
        </Card>
      )}
      {model && <XRayPipeline model={model} shown={reveal} />}
      {model?.live && <p className="text-[13px] text-muted">{x.reading}</p>}
    </>
  );
}

/**
 * How many stages are lit: one more every 450 ms up to `count`, starting over for another
 * `resetKey`; all at once under reduced motion. A re-read that lights more stages goes on from
 * where the reveal stands.
 */
function useReveal(count: number, resetKey: string): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState({ key: resetKey, n: 0 });
  const n = shown.key === resetKey ? shown.n : 0;
  useEffect(() => {
    if (reduced || n >= count) return;
    const timer = setTimeout(
      () => setShown({ key: resetKey, n: n + 1 }),
      n === 0 ? 0 : REVEAL_STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [reduced, n, count, resetKey]);
  return reduced ? count : Math.min(n, count);
}

const TONE_BADGE: Record<StageTone, "ok" | "alarm" | "chip"> = {
  lit: "chip",
  ok: "ok",
  waiting: "chip",
  alarm: "alarm",
  unreached: "chip",
};

/** The four stages, numbered and joined by a connector line; the first `shown` are lit. */
export function XRayPipeline({ model, shown }: { model: XRayModel; shown: number }) {
  return (
    <ol data-testid="xray-pipeline" className="flex flex-col">
      {model.stages.map((stage, index) => (
        <Stage
          key={stage.id}
          stage={stage}
          revealed={index < shown}
          last={index === model.stages.length - 1}
        />
      ))}
    </ol>
  );
}

function Stage({ stage, revealed, last }: { stage: StageView; revealed: boolean; last: boolean }) {
  const titleId = useId();
  const dim = !revealed || stage.tone === "waiting" || stage.tone === "unreached";
  return (
    <li
      data-testid="xray-stage"
      data-stage={stage.id}
      data-status={stage.status}
      data-tone={stage.tone}
      data-revealed={revealed}
      aria-labelledby={titleId}
      className={cn(
        "relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-stack desktop:gap-4",
        !last &&
          "after:absolute after:top-9 after:bottom-1 after:left-[13.5px] after:w-px after:bg-line",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative z-[1] mt-[14px] flex size-7 items-center justify-center rounded-full border bg-page font-mono text-[12px] font-medium transition-colors duration-[350ms] motion-reduce:transition-none",
          !revealed
            ? "border-line text-faint"
            : stage.tone === "alarm"
              ? "border-alarm text-alarm"
              : stage.tone === "ok"
                ? "border-ok/40 text-ok"
                : stage.tone === "lit"
                  ? "border-muted text-ink"
                  : "border-line text-muted",
        )}
      >
        {stage.n}
      </span>
      <Card
        className={cn(
          "min-w-0 p-card-pad-mobile transition-opacity duration-[350ms] motion-reduce:transition-none desktop:px-[22px] desktop:py-[18px]",
          dim ? "opacity-55" : "opacity-100",
          revealed && stage.tone === "alarm" && "border-alarm/60",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-label text-muted">
            {stage.title}
          </h2>
          {revealed && (
            <Badge variant={TONE_BADGE[stage.tone]} data-testid="xray-stage-status">
              {stage.statusText}
            </Badge>
          )}
        </div>
        {revealed && <StageBody stage={stage} />}
      </Card>
    </li>
  );
}

function StageBody({ stage }: { stage: StageView }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-3">
      <p
        data-testid="xray-stage-headline"
        className={cn(
          "text-[15px] leading-[1.45] [overflow-wrap:anywhere]",
          stage.tone === "alarm" ? "text-alarm" : stage.tone === "ok" ? "text-ok" : "text-ink",
        )}
      >
        {stage.headline}
      </p>
      {stage.detail !== null && (
        <p
          data-testid="xray-stage-detail"
          className="font-mono text-mono text-muted [overflow-wrap:anywhere]"
        >
          {stage.detail}
        </p>
      )}
      {stage.addressMatch !== null && (
        <p
          data-testid="xray-address-match"
          data-match={stage.addressMatch}
          className={cn("text-[13px]", stage.addressMatch ? "text-ok" : "text-alarm")}
        >
          {stage.addressMatch ? x.script.match : x.script.noMatch}
        </p>
      )}
      {stage.rows.length > 0 && <Rows rows={stage.rows} />}
      {stage.script && <Script script={stage.script} />}
      {stage.groups.map((group, index) => (
        <Group key={index} group={group} />
      ))}
      {stage.sources.length > 0 && (
        <details data-testid="xray-sources" className="text-[13px] text-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-line underline-offset-4 hover:text-ink">
            {x.sources(stage.sources.length)}
          </summary>
          <ol className="mt-1 flex flex-col gap-1.5 font-mono text-[12px] [overflow-wrap:anywhere]">
            {stage.sources.map((ref) => (
              <li key={ref} data-testid="xray-source">
                {ref}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Rows({ rows }: { rows: readonly XRayRow[] }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map((row, index) => (
        <div
          key={`${row.label}-${index}`}
          data-testid="xray-row"
          className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 desktop:flex-row desktop:items-baseline desktop:justify-between desktop:gap-4"
        >
          <dt className="shrink-0 text-[13px] text-muted">{row.label}</dt>
          <dd
            className={cn(
              "min-w-0 text-[14px] text-ink [overflow-wrap:anywhere] desktop:text-right",
              row.mono && "font-mono text-mono",
            )}
          >
            {row.url !== null ? (
              <a
                href={row.url}
                target="_blank"
                rel="noreferrer"
                title={row.ref}
                data-testid="xray-value"
                data-ref={row.ref}
                className="inline-flex min-h-11 items-center underline decoration-line underline-offset-4 hover:decoration-muted desktop:justify-end"
              >
                {row.value}
              </a>
            ) : (
              <span title={row.ref} data-testid="xray-value" data-ref={row.ref}>
                {row.value}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Group({ group }: { group: RowGroup }) {
  return (
    <section
      data-testid="xray-group"
      data-tone={group.tone}
      className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
    >
      <h3 className="font-mono text-mono font-medium text-ink [overflow-wrap:anywhere]">
        {group.title}
      </h3>
      {group.note !== null && (
        <p className={cn("text-[13px]", group.tone === "alarm" ? "text-alarm" : "text-muted")}>
          {group.note}
        </p>
      )}
      <Rows rows={group.rows} />
    </section>
  );
}

/** The op's script, decoded in this browser, its path's elements highlighted. */
function Script({ script }: { script: DecodedScript }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-label text-muted" title={script.ref}>
        {x.script.decoded(script.bytes)}
      </h3>
      <ol data-testid="xray-script" className="font-mono text-[12px]">
        {script.lines.map((line) => (
          <li
            key={line.offset}
            data-testid="xray-script-line"
            data-path={line.path ?? ""}
            data-on-path={line.onPath}
            title={script.ref}
            className={cn(
              "grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 rounded-[6px] px-1.5 py-0.5",
              line.onPath ? "bg-ok/8 text-ink" : "text-muted",
            )}
          >
            <span className="text-faint">{line.offset}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {line.name}
              {line.data !== null && <> {line.data}</>}
              {line.onPath && <span className="sr-only"> · {x.script.onPath}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
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
      <CardDescription className="max-w-[560px] [overflow-wrap:anywhere]">{body}</CardDescription>
      {children}
    </Card>
  );
}

/** Four dimmed stage cards while the first read is out. */
function PipelineSkeleton() {
  return (
    <div data-testid="xray-loading" aria-busy="true" className="flex flex-col gap-stack">
      <p className="sr-only">{x.loading}</p>
      {[x.stages.script, x.stages.rule, x.stages.mpc, x.stages.bitcoin].map((title, index) => (
        <div key={title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 desktop:gap-4">
          <span
            aria-hidden="true"
            className="mt-[14px] flex size-7 items-center justify-center rounded-full border border-line bg-page font-mono text-[12px] text-faint"
          >
            {index + 1}
          </span>
          <Card className="p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]">
            <h2 className="text-label text-muted">{title}</h2>
            <Skeleton className="mt-3 h-[18px] w-2/3" />
            <Skeleton className="mt-3 h-[18px] w-full" />
          </Card>
        </div>
      ))}
    </div>
  );
}

/** Bare `/xray`, or an input that names nothing: open an op or a refused call. */
function OpenXRay({ contractId }: { contractId: string }) {
  const { navigate } = useRouter();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const ids = { title: useId(), input: useId(), error: useId() };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = parseXRayEntry(value);
    if (path === null) {
      setInvalid(true);
      return;
    }
    navigate(path);
  };
  return (
    <Card
      role="region"
      aria-labelledby={ids.title}
      data-testid="xray-open"
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle id={ids.title}>{x.open.title}</CardTitle>
      <CardDescription className="max-w-[560px] [overflow-wrap:anywhere]">
        {x.open.body(contractId)}
      </CardDescription>
      <form noValidate onSubmit={submit} className="flex w-full max-w-[520px] flex-col gap-2">
        <label htmlFor={ids.input} className="text-label text-muted">
          {x.open.label}
        </label>
        <div className="flex flex-col gap-2 desktop:flex-row">
          <input
            id={ids.input}
            data-testid="xray-open-input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? ids.error : undefined}
            className="min-h-11 w-full min-w-0 rounded-[12px] border border-line bg-page px-3 font-mono text-[13px] text-ink aria-invalid:border-alarm"
          />
          <Button type="submit" variant="secondary">
            {x.open.submit}
          </Button>
        </div>
        {invalid && (
          <p id={ids.error} data-testid="xray-open-error" className="text-[13px] text-alarm">
            {x.open.invalid}
          </p>
        )}
      </form>
    </Card>
  );
}
