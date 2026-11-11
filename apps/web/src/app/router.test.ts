import { describe, expect, it } from "vitest";
import { copy, plural } from "@/copy";
import type { BtcNetwork, NearNetwork, NetworkPair } from "./data";
import { normalizePath } from "./router";
import { NAV_ROUTES, REDIRECTS, resolveRoute } from "./routes";

describe("route resolution", () => {
  it("resolves / to the landing; the redirects are /rob to /challenge and /x-ray to /xray", () => {
    expect(resolveRoute("/")).toEqual({ kind: "landing" });
    expect(resolveRoute("")).toEqual({ kind: "landing" });
    expect(REDIRECTS).toEqual({ "/rob": "/challenge", "/x-ray": "/xray" });
    expect(resolveRoute("/x-ray")).toEqual({ kind: "redirect", to: "/xray" });
    expect(resolveRoute("/rob")).toEqual({ kind: "redirect", to: "/challenge" });
    expect(resolveRoute("/rob/")).toEqual({ kind: "redirect", to: "/challenge" });
  });

  it("lists only the built screens, in sidebar order", () => {
    expect(NAV_ROUTES.map((route) => route.path)).toEqual([
      "/challenge",
      "/proof",
      "/xray",
      "/lost",
    ]);
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Challenge",
      "Proof",
      "X-Ray",
      "Lost a device?",
    ]);
  });

  it.each([
    ["/challenge", "challenge", "Challenge vault"],
    ["/proof", "proof", "Proof"],
    ["/xray", "xray", "X-Ray"],
    ["/lost", "lost", "Lost a device?"],
    ["/lost/", "lost", "Lost a device?"],
    ["/challenge/", "challenge", "Challenge vault"],
  ])("resolves %s to the %s item", (path, id, title) => {
    const resolved = resolveRoute(path);
    expect(resolved.kind).toBe("nav");
    if (resolved.kind === "nav") {
      expect(resolved.route.id).toBe(id);
      expect(resolved.route.title).toBe(title);
    }
  });

  it("resolves /xray/<op_id> and /xray/tx/<hash> to the X-Ray item, shareable", () => {
    const hash = "2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD";
    const op = resolveRoute("/xray/25");
    expect(op).toMatchObject({ kind: "nav", xray: { kind: "op", opId: "25" } });
    if (op.kind === "nav") expect(op.route.id).toBe("xray");
    expect(resolveRoute(`/xray/tx/${hash}`)).toMatchObject({
      kind: "nav",
      xray: { kind: "tx", hash },
    });
    expect(resolveRoute("/xray")).toMatchObject({ kind: "nav" });
    expect(resolveRoute("/xray").kind === "nav" && "xray" in resolveRoute("/xray")).toBe(false);
    // `/xray/007` is op 7: the address bar is rewritten to `/xray/7`.
    expect(resolveRoute("/xray/007")).toEqual({ kind: "redirect", to: "/xray/7" });
    expect(resolveRoute("/xray/0")).toMatchObject({ kind: "nav", xray: { opId: "0" } });
  });

  it.each([
    "/xray/abc",
    "/xray/tx/not-a-hash",
    "/xray/tx/0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OI",
    "/xray/99999999999999999999",
    "/xray/7/extra",
  ])("resolves %s to not found", (path) => {
    expect(resolveRoute(path)).toEqual({ kind: "not-found", path });
  });

  // Unbuilt screens have no route: a typed URL never lands on a placeholder.
  it.each(["/vault", "/guardians", "/policy", "/guardians/", "/lost/extra"])(
    "resolves the unbuilt or unknown %s to not found",
    (path) => {
      expect(resolveRoute(path)).toEqual({ kind: "not-found", path: normalizePath(path) });
    },
  );

  it.each(["/g/7/clawback", "/nope", "/Challenge", "/challenge/extra"])(
    "resolves %s to not found",
    (path) => {
      expect(resolveRoute(path)).toEqual({ kind: "not-found", path: normalizePath(path) });
    },
  );

  it("marks only Challenge as live", () => {
    expect(NAV_ROUTES.filter((route) => route.badge !== undefined).map((r) => r.id)).toEqual([
      "challenge",
    ]);
  });
});

describe("network banner", () => {
  it.each([
    [{ btc: "signet", near: "testnet" }, "Signet test coins · NEAR testnet · not real bitcoin"],
    [{ btc: "regtest", near: "mock" }, "Regtest test coins · mock contract · not real bitcoin"],
    [{ btc: "bitcoin", near: "mainnet" }, null],
    [{ btc: "bitcoin", near: "testnet" }, "Real bitcoin · NEAR testnet · test deployment"],
    [{ btc: "bitcoin", near: "mock" }, "Real bitcoin · mock contract · test deployment"],
    [{ btc: "signet", near: "mainnet" }, "Signet test coins · NEAR mainnet · not real bitcoin"],
  ] as const)("%o shows %s", (network, line) => {
    expect(copy.networkBanner(network)).toBe(line);
  });

  const BTC: BtcNetwork[] = ["bitcoin", "testnet", "signet", "regtest"];
  const NEAR: NearNetwork[] = ["mainnet", "testnet", "mock"];
  const ALL = BTC.flatMap((btc) => NEAR.map((near): NetworkPair => ({ btc, near })));

  it.each(ALL)("%o hides the banner only on bitcoin + NEAR mainnet", (network) => {
    const line = copy.networkBanner(network);
    if (network.btc === "bitcoin" && network.near === "mainnet") {
      expect(line).toBeNull();
    } else {
      expect(line).toMatch(/\S · \S.* · \S/);
      expect(line).toContain(network.near === "mock" ? "mock contract" : `NEAR ${network.near}`);
      expect(line).toContain(network.btc === "bitcoin" ? "Real bitcoin" : "test coins");
    }
  });

  it("names the network in the system card", () => {
    expect(copy.systemNetwork({ btc: "signet", near: "testnet" })).toBe("signet · NEAR testnet");
    expect(copy.systemNetwork({ btc: "regtest", near: "mock" })).toBe("regtest · mock contract");
  });
});

describe("counts", () => {
  it("pluralise", () => {
    expect(plural(1, "attempt")).toBe("1 attempt");
    expect(plural(0, "attempt")).toBe("0 attempts");
    expect(plural(13, "attempt")).toBe("13 attempts");
  });

  it("read correctly at 1", () => {
    expect(copy.challenge.attemptsUnit(1, 1)).toBe("attempt · 1 sat out");
    expect(copy.challenge.attemptsUnit(13, 0)).toBe("attempts · 0 sats out");
    expect(copy.challenge.hourlySummary(1, 1, 1)).toBe(
      "1 attempt in 1 of 24 hours, at most 1 in one hour",
    );
    expect(copy.challenge.hourlySummary(13, 9, 3)).toBe(
      "13 attempts in 9 of 24 hours, at most 3 in one hour",
    );
  });
});
