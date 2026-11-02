import { describe, expect, it } from "vitest";
import { copy } from "./copy";
import { collect, EMOJI, HYPE, RELATIVE_TIME } from "./copy-rules";

const strings: { path: string; text: string }[] = [];
collect(copy, "copy", strings);

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

  // Story 1.9b fixes the heartbeat line as "Alerts: watcher last seen N min ago": an age,
  // not a time of day. Only that template is exempt.
  const RELATIVE_TIME_EXEMPT = /^copy\.system\.alertsSeen\(/;

  it.each(strings.filter(({ path }) => !RELATIVE_TIME_EXEMPT.test(path)))(
    "$path has no relative times",
    ({ text }) => {
      expect(text).not.toMatch(RELATIVE_TIME);
    },
  );

  it("exempts only the heartbeat age from the relative-time rule", () => {
    expect(copy.system.alertsSeen(3)).toBe("Alerts: watcher last seen 3 min ago");
    const exempt = strings.filter(({ path }) => RELATIVE_TIME_EXEMPT.test(path));
    expect(exempt.length).toBeGreaterThan(0);
    for (const { text } of exempt) {
      expect(text).toMatch(/^Alerts: watcher last seen .+ min ago$/);
    }
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
