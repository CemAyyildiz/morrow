import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChallengeData } from "@/app/data";
import { copy } from "@/copy";
import { DayBars } from "./DayBars";
import { ProgressBar } from "./ProgressBar";

export interface HeroData {
  round: ChallengeData["round"];
  withdrawal: ChallengeData["withdrawal"];
  attempts: ChallengeData["attempts"];
}

const label = "text-label text-muted";
const ends = "mt-2.5 flex justify-between gap-4 text-[13px] text-muted";

// Two columns on desktop, one on phones: the next possible withdrawal with the delay
// progress, and the attempts made with the published keys. Leave `data` out for skeletons.
export function HeroCard({ data }: { data?: HeroData | undefined }) {
  return (
    <Card
      data-testid="hero"
      className="grid grid-cols-1 items-start gap-3 p-card-pad-mobile desktop:grid-cols-2 desktop:gap-10 desktop:px-[30px] desktop:py-[26px]"
    >
      <div className="min-w-0">
        {data ? (
          <>
            <div className={label}>{copy.challenge.nextWithdrawal}</div>
            <div className="animate-fade-in mt-2 mb-3.5 font-display text-numeral-hero max-desktop:text-[64px] desktop:mt-3 desktop:mb-[22px]">
              {data.withdrawal.time}
              <span className="ml-3 font-sans text-[20px] font-normal tracking-normal text-muted">
                {data.withdrawal.day}
              </span>
            </div>
            <ProgressBar value={data.withdrawal.elapsed} label={copy.challenge.delayElapsed} />
            <div className={ends}>
              <span>{copy.challenge.requested(data.withdrawal.requestedAt)}</span>
              <span>{copy.challenge.left(data.withdrawal.remaining)}</span>
            </div>
            <p className="mt-[18px] hidden max-w-[460px] text-[14.5px] leading-[1.55] text-muted desktop:block">
              {copy.challenge.explainer(data.withdrawal.time)}
            </p>
          </>
        ) : (
          <>
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-3 mb-[22px] h-16 w-60 desktop:h-[92px] desktop:w-80" />
            <ProgressBar label={copy.challenge.delayElapsed} />
            <Skeleton className="mt-2.5 h-4 w-full" />
          </>
        )}
      </div>
      <div className="min-w-0">
        {data ? (
          <>
            <div className={label}>{copy.challenge.attemptsLabel}</div>
            <div className="mt-3 mb-2.5 flex items-baseline gap-2.5">
              <b
                data-testid="attempts-count"
                className="animate-fade-in font-display text-[40px] leading-none font-light tracking-[-0.04em] desktop:text-[56px]"
              >
                {data.attempts.count}
              </b>
              <span className="text-[15px] text-muted">
                {copy.challenge.attemptsUnit(data.attempts.count, data.attempts.satsOut)}
              </span>
            </div>
            <DayBars hours={data.attempts.hourly} className="mt-1.5" />
            <div className={ends}>
              <span>{copy.challenge.attemptsWindow(data.round)}</span>
              <span>{copy.challenge.lastAttempt(data.attempts.lastAt)}</span>
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-4 w-52" />
            <Skeleton className="mt-3 mb-2.5 h-10 w-36 desktop:h-14" />
            <DayBars className="mt-1.5" />
            <Skeleton className="mt-2.5 h-4 w-full" />
          </>
        )}
      </div>
    </Card>
  );
}
