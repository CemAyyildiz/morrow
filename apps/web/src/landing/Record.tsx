import { useAppData } from "@/app/data";
import { landingCopy } from "./copy";

const t = landingCopy.record;

// The record line. With a live round whose Attempt Log has answered, the mockup's sentence
// with the real counts over every round: attempts in total and the sats that left (0, or the
// real number).
// Without a feed it keeps the no-number fallback: no count is ever invented.
export function Record() {
  const { challenge } = useAppData();
  const live =
    challenge?.attempts && challenge.satsTaken !== null
      ? { total: challenge.attempts.total, sats: challenge.satsTaken, round: challenge.round }
      : null;
  return (
    <section className="l-record" aria-label={t.by} data-testid="record">
      <blockquote>
        {live ? t.live.lead(live.total) : t.lead}
        <br />
        <em>{live ? t.live.em(live.sats) : t.em}</em>
        {live ? t.live.tail : t.tail}
      </blockquote>
      <div className="l-by">
        {t.by}
        <span>{live ? t.live.byDetail(live.round) : t.byDetail}</span>
      </div>
    </section>
  );
}
