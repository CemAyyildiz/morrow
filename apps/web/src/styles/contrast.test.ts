import { describe, expect, it } from "vitest";
import theme from "./theme.css?raw";

/** `--color-<name>: #rrggbb;` declarations from theme.css. */
function parseColors(css: string): Map<string, string> {
  const colors = new Map<string, string>();
  for (const match of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    colors.set(match[1]!, match[2]!.toLowerCase());
  }
  return colors;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio. */
function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const colors = parseColors(theme);

function color(name: string): string {
  const value = colors.get(name);
  if (value === undefined) throw new Error(`theme.css defines no --color-${name}`);
  return value;
}

const TEXT = ["ink", "muted", "ok", "alarm", "orange"];
// card-highlight is the top of every card's gradient, so card text sits on it too.
const SURFACES = ["page", "card", "card-highlight", "card-raised"];
const PAIRS: [string, string][] = [
  ...TEXT.flatMap((text) => SURFACES.map((surface): [string, string] => [text, surface])),
  ["orange-foreground", "orange"],
  ["alarm-foreground", "alarm"],
];

describe("theme contrast", () => {
  it("parses the DESIGN.md colors from theme.css", () => {
    expect(color("page")).toBe("#07080b");
    expect(color("ink")).toBe("#f3f1ec");
    // The 17 DESIGN.md colors plus the card gradient's top stop.
    expect(colors.size).toBe(18);
  });

  it.each(PAIRS)("%s on %s is at least 4.5:1", (text, surface) => {
    expect(ratio(color(text), color(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it("matches the measured ratios in the spec", () => {
    expect(ratio(color("muted"), color("card-raised"))).toBeCloseTo(5.75, 1);
    expect(ratio(color("orange-foreground"), color("orange"))).toBeCloseTo(7.47, 1);
    expect(ratio(color("alarm-foreground"), color("alarm"))).toBeCloseTo(7.07, 1);
  });

  it("keeps faint below the text floor, so it never carries text", () => {
    expect(ratio(color("faint"), color("page"))).toBeLessThan(4.5);
  });
});
