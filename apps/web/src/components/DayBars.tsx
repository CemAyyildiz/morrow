import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

interface DayBarsProps {
  /** Attempts per hour, oldest first. Leave out for the skeleton state. */
  hours?: readonly number[] | undefined;
  className?: string;
}

const WIDTH = 480;
const HEIGHT = 120;

/** Bar height in the 480 × 120 viewBox: empty hours are 4-unit stubs. */
export function barHeight(value: number): number {
  return value > 0 ? Math.min(HEIGHT, 18 + value * 28) : 4;
}

// 24 hourly bars: filled hours in `ink` (stronger with more attempts), empty hours as
// `faint` stubs. The chart is decorative; a text equivalent sits beside it.
export function DayBars({ hours, className }: DayBarsProps) {
  if (!hours) return <Skeleton className={cn("h-[70px] desktop:h-[120px]", className)} />;

  const step = WIDTH / Math.max(1, hours.length);
  const total = hours.reduce((sum, value) => sum + value, 0);
  const active = hours.filter((value) => value > 0).length;
  const peak = Math.max(0, ...hours);

  return (
    <div className={cn("h-[70px] desktop:h-[120px]", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        className="block size-full"
      >
        {hours.map((value, index) => {
          const height = barHeight(value);
          return (
            <rect
              key={index}
              x={index * step + 3}
              y={HEIGHT - height}
              width={step - 6}
              height={height}
              rx="3"
              className={value > 0 ? "fill-ink" : "fill-faint"}
              opacity={value > 0 ? Math.min(1, 0.55 + 0.15 * value) : 1}
            />
          );
        })}
      </svg>
      <p className="sr-only">{copy.challenge.hourlySummary(total, active, peak)}</p>
    </div>
  );
}
