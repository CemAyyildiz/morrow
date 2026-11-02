import { useId } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** 0 to 1. Leave out for the skeleton state. */
  value?: number | undefined;
  label: string;
  className?: string;
}

// A 6 px bar, `line` track and a `faint → ink` fill. Drawn in SVG so the width needs no
// inline style (the CSP of story 1.9b forbids style attributes).
export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const gradientId = `progress-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  if (value === undefined) return <Skeleton className={cn("h-1.5 rounded-full", className)} />;

  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1.5", className)}
    >
      <svg width="100%" height="6" aria-hidden="true" focusable="false" className="block">
        <defs>
          <linearGradient id={gradientId}>
            <stop offset="0" className="[stop-color:var(--color-faint)]" />
            <stop offset="1" className="[stop-color:var(--color-ink)]" />
          </linearGradient>
        </defs>
        <rect width="100%" height="6" rx="3" className="fill-line" />
        {percent > 0 && (
          <rect width={`${percent}%`} height="6" rx="3" fill={`url(#${gradientId})`} />
        )}
      </svg>
    </div>
  );
}
