import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { resolveRoute } from "@/app/routes";
import { copy } from "@/copy";
import README from "../../../../README.md?raw";
import { LOST_LINKS, LostView } from "./LostView";

/** The Escape CLI's entry point in this repository, if it exists. */
const ESCAPE_CLI = Object.keys(import.meta.glob("../../../../tools/escape/src/cli.ts"));

/** The page's markup on `/lost`: no app data, no config, no key. */
function render() {
  vi.stubGlobal("window", { location: { pathname: "/lost" } });
  return renderToStaticMarkup(
    createElement(RouterProvider, { redirects: {}, children: createElement(LostView) }),
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ");

/** GitHub's anchor for a README heading. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");

describe("Lost a device page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders without app data, with one h1", () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(">Lost a device?</h1>");
  });

  it("numbers the steps: Guardian Clawback, own Backup Device, then a new Vault", () => {
    const steps = render().match(/<li[^>]*data-testid="lost-step"[\s\S]*?<\/li>/g) ?? [];
    expect(steps.map((step) => text(step).trim())).toEqual([
      expect.stringMatching(/^1 Ask any Guardian to Clawback /),
      expect.stringMatching(/^2 Claw back from your own Backup Device /),
      expect.stringMatching(/^3 Create a new Vault .*Never reuse/),
    ]);
    expect(render()).toMatch(/<ol[^>]*>\s*<li[^>]*data-testid="lost-step"/);
  });

  it("covers reaching a Guardian, the thief during the Delay, Escape and Refresh", () => {
    const page = text(render());
    for (const part of [
      copy.lost.guardianTitle,
      copy.lost.thiefTitle,
      copy.lost.escape.title,
      copy.lost.refresh.title,
      "ERR_CLAWED_BACK",
      "begin_clawback",
      "Spending Allowance up to its 24 h limit",
      "Stop a Clawback.",
    ]) {
      expect(page).toContain(part);
    }
  });

  it("says which screens are not in this build", () => {
    const page = text(render());
    expect(page).toContain("The one-tap Guardian view is not in this build.");
    expect(page).toContain("Creating your own Vault is not possible in this build.");
    expect(page).toContain("there is no Backup Device screen yet.");
    expect(page).toContain("it has no screen yet");
    // Every numbered step carries its build note.
    const steps = render().match(/<li[^>]*data-testid="lost-step"[\s\S]*?<\/li>/g) ?? [];
    expect(steps).toHaveLength(3);
    for (const [i, step] of Object.values(copy.lost.steps).entries()) {
      expect(text(steps[i] ?? "")).toContain(text(step.build));
    }
  });

  it("links only to things that exist, external ones in a new tab", () => {
    const html = render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set(Object.values(LOST_LINKS)));
    for (const href of hrefs) expect(href).not.toMatch(/^\/(vault|guardians|policy|g\/)/);

    // The in-app link is a route; the README anchors are its headings; tools/escape is here.
    expect(resolveRoute(LOST_LINKS.proof).kind).toBe("nav");
    // Headings only: `# ...` lines inside fenced code blocks are shell comments.
    const prose = README.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
    const anchors = [...prose.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1] ?? ""));
    for (const href of [LOST_LINKS.scenarios, LOST_LINKS.trust]) {
      expect(href.startsWith(`${copy.proof.repoUrl}#`)).toBe(true);
      expect(anchors).toContain(href.split("#")[1]);
    }
    expect(LOST_LINKS.escape).toBe(`${copy.proof.repoUrl}/tree/main/tools/escape`);
    expect(ESCAPE_CLI).toHaveLength(1);

    const external = [...html.matchAll(/<a [^>]*href="https:[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(external).toHaveLength(3);
    for (const a of external) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noreferrer"');
      expect(a).toContain("(opens in a new tab)");
    }
  });
});
