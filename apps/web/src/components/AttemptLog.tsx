import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

export interface AttemptRow {
  /** The attempt number in the round. */
  n: number;
  /** Absolute time of the attempt, e.g. `03:11`. */
  at: string;
  /** What was tried, e.g. `full withdrawal`. */
  action: string;
  outcome: { tone: "ok" | "alarm"; text: string };
  /** Set on a row that just arrived: it flashes once. */
  fresh?: boolean;
}

// The Challenge attempt log, newest first: number, time, action and an outcome tag. Hidden
// on phones, where the X-Ray carries the latest attempt (EXPERIENCE.md). Presentational: the
// round feed of stories 6.4 and 7.2 hands it rows.
export function AttemptLog({
  rows,
  className,
}: {
  rows: readonly AttemptRow[];
  className?: string;
}) {
  return (
    <Card
      data-testid="attempt-log"
      className={cn("hidden min-h-0 overflow-hidden px-[18px] py-[14px] desktop:block", className)}
    >
      <h3 className="mb-1.5 text-label text-muted">{copy.attemptLog.title}</h3>
      {rows.length === 0 ? (
        <p className="py-[9px] text-[14px] text-muted">{copy.attemptLog.empty}</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li
              key={row.n}
              data-testid="attempt-row"
              className={cn(
                "grid grid-cols-[44px_56px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-[9px] text-[14px] leading-[1.25] last:border-b-0",
                row.fresh && "animate-row-flash",
              )}
            >
              <span className="text-muted">#{row.n}</span>
              <span className="text-muted">{row.at}</span>
              <span className="truncate">{row.action}</span>
              <Badge variant={row.outcome.tone}>{row.outcome.text}</Badge>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
