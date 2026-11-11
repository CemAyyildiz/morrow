import type { ComponentType } from "react";
import { copy } from "@/copy";
import { ChallengeIcon, LostIcon, ProofIcon, XRayIcon, type IconProps } from "@/shell/icons";
import { canonicalVaultId } from "./proof";
import { normalizePath } from "./router";
import { XRAY_PATH, parseXRayPath } from "./xray-paths";

/**
 * Only screens that are built have a nav item and a route. Vault, Guardians and Policy come
 * back with their screens (stories 1.11, 3.7, 5.5); until then their paths are Not found.
 */
export type NavId = "challenge" | "proof" | "xray" | "lost";

export interface NavRoute {
  id: NavId;
  path: string;
  label: string;
  /** The page header title. */
  title: string;
  Icon: ComponentType<IconProps>;
  /** A short mono badge after the label. */
  badge?: string;
}

/** The Lost a device page (story 3.8): public, static, linked from every screen. */
export const LOST_PATH = "/lost";

/** Sidebar and phone menu order. */
export const NAV_ROUTES: readonly NavRoute[] = [
  {
    id: "challenge",
    path: "/challenge",
    label: copy.nav.challenge,
    title: copy.titles.challenge,
    Icon: ChallengeIcon,
    badge: copy.nav.live,
  },
  { id: "proof", path: "/proof", label: copy.nav.proof, title: copy.titles.proof, Icon: ProofIcon },
  { id: "xray", path: XRAY_PATH, label: copy.nav.xray, title: copy.titles.xray, Icon: XRayIcon },
  { id: "lost", path: LOST_PATH, label: copy.nav.lost, title: copy.titles.lost, Icon: LostIcon },
];

export const HOME_PATH = "/challenge";

/** The Proof Page: the live Challenge Vault's proof, or a form to open any Vault by id. */
export const PROOF_PATH = "/proof";

/** The public landing (Epic 9), drawn full-bleed outside the app shell. */
export const LANDING_PATH = "/";

/**
 * Paths the router rewrites before rendering. `/rob` (the epic's name for the Challenge page)
 * leads to the canonical `/challenge`; `/x-ray` (the X-Ray item's first path) to `/xray`.
 */
export const REDIRECTS: Readonly<Record<string, string>> = {
  "/rob": HOME_PATH,
  "/x-ray": XRAY_PATH,
};

export type ResolvedRoute =
  | { kind: "redirect"; to: string }
  | { kind: "landing" }
  /**
   * `vaultId` is set on `/proof/<digits>`: the Proof Page of that Vault. `xray` on
   * `/xray/<op_id>` and `/xray/tx/<hash>`: what the X-Ray shows.
   */
  | { kind: "nav"; route: NavRoute; vaultId?: string; xray?: XRayRouteTarget }
  | { kind: "not-found"; path: string };

const PROOF_PARAM = /^\/proof\/(\d+)$/;

/** An op, or a refused call (its signer is not in the path). */
export type XRayRouteTarget = { kind: "op"; opId: string } | { kind: "tx"; hash: string };

export function resolveRoute(pathname: string): ResolvedRoute {
  const path = normalizePath(pathname);
  const to = REDIRECTS[path];
  if (to !== undefined) return { kind: "redirect", to };
  if (path === LANDING_PATH) return { kind: "landing" };
  const route = NAV_ROUTES.find((candidate) => candidate.path === path);
  if (route) return { kind: "nav", route };
  // `/xray/<op_id>` and `/xray/tx/<hash>`, shareable: the X-Ray nav item stays current.
  const xray = parseXRayPath(path);
  const xrayRoute = NAV_ROUTES.find((candidate) => candidate.id === "xray");
  if (xray?.kind === "redirect") return { kind: "redirect", to: xray.to };
  if (xray && xray.kind !== "form" && xrayRoute) return { kind: "nav", route: xrayRoute, xray };
  // `/proof/<vault_id>`, shareable: the Proof nav item stays the current page.
  const proof = PROOF_PARAM.exec(path);
  const vaultId = proof?.[1] === undefined ? null : canonicalVaultId(proof[1]);
  const proofRoute = NAV_ROUTES.find((candidate) => candidate.id === "proof");
  // `/proof/007` is Vault 7: the address bar is rewritten to `/proof/7`.
  if (vaultId !== null && vaultId !== proof?.[1])
    return { kind: "redirect", to: proofPath(vaultId) };
  if (vaultId !== null && proofRoute) return { kind: "nav", route: proofRoute, vaultId };
  return { kind: "not-found", path };
}

/** The Proof Page of Vault `vaultId`. */
export const proofPath = (vaultId: string) => `${PROOF_PATH}/${vaultId}`;

/**
 * The product paths a landing door (Story 9.2) may link to. A story that ships its screen adds
 * its path here (1.11 `/vault`, 6.1 `/proof`) and its door appears.
 */
export const LIVE_PATHS: ReadonlySet<string> = new Set(["/challenge", "/proof"]);
