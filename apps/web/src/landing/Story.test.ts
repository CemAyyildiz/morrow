import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { LIVE_PATHS } from "@/app/routes";
import { landingCopy } from "./copy";
import { alreadySeen, shouldReveal } from "./motion";
import { Beats, Doors, DOORS, liveDoors, SOURCE_LINK } from "./Story";

const ids = (doors: readonly { id: string }[]) => doors.map((door) => door.id);

describe("story beats", () => {
  const html = renderToStaticMarkup(createElement(Beats));
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);

  it("render as one ordered list of three beats", () => {
    expect(html.startsWith("<ol")).toBe(true);
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html.match(/<h3>/g)).toHaveLength(3);
  });

  it("link each beat to its https source in a new tab, without opener or referrer", () => {
    expect(SOURCE_LINK).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(links).toHaveLength(3);
    landingCopy.story.beats.forEach((beat, index) => {
      const link = links[index];
      expect(link).toContain(`href="${beat.source.url}"`);
      expect(link).toMatch(/href="https:\/\//);
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    });
  });

  it("name each source in the link text and say it opens a new tab", () => {
    for (const beat of landingCopy.story.beats) {
      expect(html).toContain(`${beat.source.label}<span class="sr-only"> (opens in a new tab)`);
    }
  });

  it("carry no inline style", () => {
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("story doors", () => {
  it("keeps the three doors in order: create, live, proof", () => {
    expect(DOORS).toEqual([
      { id: "create", path: "/vault" },
      { id: "live", path: "/vault" },
      { id: "proof", path: "/proof" },
    ]);
  });

  it("shows only the doors whose destination is live; today all three", () => {
    expect([...LIVE_PATHS]).toEqual(["/challenge", "/vault", "/proof"]);
    expect(ids(liveDoors())).toEqual(["create", "live", "proof"]);
  });

  it("adds a door once its path is flagged live, with no other change", () => {
    expect(ids(liveDoors(new Set(["/challenge", "/vault"])))).toEqual(["create", "live"]);
    expect(ids(liveDoors(new Set(["/proof", "/challenge"])))).toEqual(["proof"]);
    expect(ids(liveDoors(new Set(["/vault"])))).toEqual(["create", "live"]);
    expect(liveDoors(new Set())).toEqual([]);
  });
});

describe("story doors, rendered", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The doors' markup for a set of live paths, inside a router on `/`. */
  function render(live: ReadonlySet<string>) {
    // The router reads only the current path while rendering; there is no DOM here.
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const doors = createElement(Doors, { live });
    const html = renderToStaticMarkup(
      createElement(RouterProvider, { redirects: {}, children: doors }),
    );
    return { html, items: [...html.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1]!) };
  }

  it("draws exactly one door while only the Proof is live", () => {
    const { items } = render(new Set(["/proof"]));
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('href="/proof"');
  });

  it("draws Try it first, then the live Vault, then Read the proof, with today's live paths", () => {
    const { items } = render(LIVE_PATHS);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('href="/vault/new"');
    expect(items[0]).toContain(landingCopy.story.doors.create.label);
    expect(items[0]).toContain(landingCopy.story.doors.create.detail);
    expect(items[1]).toContain('href="/vault/176"');
    expect(items[1]).toContain(landingCopy.story.doors.live.label);
    expect(items[2]).toContain('href="/proof"');
    expect(items[2]).toContain(landingCopy.story.doors.proof.label);
  });

  it("leaves out a door whose path is not live", () => {
    const { html, items } = render(new Set(["/challenge", "/vault"]));
    expect(items).toHaveLength(2);
    expect(html).not.toContain(landingCopy.story.doors.proof.label);
  });
});

describe("story reveal", () => {
  it("hides beats for the fade only with motion allowed and an observer", () => {
    expect(shouldReveal(false, true)).toBe(true);
    expect(shouldReveal(true, true)).toBe(false);
    expect(shouldReveal(false, false)).toBe(false);
  });

  it("shows items already in or above the viewport at once, without a fade", () => {
    expect(alreadySeen(-400, 930)).toBe(true);
    expect(alreadySeen(500, 930)).toBe(true);
    expect(alreadySeen(930, 930)).toBe(false);
    expect(alreadySeen(2400, 930)).toBe(false);
  });
});
