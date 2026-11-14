import { VAULT_NEW_PATH } from "@/app/wallet-paths";
import { HERO_GOLD } from "./assets";
import { landingCopy } from "./copy";
import { Picture } from "./Picture";

const t = landingCopy.final;

// "Tomorrow, it's still yours.": the full-bleed sunrise with the primary call to action.
export function Final() {
  return (
    <section className="l-final" aria-labelledby="l-final-title">
      <Picture image={HERO_GOLD} alt={t.alt} loading="lazy" />
      <div className="l-final-in">
        <h2 id="l-final-title">{t.title}</h2>
        <p>{t.body}</p>
        {/* A full page load: the wallet page runs under its own CSP. */}
        <a className="l-pill l-pill-or" href={VAULT_NEW_PATH}>
          {t.tryIt}
        </a>
      </div>
    </section>
  );
}
