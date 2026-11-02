import { describe, expect, it } from "vitest";
import { copy } from "./copy";

/** Every string in `copy`, with each template function called on sample arguments. */
function collect(value: unknown, path: string, out: { path: string; text: string }[]) {
  if (typeof value === "string") {
    out.push({ path, text: value });
  } else if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    const samples: unknown[][] = [
      Array.from({ length: fn.length }, () => 7),
      Array.from({ length: fn.length }, () => "06:12"),
    ];
    if (path.endsWith("networkBanner") || path.endsWith("systemNetwork")) {
      samples.length = 0;
      for (const btc of ["bitcoin", "testnet", "signet", "regtest"]) {
        for (const near of ["mainnet", "testnet", "mock"]) samples.push([{ btc, near }]);
      }
    }
    for (const args of samples) {
      const result = fn(...args);
      if (result !== null) collect(result, `${path}(${JSON.stringify(args)})`, out);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`, out);
  }
}

const strings: { path: string; text: string }[] = [];
collect(copy, "copy", strings);

const HYPE =
  /\b(amazing|awesome|incredible|revolutionary|game[- ]?chang\w*|blazing\w*|seamless\w*|effortless\w*|magic\w*|ultimate|unbreakable|unhackable|best[- ]in[- ]class|cutting[- ]edge|next[- ]gen\w*|supercharg\w*|lightning[- ]fast|world[- ]class|bulletproof|military[- ]grade|100% safe|guaranteed)\b/i;

const RELATIVE_TIME =
  /\b(ago|yesterday|tomorrow|today|tonight|just now|right now|moments?|soon|shortly|recently|earlier|later today|last (week|month|year|night)|next (week|month|year)|in (a|an|\d+) (second|minute|hour|day|week|month|year)s?)\b/i;

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u;

describe("shell copy", () => {
  it("has strings to check", () => {
    expect(strings.length).toBeGreaterThan(30);
  });

  it.each(strings)("$path has no emoji", ({ text }) => {
    expect(text).not.toMatch(EMOJI);
  });

  it.each(strings)("$path has no exclamation mark", ({ text }) => {
    expect(text).not.toContain("!");
  });

  it.each(strings)("$path has no hype words", ({ text }) => {
    expect(text).not.toMatch(HYPE);
  });

  it.each(strings)("$path has no relative times", ({ text }) => {
    expect(text).not.toMatch(RELATIVE_TIME);
  });

  it("the lint patterns catch what they should", () => {
    expect("Done!").toContain("!");
    expect("An amazing vault").toMatch(HYPE);
    expect("Seamless sign-in").toMatch(HYPE);
    expect("3 minutes ago").toMatch(RELATIVE_TIME);
    expect("executes tomorrow").toMatch(RELATIVE_TIME);
    expect("in 5 minutes").toMatch(RELATIVE_TIME);
    expect("Safe \u{1F512}").toMatch(EMOJI);
    expect("Executable 06:12 on 13 Nov").not.toMatch(RELATIVE_TIME);
  });
});
