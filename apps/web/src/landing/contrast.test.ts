import { describe, expect, it } from "vitest";
import css from "./landing.css?raw";

// The story's (Story 9.2) colour pairs, read from the rules landing.css actually ships:
// text at least 4.5:1, a dark door's border at least 3:1 against the page (WCAG 1.4.11).

/** The `.landing` custom properties: `--name: #rrggbb;`. */
const vars = new Map<string, string>();
for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
  if (!vars.has(match[1]!)) vars.set(match[1]!, match[2]!.toLowerCase());
}

function resolve(value: string): string {
  const ref = /var\(--([a-z0-9-]+)\)/i.exec(value);
  const hex = ref ? vars.get(ref[1]!) : /#[0-9a-f]{6}\b/i.exec(value)?.[0];
  if (hex === undefined) throw new Error(`no colour in "${value}"`);
  return hex.toLowerCase();
}

/** The body of the first rule with exactly this selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (!rule) throw new Error(`landing.css has no rule "${selector}"`);
  return rule[1]!;
}

/** The colour a property takes in the first rule with exactly this selector. */
function declared(selector: string, property: string): string {
  const decl = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(ruleBody(selector));
  if (!decl) throw new Error(`"${selector}" sets no ${property}`);
  return resolve(decl[1]!);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio. */
function ratio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const page = declared(".landing", "background");
const door = declared(".l-door", "background");
const orange = declared(".l-door-or", "background");

describe("story contrast", () => {
  it("reads the landing palette", () => {
    expect(page).toBe("#07080b");
    expect(door).toBe("#111419");
    expect(orange).toBe("#ff7a1a");
  });

  it.each([
    ["beat body on the page", declared(".l-beat-body", "color"), page],
    ["source links on the page", declared(".l-beat .l-source", "color"), page],
    ["door label on a dark door", declared(".l-door", "color"), door],
    ["door detail on a dark door", declared(".l-door-detail", "color"), door],
    ["orange door text", declared(".l-door-or", "color"), orange],
    ["orange door detail", declared(".l-door-or .l-door-detail", "color"), orange],
  ])("%s is at least 4.5:1", (_name, text, surface) => {
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("gives a dark door a border at least 3:1 against the page", () => {
    const border = resolve(/border:\s*1px solid ([^;]+);/.exec(ruleBody(".l-door"))![1]!);
    expect(ratio(border, page)).toBeGreaterThanOrEqual(3);
  });
});
