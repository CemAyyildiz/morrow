import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDataContext, type AppConfig, type AppData } from "@/app/data";
import { RouterProvider } from "@/app/router";
import type { XRayRouteTarget } from "@/app/routes";
import { allRows, xrayModel } from "@/app/xray";
import { NOW, TXID_URL, TX_URL, refusedCall, signedOp } from "@/app/xray.fixture";
import { copy } from "@/copy";
import { XRayPipeline, XRayView } from "./XRayView";

const CONFIG: AppConfig = {
  network: { btc: "signet", near: "testnet" },
  contractId: "morrow-vault-v1.testnet",
  nearRpcUrl: "https://rpc.example.org",
  nearArchivalRpcUrl: "https://archival.example.org",
  nearTxIndexerUrl: "https://indexer.example.org",
  btcBackendUrl: "https://btc.example.org",
  watcherUrl: null,
  challengeUrl: null,
  bountyUrl: null,
  contract: "locked",
  coSigner: "v1.signer-prod.testnet",
  heartbeat: { kind: "none" },
};

function render(target: XRayRouteTarget | null, config: AppConfig = CONFIG) {
  vi.stubGlobal("window", { location: { pathname: "/xray", search: "" } });
  const value: AppData = { config, challenge: null, challengeStatus: "none", attempt: null };
  return renderToStaticMarkup(
    createElement(
      AppDataContext.Provider,
      { value },
      createElement(RouterProvider, {
        redirects: {},
        children: createElement(XRayView, { target }),
      }),
    ),
  );
}

const pipeline = (shown: number, xray = signedOp()) =>
  renderToStaticMarkup(createElement(XRayPipeline, { model: xrayModel(xray, NOW), shown }));

/** Every `xray-row` value element: an `<a …>` or a `<span …>`, with its attributes. */
function values(html: string): { tag: string; attrs: Record<string, string> }[] {
  return [...html.matchAll(/<(a|span) ([^>]*data-testid="xray-value"[^>]*)>/g)].map((m) => ({
    tag: m[1] as string,
    attrs: Object.fromEntries(
      [...(m[2] as string).matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ),
  }));
}

const unescape = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&#x27;", "'");

describe("X-Ray page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says X-Ray needs a NEAR network on the mock contract", () => {
    const html = render(
      { kind: "op", opId: "25" },
      { ...CONFIG, network: { btc: "regtest", near: "mock" }, nearArchivalRpcUrl: null },
    );
    expect(html).toContain('data-testid="xray-no-network"');
    expect(html).toContain(copy.xrayPage.noNetwork);
    expect(html).not.toContain('data-testid="xray-open"');
  });

  it("bare /xray is the form", () => {
    const html = render(null);
    expect(html).toContain('data-testid="xray-open"');
    expect(html).toContain(copy.xrayPage.open.label);
    expect(html).toContain("morrow-vault-v1.testnet");
  });

  it("shows four dimmed stages while the first read is out", () => {
    const html = render({ kind: "op", opId: "25" });
    expect(html).toContain('data-testid="xray-loading"');
    expect(html).toContain("op #25");
    for (const title of Object.values(copy.xrayPage.stages)) expect(html).toContain(title);
  });
});

describe("X-Ray pipeline", () => {
  it("every row has a non-empty ref, and every row whose source has a url is a link to it", () => {
    const xray = signedOp();
    const html = pipeline(4, xray);
    const rendered = values(html);
    const rows = allRows(xrayModel(xray, NOW));
    expect(rendered).toHaveLength(rows.length);
    expect((html.match(/data-testid="xray-row"/g) ?? []).length).toBe(rows.length);
    for (const [index, value] of rendered.entries()) {
      const row = rows[index]!;
      expect(value.attrs["data-ref"]).not.toBe("");
      expect(unescape(value.attrs["data-ref"] ?? "")).toBe(row.ref);
      expect(unescape(value.attrs.title ?? "")).toBe(row.ref);
      if (row.url === null) {
        expect(value.tag).toBe("span");
      } else {
        expect(value.tag).toBe("a");
        expect(unescape(value.attrs.href ?? "")).toBe(row.url);
        expect(value.attrs.target).toBe("_blank");
        expect(value.attrs.rel).toBe("noreferrer");
      }
    }
    expect(rendered.some((v) => v.attrs.href === TXID_URL)).toBe(true);
    expect(rendered.some((v) => v.attrs.href === TX_URL)).toBe(true);
  });

  it("lights stages in order: only the first `shown` show their data", () => {
    const html = pipeline(1);
    expect((html.match(/data-revealed="true"/g) ?? []).length).toBe(1);
    expect((html.match(/data-revealed="false"/g) ?? []).length).toBe(3);
    expect(html).toContain("Withdrawal path of the Vault Script");
    expect(html).not.toContain("Signed by the NEAR MPC network");
  });

  it("all four lit: the MPC headline, the Bitcoin stage ok, the script highlighted, sources", () => {
    const html = pipeline(4);
    expect(html).toContain("Signed by the NEAR MPC network (11 of 16)");
    expect(html).toMatch(/data-stage="bitcoin" data-status="done" data-tone="ok"/);
    expect(html).toContain('data-on-path="true"');
    expect(html).toContain('data-on-path="false"');
    expect(html).toContain('data-testid="xray-address-match" data-match="true"');
    expect((html.match(/data-testid="xray-sources"/g) ?? []).length).toBe(4);
  });

  it("a refused call shows the code and gloss in stage 2, alarm, and stages 3-4 not reached", () => {
    const html = pipeline(4, refusedCall());
    expect(html).toMatch(/data-stage="rule" data-status="refused" data-tone="alarm"/);
    expect(html).toContain("ERR_NOT_EXECUTABLE · The Delay has not passed yet.");
    expect(html).toContain("begin_execute");
    expect((html.match(/data-status="not_reached"/g) ?? []).length).toBe(2);
  });
});
