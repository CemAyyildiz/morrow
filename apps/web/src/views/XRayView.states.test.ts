import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDataContext, type AppConfig, type AppData } from "@/app/data";
import { RouterProvider } from "@/app/router";
import type { XRayState } from "@/app/useXRay";
import { NOW, signedOp } from "@/app/xray.fixture";
import { copy } from "@/copy";

// The page's read states, with the read itself stubbed: what a judge sees when the input names
// nothing, and when a re-read fails after a good one.
const held: { state: XRayState } = { state: { kind: "loading" } };
vi.mock("@/app/useXRay", () => ({ useXRay: () => ({ state: held.state, retry: () => {} }) }));

const { XRayView } = await import("./XRayView");

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

function render(state: XRayState) {
  held.state = state;
  vi.stubGlobal("window", { location: { pathname: "/xray/9", search: "" } });
  const value: AppData = {
    config: CONFIG,
    challenge: null,
    challengeStatus: "none",
    attempt: null,
  };
  return renderToStaticMarkup(
    createElement(
      AppDataContext.Provider,
      { value },
      createElement(RouterProvider, {
        redirects: {},
        children: createElement(XRayView, { target: { kind: "op", opId: "9" } }),
      }),
    ),
  );
}

describe("X-Ray page read states", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bad input: the XRayInputError message and the open form", () => {
    const html = render({ kind: "input", message: "No op 9 on morrow-vault-v1.testnet" });
    expect(html).toContain('data-testid="xray-input"');
    expect(html).toContain(copy.xrayPage.input);
    expect(html).toContain("No op 9 on morrow-vault-v1.testnet");
    expect(html).toContain('data-testid="xray-open"');
    expect(html).not.toContain('data-testid="xray-pipeline"');
  });

  it("nothing read: could not be read, with Retry", () => {
    const html = render({ kind: "unreachable" });
    expect(html).toContain('data-testid="xray-unreachable"');
    expect(html).toContain(copy.xrayPage.retry);
  });

  it("a failed re-read keeps the earlier data, marked stale, with Retry", () => {
    const html = render({
      kind: "ok",
      xray: signedOp(),
      readAt: NOW - 60_000,
      now: NOW,
      stale: true,
    });
    expect(html).toContain('data-testid="xray-stale"');
    expect(html).toContain('data-testid="xray-pipeline"');
    expect(html).toContain(copy.xrayPage.retry);
  });
});
