import { useEffect, useRef } from "react";
import { TILE, type Tile, type TileName } from "./assets";
import { landingCopy } from "./copy";
import { collagePose, trackProgress } from "./motion";
import { Picture } from "./Picture";

const t = landingCopy.collage;

/** Parallax speed per tile, from the mockup's `data-s`. */
const SPEED: Record<TileName, number> = {
  timelock: -0.35,
  emma: 0.45,
  vaultdoor: -0.2,
  nightphone: 0.3,
  drawer: -0.4,
  clouds: 0.2,
};
const CLOCK_SPEED = 0.25;

// The cream collage: sticky for 300 vh while the phone with the 03:10 Guardian Alert rotates,
// the "NOT BEFORE TOMORROW" marquee slides and the photo tiles drift with parallax, all driven
// by scroll through the CSSOM. Reduced motion holds every piece still (motion.ts).
export function Collage({ reduced }: { reduced: boolean }) {
  const section = useRef<HTMLElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const phone = useRef<HTMLDivElement>(null);
  const tiles = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const frame = () => {
      const el = section.current;
      if (!el) return;
      const progress = trackProgress(
        el.getBoundingClientRect().top,
        el.offsetHeight,
        window.innerHeight,
      );
      const pose = collagePose(progress, window.innerWidth, window.innerHeight, reduced);
      if (marquee.current) marquee.current.style.transform = `translate(${pose.marqueeX}px,-50%)`;
      if (phone.current) {
        const [y, x, z] = pose.phone;
        phone.current.style.transform = `rotateY(${y}deg) rotateX(${x}deg) rotateZ(${z}deg)`;
      }
      for (const tile of tiles.current) {
        if (!tile) continue;
        tile.style.transform = `translateY(${pose.tileY(Number(tile.dataset.speed))}px)`;
      }
    };
    frame();
    window.addEventListener("scroll", frame, { passive: true });
    window.addEventListener("resize", frame);
    return () => {
      window.removeEventListener("scroll", frame);
      window.removeEventListener("resize", frame);
    };
  }, [reduced]);

  const tileRef = (index: number) => (el: HTMLDivElement | null) => {
    tiles.current[index] = el;
  };

  return (
    <section className="l-collage" ref={section} aria-label={t.top[1]}>
      <div className="l-cstage">
        <p className="l-cmono l-cmono-top">
          <span aria-hidden="true">{t.top[0]}</span>
          <br />
          {t.top[1]}
          <br />
          {t.top[2]}
        </p>
        <div className="l-marq" ref={marquee} aria-hidden="true">
          {t.marquee}
        </div>
        <PhotoTile tile={TILE.timelock} ref={tileRef(0)} />
        <div
          className="l-tile l-tile-sw l-tile-clock"
          data-speed={CLOCK_SPEED}
          ref={tileRef(1)}
          aria-hidden="true"
        >
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="30" fill="none" stroke="#16151A" strokeWidth="6" />
            <path
              d="M50 30v22l13 8"
              stroke="#16151A"
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <PhotoTile tile={TILE.emma} ref={tileRef(2)} />
        <PhotoTile tile={TILE.vaultdoor} ref={tileRef(3)} />
        <PhotoTile tile={TILE.nightphone} ref={tileRef(4)} />
        <PhotoTile tile={TILE.drawer} ref={tileRef(5)} />
        <PhotoTile tile={TILE.clouds} ref={tileRef(6)} />
        <div className="l-phone3d" aria-hidden="true">
          <div className="l-phone-body" ref={phone}>
            <div className="l-notch" />
            <div className="l-lock">{t.phone.time}</div>
            <div className="l-date">{t.phone.date}</div>
            <div className="l-note">
              <div className="l-note-t">
                <span>{t.phone.source}</span>
                <span>{t.phone.when}</span>
              </div>
              <b>{t.phone.title}</b>
              {t.phone.body}
              <div className="l-act">
                <span className="l-r">{t.phone.sendHome}</span>
                <span>{t.phone.itWasDaniel}</span>
              </div>
            </div>
          </div>
        </div>
        <p className="l-cmono l-cmono-bot">
          {t.bottom[0]}
          <br />
          <span aria-hidden="true">{t.bottom[1]}</span>
        </p>
      </div>
    </section>
  );
}

function PhotoTile({ tile, ref }: { tile: Tile; ref: (el: HTMLDivElement | null) => void }) {
  return (
    <div className={`l-tile l-tile-${tile.name}`} data-speed={SPEED[tile.name]} ref={ref}>
      <Picture image={tile.image} alt={t.tiles[tile.name]} loading="lazy" />
    </div>
  );
}
