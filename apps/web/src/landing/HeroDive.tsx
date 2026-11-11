import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useAppData } from "@/app/data";
import { Link } from "@/app/router";
import { PROOF_PATH } from "@/app/routes";
import { HERO, HERO_GOLD, HERO_POSTER, HERO_VIDEO } from "./assets";
import { landingCopy } from "./copy";
import type { DemoView } from "./demo";
import { afterFirstContentfulPaint } from "./motion";
import { Picture } from "./Picture";
import { DesktopProduct, PhoneProduct } from "./ProductScreen";
import { useDive, useHeroVideo, type DiveRefs } from "./useDive";

const t = landingCopy.hero;

interface HeroDiveProps {
  demo: DemoView;
  onTry: () => void;
  onDownload: () => void;
  onRob: (event: MouseEvent<HTMLAnchorElement>) => void;
  reduced: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  navRef: RefObject<HTMLElement | null>;
  crispTry: RefObject<HTMLButtonElement | null>;
  mobTry: RefObject<HTMLButtonElement | null>;
}

// The sticky stage of the hero dive (mockup markup lines 205–250). The scene is a still with
// the dawn video over it; scrolling eases the camera into the laptop screen, where the real
// product is drawn. A crisp copy of it tracks the screen rectangle and takes over at the end
// (desktop), or the phone re-flow does (below 820 px).
export function HeroDive({
  demo,
  onTry,
  onDownload,
  onRob,
  reduced,
  scrollRef,
  navRef,
  crispTry,
  mobTry,
}: HeroDiveProps) {
  const { config } = useAppData();
  const world = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLImageElement>(null);
  const gold = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const screenApp = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const crisp = useRef<HTMLDivElement>(null);
  const crispApp = useRef<HTMLDivElement>(null);
  const mob = useRef<HTMLDivElement>(null);
  const headline = useRef<HTMLDivElement>(null);
  const legal = useRef<HTMLDivElement>(null);

  const refs = useMemo<DiveRefs>(
    () => ({
      scroll: scrollRef,
      world,
      scene,
      gold,
      video,
      dim,
      screen,
      screenApp,
      shade,
      crisp,
      crispApp,
      mob,
      headline,
      legal,
      nav: navRef,
    }),
    [scrollRef, navRef],
  );

  // The headline paints first, over the stage's sunrise-toned background; the scene still
  // (high priority) is asked for once that first contentful paint is on screen. The gold
  // still (it replaces the scene while zooming) and the dawn video wait until the scene has
  // loaded. So on a slow connection none of the 0.5 to 7 MB of media competes with the
  // headline, the page's LCP (story 9.5). Under reduced motion there is no video, so the gold
  // still never shows and is never requested. The three product layers (all transparent and
  // absolutely placed until the dive shows one) also wait for that paint, so the first render
  // on a slow CPU is the headline alone.
  const [painted, setPainted] = useState(false);
  useEffect(() => afterFirstContentfulPaint(() => setPainted(true)), []);
  const [sceneReady, setSceneReady] = useState(false);
  const onScene = () => setSceneReady(true);

  useDive(refs, reduced);
  useHeroVideo(video, HERO_VIDEO, HERO_POSTER, reduced, sceneReady);

  // On phones the X-Ray sits below the fold of the re-flowed product: bring it into view so
  // the attempt can be watched.
  const tryOnPhone = () => {
    onTry();
    const view = mob.current;
    const xray = view?.querySelector<HTMLElement>("[data-testid=xray]");
    if (!view || !xray) return;
    const bottom = xray.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom;
    if (bottom > 0) {
      view.scrollTo({ top: view.scrollTop + bottom + 14, behavior: reduced ? "auto" : "smooth" });
    }
  };

  const productLabel = demo.illustration
    ? `${t.productLabel}, ${landingCopy.hero.sampleNote}`
    : t.productLabel;

  return (
    <div className="l-scroll" ref={scrollRef} data-testid="landing-stage">
      <div className="l-stage">
        <div className="l-world" ref={world}>
          <Picture
            image={painted ? HERO : null}
            alt={t.sceneAlt}
            ref={scene}
            width={HERO.width}
            height={HERO.height}
            fetchPriority="high"
            decoding="async"
            onLoad={onScene}
            onError={onScene}
          />
          <Picture
            image={sceneReady && !reduced ? HERO_GOLD : null}
            alt=""
            aria-hidden="true"
            ref={gold}
            className="l-gold"
            width={HERO_GOLD.width}
            height={HERO_GOLD.height}
          />
          <video
            ref={video}
            muted
            playsInline
            autoPlay
            preload="auto"
            aria-hidden="true"
            tabIndex={-1}
          />
          <div className="l-dim" ref={dim} />
          <div className="l-screen" ref={screen} aria-hidden="true" inert>
            <div className="l-app" ref={screenApp}>
              {painted && <DesktopProduct demo={demo} />}
            </div>
          </div>
        </div>
        <div className="l-shade" ref={shade} />
        <div
          className="l-crisp"
          ref={crisp}
          id="app"
          role="region"
          aria-label={productLabel}
          data-testid="landing-crisp"
        >
          <div className="l-app" ref={crispApp}>
            {painted && (
              <DesktopProduct demo={demo} onTry={onTry} onDownload={onDownload} tryRef={crispTry} />
            )}
          </div>
        </div>
        <div
          className="l-mobview"
          ref={mob}
          role="region"
          aria-label={productLabel}
          data-testid="landing-mobview"
        >
          {painted && (
            <PhoneProduct demo={demo} onTry={tryOnPhone} onDownload={onDownload} tryRef={mobTry} />
          )}
        </div>
        <div className="l-headline" ref={headline}>
          <h1>{t.title}</h1>
          <p>{t.lede}</p>
          <div className="l-headline-row">
            <a className="l-pill l-pill-or" href="#app" onClick={onRob}>
              {t.rob}
            </a>
            <Link className="l-pill l-pill-glass" to={PROOF_PATH}>
              {t.readProof}
            </Link>
          </div>
        </div>
        <div className="l-legal" ref={legal}>
          {t.legal(config.network.btc, config.contract)}
        </div>
      </div>
    </div>
  );
}
