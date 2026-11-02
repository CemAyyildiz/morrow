import { Card } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

/**
 * `pending` is dimmed (its data has not arrived), `done` is lit, `refused` and `ok` are lit
 * in the alarm and ok signals, `unreached` is dimmed and reads "not reached".
 */
export type XRayState = "pending" | "done" | "refused" | "ok" | "unreached";

export interface XRayStep {
  title: string;
  /** Mono detail: method names, error codes, paths, txids. */
  detail: string;
  state: XRayState;
}

// The X-Ray of one attempt: four numbered steps in order (Request → Contract rule → MPC
// co-signature → Bitcoin) joined by a connector line. Steps light up as their data arrives.
// Presentational: stories 6.4 and 7.2 feed it.
export function XRaySteps({
  steps,
  className,
}: {
  steps: readonly XRayStep[];
  className?: string;
}) {
  return (
    <Card
      data-testid="xray"
      className={cn("min-h-0 overflow-hidden px-[18px] py-[14px]", className)}
    >
      <h3 className="mb-2.5 text-label text-muted">{copy.xray.title}</h3>
      <ol>
        {steps.map((step, index) => {
          const lit = step.state === "done" || step.state === "refused" || step.state === "ok";
          return (
            <li
              key={index}
              data-testid="xray-step"
              data-state={step.state}
              className={cn(
                "relative grid grid-cols-[26px_minmax(0,1fr)] gap-3 py-[5px] leading-[1.25] transition-opacity duration-[350ms] motion-reduce:transition-none",
                lit ? "opacity-100" : "opacity-35",
                index < steps.length - 1 &&
                  "after:absolute after:top-8 after:-bottom-2 after:left-3 after:w-px after:bg-line",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-[25px] items-center justify-center rounded-full border bg-page font-mono text-[11px] font-medium",
                  step.state === "refused"
                    ? "border-alarm text-alarm"
                    : step.state === "ok"
                      ? "border-ok/40 text-ok"
                      : "border-line text-muted",
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <b
                  className={cn(
                    "mb-0.5 block text-[14px] font-medium",
                    step.state === "refused" && "text-alarm",
                  )}
                >
                  {step.title}
                </b>
                <span className="block truncate font-mono text-[12px] text-muted">
                  {step.state === "unreached" ? copy.xray.notReached : step.detail}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
