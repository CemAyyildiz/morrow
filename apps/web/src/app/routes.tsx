import type { ComponentType } from "react";
import { copy } from "@/copy";
import {
  ChallengeIcon,
  GuardiansIcon,
  PolicyIcon,
  ProofIcon,
  VaultIcon,
  XRayIcon,
  type IconProps,
} from "@/shell/icons";
import { normalizePath } from "./router";

export type NavId = "vault" | "challenge" | "guardians" | "policy" | "proof" | "xray";

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

/** Sidebar and phone menu order. */
export const NAV_ROUTES: readonly NavRoute[] = [
  { id: "vault", path: "/vault", label: copy.nav.vault, title: copy.titles.vault, Icon: VaultIcon },
  {
    id: "challenge",
    path: "/challenge",
    label: copy.nav.challenge,
    title: copy.titles.challenge,
    Icon: ChallengeIcon,
    badge: copy.nav.live,
  },
  {
    id: "guardians",
    path: "/guardians",
    label: copy.nav.guardians,
    title: copy.titles.guardians,
    Icon: GuardiansIcon,
  },
  {
    id: "policy",
    path: "/policy",
    label: copy.nav.policy,
    title: copy.titles.policy,
    Icon: PolicyIcon,
  },
  { id: "proof", path: "/proof", label: copy.nav.proof, title: copy.titles.proof, Icon: ProofIcon },
  { id: "xray", path: "/x-ray", label: copy.nav.xray, title: copy.titles.xray, Icon: XRayIcon },
];

export const HOME_PATH = "/challenge";

/** The public landing (Epic 9), drawn full-bleed outside the app shell. */
export const LANDING_PATH = "/";

/** Paths the router rewrites before rendering. None today: `/` is the landing. */
export const REDIRECTS: Readonly<Record<string, string>> = {};

export type ResolvedRoute =
  | { kind: "redirect"; to: string }
  | { kind: "landing" }
  | { kind: "nav"; route: NavRoute }
  | { kind: "not-found"; path: string };

export function resolveRoute(pathname: string): ResolvedRoute {
  const path = normalizePath(pathname);
  const to = REDIRECTS[path];
  if (to !== undefined) return { kind: "redirect", to };
  if (path === LANDING_PATH) return { kind: "landing" };
  const route = NAV_ROUTES.find((candidate) => candidate.path === path);
  return route ? { kind: "nav", route } : { kind: "not-found", path };
}

/**
 * Product paths whose screen is real, not a placeholder. The landing's doors (Story 9.2) link
 * only to these, so a judge never lands on a stub: a story that ships its screen adds its path
 * here (1.11 `/vault`, 6.1 `/proof`) and its door appears.
 */
export const LIVE_PATHS: ReadonlySet<string> = new Set(["/challenge"]);
