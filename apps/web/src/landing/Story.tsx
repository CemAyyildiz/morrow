import { useRef } from "react";
import { Link } from "@/app/router";
import { LIVE_PATHS } from "@/app/routes";
import { LIVE_VAULT_PATH, VAULT_NEW_PATH } from "@/app/wallet-paths";
import { landingCopy } from "./copy";
import { useReveal } from "./motion";

const t = landingCopy.story;

/** Every source opens in a new tab and tells the destination nothing about this page. */
export const SOURCE_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;

export type DoorId = keyof typeof t.doors;

/** The three doors, in order, each with the product path it leads to. */
export const DOORS: readonly { id: DoorId; path: string }[] = [
  // "Try it with test coins" opens the wallet page with a full page load (its own CSP), and
  // "Watch a live Vault" opens the live example's page the same way.
  { id: "create", path: "/vault" },
  { id: "live", path: "/vault" },
  { id: "proof", path: "/proof" },
];

/** The doors whose destination is live; the others are left out, not shown disabled. */
export function liveDoors(live: ReadonlySet<string> = LIVE_PATHS) {
  return DOORS.filter((door) => live.has(door.path));
}

interface StoryProps {
  reduced: boolean;
}

// Story 9.2, straight after the hero dive: why a Bitcoin time-lock safe did not exist before,
// in three dated beats with one source each, then the doors into the product. The beats fade
// in on scroll (motion.ts `useReveal`); reduced motion shows them at once.
export function Story({ reduced }: StoryProps) {
  const section = useRef<HTMLElement>(null);
  useReveal(section, reduced);
  return (
    <section
      className="l-story"
      id="story"
      ref={section}
      aria-labelledby="l-story-title"
      data-testid="landing-story"
    >
      <h2 id="l-story-title">{t.title}</h2>
      <Beats />
      <Doors />
    </section>
  );
}

/** The three beats, as an ordered list: era, claim, support, source. */
export function Beats() {
  return (
    <ol className="l-beats">
      {t.beats.map((beat) => (
        <li key={beat.era} className="l-beat" data-reveal-item="" data-testid="story-beat">
          <p className="l-era">{beat.era}</p>
          <h3>{beat.claim}</h3>
          <p className="l-beat-body">{beat.support}</p>
          <a className="l-source" href={beat.source.url} {...SOURCE_LINK}>
            {beat.source.label}
            <span className="sr-only">{t.newTab}</span>
            <Arrow out />
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The live doors, in order; `live` defaults to the route flag list. */
export function Doors({ live = LIVE_PATHS }: { live?: ReadonlySet<string> }) {
  const doors = liveDoors(live);
  if (doors.length === 0) return null;
  return (
    <ul className="l-doors" aria-label={t.doorsLabel} data-testid="story-doors">
      {doors.map(({ id, path }) => {
        const door = t.doors[id];
        const inner = (
          <>
            <span>
              <b>{door.label}</b>
              <span className="l-door-detail">{door.detail}</span>
            </span>
            <Arrow />
          </>
        );
        return (
          <li key={id}>
            {id === "create" ? (
              <a className="l-door l-door-or" href={VAULT_NEW_PATH}>
                {inner}
              </a>
            ) : id === "live" ? (
              <a className="l-door" href={LIVE_VAULT_PATH}>
                {inner}
              </a>
            ) : (
              <Link className="l-door" to={path}>
                {inner}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Up and out for a source in a new tab, straight ahead for a door into the product. */
function Arrow({ out = false }: { out?: boolean }) {
  return (
    <svg className="l-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d={out ? "M3 11 11 3M5 3h6v6" : "M2 7h10M8 3l4 4-4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
