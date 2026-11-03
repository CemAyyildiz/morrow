import { useCallback, useRef, type MouseEvent } from "react";
import { downloadKeys } from "@/app/challenge";
import { useAppData } from "@/app/data";
import { useRouter } from "@/app/router";
import { HOME_PATH } from "@/app/routes";
import { Cards } from "./Cards";
import { Collage } from "./Collage";
import { landingCopy } from "./copy";
import { useAttemptDemo } from "./demo";
import { Features } from "./Features";
import { Final } from "./Final";
import { HeroDive } from "./HeroDive";
import { useReducedMotion } from "@/lib/motion";
import { Record } from "./Record";
import { Story } from "./Story";
import { PHONE_BELOW, robTarget } from "./useDive";
import "./landing.css";

const t = landingCopy;

/** How long "Rob this vault" may wait for the scroll and a live product before giving up on focus. */
const SCROLL_SETTLE_MS = 2000;

// The public landing at `/`, ported from the approved mockup: hero dive into the live product,
// the feature accordion, the cream collage, the record line, the cards and the final sunrise.
// Full-bleed, outside the app shell. Runs under the strict CSP: no inline styles in markup,
// motion goes through refs and the CSSOM.
export function Landing() {
  const { config, challenge, attempt } = useAppData();
  const reduced = useReducedMotion();
  const { navigate } = useRouter();
  const demo = useAttemptDemo(challenge, attempt);
  const openChallenge = useCallback(() => navigate(HOME_PATH), [navigate]);
  // A live round is never simulated on: "Try" sends the real full-balance request in place, to
  // a random address made in this browser (UJ-8). When it cannot be sent, the Challenge screen
  // says why.
  const tryLive = useCallback(() => {
    if (attempt?.busy) return;
    if (attempt?.request.enabled) attempt.run("request", { random: true });
    else openChallenge();
  }, [attempt, openChallenge]);
  const onTry = demo.illustration ? demo.run : tryLive;
  // A live round's keys download here too; the illustration has none and opens the product.
  const keys = challenge?.keys ?? null;
  const onDownload = useCallback(
    () => (keys ? downloadKeys(keys) : openChallenge()),
    [keys, openChallenge],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const crispTry = useRef<HTMLButtonElement>(null);
  const mobTry = useRef<HTMLButtonElement>(null);

  // "Rob this vault": scroll to the product end of the dive, then hand keyboard focus to
  // "Try with these keys" once that copy of the product is live.
  const rob = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const stage = scrollRef.current;
      if (!stage) return;
      const top = robTarget(
        stage.getBoundingClientRect().top + window.scrollY,
        stage.offsetHeight,
        window.innerHeight,
      );
      const deadline = performance.now() + SCROLL_SETTLE_MS;
      let finished = false;
      let timer = 0;
      let frame = 0;
      const finish = () => {
        finished = true;
        window.removeEventListener("scrollend", onSettled);
        window.clearTimeout(timer);
        window.cancelAnimationFrame(frame);
      };
      // Focus only a copy that is live (not inert); retry each frame until the deadline.
      const focusTry = () => {
        if (finished) return;
        const button = window.innerWidth < PHONE_BELOW ? mobTry.current : crispTry.current;
        if (button && !button.closest("[inert]")) {
          finish();
          button.focus({ preventScroll: true });
        } else if (performance.now() >= deadline) {
          finish();
        } else {
          frame = window.requestAnimationFrame(focusTry);
        }
      };
      function onSettled() {
        window.removeEventListener("scrollend", onSettled);
        focusTry();
      }
      const atTarget = Math.abs(window.scrollY - top) < 1;
      window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
      if (reduced || atTarget) {
        focusTry();
      } else {
        window.addEventListener("scrollend", onSettled);
        timer = window.setTimeout(() => {
          window.removeEventListener("scrollend", onSettled);
          focusTry();
          finish();
        }, SCROLL_SETTLE_MS);
      }
    },
    [reduced],
  );

  const toTop = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="landing">
      <nav className="l-nav" ref={navRef} aria-label={t.nav.label}>
        <a className="l-mark" href="/" onClick={toTop}>
          {t.wordmark}
        </a>
        <div className="l-links">
          <a href="#why">{t.nav.howItWorks}</a>
          <a href="#app" onClick={rob}>
            {t.nav.rob}
          </a>
          <a href="#why">{t.nav.proof}</a>
          <a href={t.githubUrl} rel="noreferrer">
            {t.nav.github}
          </a>
        </div>
        <a className="l-pill l-pill-or" href="#app" onClick={rob}>
          {t.nav.rob}
        </a>
      </nav>
      <main>
        <HeroDive
          demo={demo}
          onTry={onTry}
          onDownload={onDownload}
          onRob={rob}
          reduced={reduced}
          scrollRef={scrollRef}
          navRef={navRef}
          crispTry={crispTry}
          mobTry={mobTry}
        />
        <Story onRob={rob} reduced={reduced} />
        <Features reduced={reduced} />
        <Collage reduced={reduced} />
        <Record />
        <Cards />
        <Final onRob={rob} />
      </main>
      <footer className="l-footer">
        <span>{t.footer.left}</span>
        <span>{t.footer.right(config.network.btc)}</span>
      </footer>
      <div aria-live="polite" className="sr-only" data-testid="live-region">
        <p>{demo.announcement}</p>
      </div>
    </div>
  );
}
