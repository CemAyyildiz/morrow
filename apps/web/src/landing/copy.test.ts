import { describe, expect, it } from "vitest";
import { collect, EMOJI, HYPE, RELATIVE_TIME } from "@/copy-rules";
import { landingCopy } from "./copy";

const strings: { path: string; text: string }[] = [];
collect(landingCopy, "landingCopy", strings);
for (const btc of ["bitcoin", "testnet", "signet", "regtest"] as const) {
  strings.push({ path: `footer.right(${btc})`, text: landingCopy.footer.right(btc) });
  for (const contract of ["locked", "unlocked", "checking", "unknown"] as const) {
    strings.push({
      path: `hero.legal(${btc}, ${contract})`,
      text: landingCopy.hero.legal(btc, contract),
    });
  }
}

/** The shell's relative-time rule with one word allowed: "tomorrow" is the brand's promise. */
const RELATIVE_BUT_TOMORROW = new RegExp(
  RELATIVE_TIME.source.replace("|tomorrow|", "|"),
  RELATIVE_TIME.flags,
);

/** The story's third era, "Today": a label for the present, the one exception to the rule. */
const PRESENT_ERA = "landingCopy.story.beats.2.era";

describe("landing copy", () => {
  it("has strings to check", () => {
    expect(strings.length).toBeGreaterThan(80);
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

  it.each(strings.filter(({ path }) => path !== PRESENT_ERA))(
    "$path has no relative time other than tomorrow",
    ({ text }) => {
      expect(text).not.toMatch(RELATIVE_BUT_TOMORROW);
    },
  );

  it("allows one 'Today': the third beat's era label, the present, never a timestamp", () => {
    expect(strings.find(({ path }) => path === PRESENT_ERA)?.text).toBe("Today");
    const others = strings.filter(({ path }) => path !== PRESENT_ERA);
    expect(others.filter(({ text }) => /\btoday\b/i.test(text)).map(({ path }) => path)).toEqual(
      [],
    );
  });

  it("allows only tomorrow from the relative-time rule", () => {
    expect(RELATIVE_BUT_TOMORROW.source).not.toContain("tomorrow");
    expect("executable tomorrow 14:02").not.toMatch(RELATIVE_BUT_TOMORROW);
    expect("2 min ago").toMatch(RELATIVE_BUT_TOMORROW);
    expect("today 14:02").toMatch(RELATIVE_BUT_TOMORROW);
  });

  it("states the deployment's own network and contract state in the legal line", () => {
    expect(landingCopy.hero.legal("signet", "locked")).toBe(
      "Signet test coins · Bitcoin P2WSH · NEAR Chain Signatures · contract locked",
    );
    expect(landingCopy.hero.legal("bitcoin", "unknown")).toMatch(/^Real bitcoin · .* unknown$/);
  });

  it("keeps the record line free of an invented count until it is live", () => {
    const record = Object.values(landingCopy.record).join(" ");
    expect(record).not.toMatch(/\d|thirteen|zero/i);
  });

  it("dates each story beat exactly and names one https source per beat", () => {
    const beats = landingCopy.story.beats;
    expect(beats.map((beat) => beat.era)).toEqual(["1870s", "2025", "Today"]);
    expect(beats[1].support).toContain("May 8, 2025");
    for (const beat of beats) {
      expect(new URL(beat.source.url).protocol).toBe("https:");
      expect(beat.source.label.length).toBeGreaterThan(0);
    }
    expect(beats.map((beat) => beat.source.url)).toEqual([
      "https://en.wikipedia.org/wiki/Time_lock",
      "https://github.com/bitcoin/bips/pull/1848",
      "https://docs.near.org/chain-abstraction/chain-signatures",
    ]);
    expect(beats[1].source.label).toBe("BIP-345 withdrawal, bitcoin/bips #1848");
  });
});
