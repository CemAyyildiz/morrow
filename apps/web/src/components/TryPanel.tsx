import { useEffect, useId, useRef, useState, type Ref } from "react";
import type { TryControl } from "@/app/useChallengeFeed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { XRaySteps } from "@/components/XRaySteps";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { useAnnounce } from "@/shell/announce";

const t = copy.tryKeys;

/** `aria-disabled` keeps a button in the Tab order, so its reason can still be reached. */
const softDisabled = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const link =
  "inline-flex min-h-11 items-center rounded-full px-1.5 text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink";

// "Try with these keys" on the Challenge screen (story 7.2b): the destination (a random
// address made in this browser by default, editable), the two attempts with the reason each is
// disabled, and the X-Ray of the latest attempt, on by default. The steps are announced through
// the shell's polite live region.
export function TryPanel({
  attempt,
  panelRef,
}: {
  attempt: TryControl;
  panelRef?: Ref<HTMLDivElement>;
}) {
  const [xray, setXray] = useState(true);
  const id = useId();
  const ids = {
    title: `${id}-title`,
    destination: `${id}-destination`,
    help: `${id}-help`,
    error: `${id}-error`,
    request: `${id}-request`,
    execute: `${id}-execute`,
  };

  const announce = useAnnounce();
  const last = useRef("");
  useEffect(() => {
    const text = attempt.announcement;
    // Keyed by attempt: a second attempt with the same words is read out again.
    const said = `${attempt.attemptId ?? ""}:${text}`;
    if (text === "" || said === last.current) return;
    last.current = said;
    announce(text);
  }, [attempt.announcement, attempt.attemptId, announce]);

  const { request, execute } = attempt;
  const executeNote =
    execute.reason ?? (execute.target === null ? null : t.executeTarget(execute.target));

  return (
    <Card
      ref={panelRef}
      data-testid="try-panel"
      aria-labelledby={ids.title}
      role="region"
      aria-busy={attempt.busy}
      className="flex flex-col gap-4 p-card-pad-mobile desktop:p-card-pad"
    >
      <div className="flex items-center justify-between gap-3">
        <CardTitle id={ids.title}>{t.title}</CardTitle>
        <Button
          variant="secondary"
          aria-pressed={xray}
          data-testid="xray-toggle"
          className="aria-pressed:border-muted aria-[pressed=false]:text-muted"
          onClick={() => setXray((on) => !on)}
        >
          {t.xrayToggle}
        </Button>
      </div>
      <p className="max-w-[640px] text-[14px] text-muted">{t.intro}</p>
      <div className={cn("grid gap-4", xray && "desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor={ids.destination} className="text-[14px] font-medium">
              {t.destination}
            </label>
            {attempt.isRandom && (
              <Badge variant="chip" data-testid="destination-random">
                {t.randomTag}
              </Badge>
            )}
          </div>
          <input
            id={ids.destination}
            data-testid="try-destination"
            value={attempt.destination}
            onChange={(event) => attempt.setDestination(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={attempt.destinationError !== null}
            aria-describedby={
              attempt.destinationError === null ? ids.help : `${ids.error} ${ids.help}`
            }
            className="min-h-11 w-full rounded-[12px] border border-line bg-page px-3 font-mono text-[13px] text-ink aria-invalid:border-alarm"
          />
          {attempt.destinationError !== null && (
            <p
              id={ids.error}
              data-testid="try-destination-error"
              className="text-[13px] text-alarm"
            >
              {attempt.destinationError}
            </p>
          )}
          <p id={ids.help} className="text-[13px] text-muted">
            {t.destinationHelp}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              data-testid="try-request"
              aria-disabled={!request.enabled}
              aria-describedby={request.reason === null ? undefined : ids.request}
              className={softDisabled}
              onClick={() => request.enabled && attempt.run("request")}
            >
              {t.requestFull}
            </Button>
            <Button
              variant="secondary"
              data-testid="try-execute"
              aria-disabled={!execute.enabled}
              aria-describedby={
                executeNote === null
                  ? undefined
                  : executeNote === request.reason
                    ? ids.request
                    : ids.execute
              }
              className={softDisabled}
              onClick={() => execute.enabled && attempt.run("execute")}
            >
              {t.executeEarly}
            </Button>
          </div>
          {request.reason !== null && (
            <p id={ids.request} data-testid="try-request-reason" className="text-[13px] text-muted">
              {request.reason}
            </p>
          )}
          {executeNote !== null && executeNote !== request.reason && (
            <p id={ids.execute} data-testid="try-execute-reason" className="text-[13px] text-muted">
              {executeNote}
            </p>
          )}
          {attempt.notice !== null && (
            <p
              data-testid="try-notice"
              className={cn(
                "text-[14px]",
                attempt.notice.tone === "alarm" ? "text-alarm" : "text-ink",
              )}
            >
              {attempt.notice.text}
            </p>
          )}
        </div>
        {xray && (
          <div className="flex min-w-0 flex-col gap-2">
            <XRaySteps steps={attempt.steps} wrap />
            {(attempt.links.near !== null ||
              attempt.links.bitcoin !== null ||
              attempt.links.xray !== null) && (
              <div className="flex flex-wrap gap-2" data-testid="try-links">
                {[attempt.links.near, attempt.links.bitcoin, attempt.links.xray].map(
                  (l) =>
                    l !== null && (
                      <a
                        key={l.href}
                        href={l.href}
                        aria-label={l.label}
                        target="_blank"
                        rel="noreferrer"
                        className={link}
                      >
                        {l.text}
                      </a>
                    ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
