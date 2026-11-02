import { landingCopy } from "./copy";

const t = landingCopy.record;

// The record line. The mockup's count ("Thirteen people tried…") is not live yet, so this is
// the no-number fallback; story 9.4 wires the live count from the Attempt Log.
export function Record() {
  return (
    <section className="l-record" aria-label={t.by}>
      <blockquote>
        {t.lead}
        <br />
        <em>{t.em}</em>
        {t.tail}
      </blockquote>
      <div className="l-by">
        {t.by}
        <span>{t.byDetail}</span>
      </div>
    </section>
  );
}
