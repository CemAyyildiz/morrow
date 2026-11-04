import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppDataContext,
  type AppConfig,
  type AppData,
  type ChallengeData,
  type ChallengeKeys,
} from "@/app/data";
import { RouterProvider } from "@/app/router";
import { copy } from "@/copy";
import { ProofView } from "./ProofView";

const CONFIG: AppConfig = {
  network: { btc: "signet", near: "testnet" },
  contractId: "vault.morrow.testnet",
  nearRpcUrl: "https://rpc.example.org",
  btcBackendUrl: "https://btc.example.org",
  watcherUrl: null,
  challengeUrl: "https://challenge.example.org",
  bountyUrl: null,
  contract: "locked",
  coSigner: "v1.signer-prod.testnet",
  heartbeat: { kind: "none" },
};

const KEYS = {
  round: 3,
  vault_contract: "vault.morrow.testnet",
  vault_id: "7",
} as ChallengeKeys;

/** The page's markup on `/proof` (or `/proof/<vaultId>`) for the given app data. */
function render(vaultId: string | null, data: Partial<AppData>) {
  vi.stubGlobal("window", { location: { pathname: "/proof" } });
  const value: AppData = {
    config: CONFIG,
    challenge: null,
    challengeStatus: "none",
    attempt: null,
    ...data,
  };
  return renderToStaticMarkup(
    createElement(
      AppDataContext.Provider,
      { value },
      createElement(RouterProvider, {
        redirects: {},
        children: createElement(ProofView, { vaultId }),
      }),
    ),
  );
}

const round = (keys: Partial<ChallengeKeys>) =>
  ({ round: 3, keys: { ...KEYS, ...keys } }) as ChallengeData;

describe("Proof Page states", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says so when no NEAR RPC is configured, without a dead retry", () => {
    const html = render("7", { config: { ...CONFIG, nearRpcUrl: null } });
    expect(html).toContain('data-testid="proof-no-rpc"');
    expect(html).toContain(copy.proof.noRpc);
    expect(html).not.toContain(copy.proof.retry);
  });

  it("shows skeletons while the first read is out", () => {
    expect(render("7", {})).toContain('data-testid="proof-loading"');
  });

  it("bare /proof with the live round's Vault on this contract reads that Vault", () => {
    const html = render(null, { challenge: round({}), challengeStatus: "round" });
    expect(html).toContain("vault #7");
    expect(html).toContain("challenge round 3");
  });

  it.each([
    ["no round", {}, copy.proof.open.noRound],
    ["the feed unreachable", { challengeStatus: "unreachable" }, copy.proof.open.feedDown],
    [
      "a round without a Vault yet",
      { challenge: round({ vault_id: null }), challengeStatus: "round" },
      copy.proof.open.noVault(3),
    ],
    [
      "a round on another contract",
      { challenge: round({ vault_contract: "other.testnet" }), challengeStatus: "round" },
      copy.proof.open.otherContract("other.testnet", "vault.morrow.testnet"),
    ],
  ] as const)("bare /proof with %s says why and offers the form", (_, data, lead) => {
    const html = render(null, data as Partial<AppData>);
    expect(html).toContain('data-testid="proof-open"');
    expect(html).toContain(lead.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("vault #7");
  });
});
