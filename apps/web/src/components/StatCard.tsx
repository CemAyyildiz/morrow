import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label?: string | undefined;
  /** Leave out for the skeleton state. */
  value?: string | undefined;
  unit?: string | undefined;
  tone?: "default" | "ok";
  /** Decoration beside the value, e.g. the co-signer dot grid. */
  aside?: ReactNode;
}

// Label on top, a light tabular numeral below, an optional muted unit.
export function StatCard({ label, value, unit, tone = "default", aside }: StatCardProps) {
  return (
    <Card
      data-testid="stat"
      className="flex min-w-0 items-end justify-between gap-3 px-3.5 py-3 desktop:px-[18px] desktop:py-[14px]"
    >
      <div className="min-w-0">
        {label === undefined || value === undefined ? (
          <>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2.5 h-[22px] w-28 desktop:h-[30px]" />
          </>
        ) : (
          <>
            <div className="text-label text-muted">{label}</div>
            <div
              className={cn(
                "animate-fade-in mt-2.5 flex min-w-0 flex-col font-display text-numeral whitespace-nowrap max-desktop:text-[22px] desktop:flex-row desktop:items-baseline",
                tone === "ok" && "text-ok",
              )}
            >
              <span data-testid="stat-value" className="min-w-0 truncate" title={value}>
                {value}
              </span>
              {unit !== undefined && (
                <small className="shrink-0 font-sans text-[13px] font-normal tracking-normal text-muted max-desktop:mt-1 desktop:ml-2">
                  {unit}
                </small>
              )}
            </div>
          </>
        )}
      </div>
      {value !== undefined && aside}
    </Card>
  );
}

/** The co-signer threshold as a dot grid: `on` dots in `ink`, the rest in `line`. */
export function DotGrid({ on, total }: { on: number; total: number }) {
  return (
    <div
      aria-hidden="true"
      className="hidden shrink-0 grid-cols-[repeat(8,8px)] gap-[5px] desktop:grid"
    >
      {Array.from({ length: total }, (_, index) => (
        <i key={index} className={cn("size-2 rounded-full", index < on ? "bg-ink" : "bg-line")} />
      ))}
    </div>
  );
}
