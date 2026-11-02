import type { MouseEvent } from "react";
import { HERO_GOLD } from "./assets";
import { landingCopy } from "./copy";
import { Picture } from "./Picture";

const t = landingCopy.final;

// "Tomorrow, it's still yours.": the full-bleed sunrise with the primary call to action.
export function Final({ onRob }: { onRob: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <section className="l-final" aria-labelledby="l-final-title">
      <Picture image={HERO_GOLD} alt={t.alt} loading="lazy" />
      <div className="l-final-in">
        <h2 id="l-final-title">{t.title}</h2>
        <p>{t.body}</p>
        <a className="l-pill l-pill-or" href="#app" onClick={onRob}>
          {t.rob}
        </a>
      </div>
    </section>
  );
}
