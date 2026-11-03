import type { AttemptRow } from "@/app/data";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

export type { AttemptRow } from "@/app/data";

/** Row grids: number, time (by its widest form), action, [links,] outcome. */
const COLUMNS = {
  plain: {
    time: "grid-cols-[44px_56px_minmax(0,1fr)_auto]",
    dated: "grid-cols-[44px_96px_minmax(0,1fr)_auto]",
    year: "grid-cols-[44px_136px_minmax(0,1fr)_auto]",
  },
  links: {
    time: "grid-cols-[44px_56px_minmax(0,1fr)_auto_auto]",
    dated: "grid-cols-[44px_96px_minmax(0,1fr)_auto_auto]",
    year: "grid-cols-[44px_136px_minmax(0,1fr)_auto_auto]",
  },
} as const;

const link =
  "inline-flex min-h-11 items-center rounded-full px-1.5 text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink";

// The Challenge attempt log, newest first: number, time, action, explorer links and an
// outcome tag. Hidden on phones, where the X-Ray carries the latest attempt (EXPERIENCE.md).
// Presentational: the challenge feed (story 7.2) and the landing illustration hand it rows;
// `rows` null shows skeleton lines until the feed answers.
export function AttemptLog({
  rows,
  className,
}: {
  rows: readonly AttemptRow[] | null;
  className?: string;
}) {
  // A time with a date (`13 Nov 06:12`) needs a wider column than `06:12`, and one with a
  // year (`2 Jan 2027 03:04`) a wider one still.
  const width = rows?.some((row) => row.at.length > 12)
    ? "year"
    : rows?.some((row) => row.at.length > 5)
      ? "dated"
      : "time";
  const withLinks = rows?.some((row) => row.links !== undefined) ?? false;
  return (
    <Card
      data-testid="attempt-log"
      className={cn("hidden min-h-0 overflow-hidden px-[18px] py-[14px] desktop:block", className)}
    >
      <h3 className="mb-1.5 text-label text-muted">{copy.attemptLog.title}</h3>
      {rows === null ? (
        <div aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="my-[9px] h-[18px] w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-[9px] text-[14px] text-muted">{copy.attemptLog.empty}</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li
              key={row.key ?? row.n}
              data-testid="attempt-row"
              className={cn(
                "grid items-center gap-3 border-b border-line text-[14px] leading-[1.25] last:border-b-0",
                // Links are 44 px targets: they set the row height instead of the padding.
                withLinks ? "min-h-11 py-0" : "py-[9px]",
                withLinks ? COLUMNS.links[width] : COLUMNS.plain[width],
                row.fresh && "animate-row-flash",
              )}
            >
              <span className="text-muted">#{row.n}</span>
              <span className="text-muted">{row.at}</span>
              <span className="truncate">
                {row.action}
                {row.round !== undefined && (
                  <span className="ml-2 text-[13px] text-muted">
                    {copy.attemptLog.roundTag(row.round)}
                  </span>
                )}
              </span>
              {withLinks && (
                <span data-testid="attempt-links" className="flex items-center gap-1">
                  {row.links?.near && (
                    <a
                      className={link}
                      href={row.links.near.href}
                      aria-label={row.links.near.label}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.links.near.text}
                    </a>
                  )}
                  {row.links?.bitcoin && (
                    <a
                      className={link}
                      href={row.links.bitcoin.href}
                      aria-label={row.links.bitcoin.label}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.links.bitcoin.text}
                    </a>
                  )}
                </span>
              )}
              <Badge
                variant={row.outcome.tone === "neutral" ? "chip" : row.outcome.tone}
                className="max-w-[260px]"
                title={row.outcome.text}
              >
                <span className="truncate">{row.outcome.text}</span>
              </Badge>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
