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
import { canonicalVaultId } from "./proof";
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

/** The Proof Page: the live Challenge Vault's proof, or a form to open any Vault by id. */
export const PROOF_PATH = "/proof";

/** The public landing (Epic 9), drawn full-bleed outside the app shell. */
export const LANDING_PATH = "/";

/**
 * Paths the router rewrites before rendering. `/rob` (the epic's name for the Challenge page)
 * leads to the canonical `/challenge`.
 */
export const REDIRECTS: Readonly<Record<string, string>> = { "/rob": HOME_PATH };

export type ResolvedRoute =
  | { kind: "redirect"; to: string }
  | { kind: "landing" }
  /** `vaultId` is set on `/proof/<digits>`: the Proof Page of that Vault. */
  | { kind: "nav"; route: NavRoute; vaultId?: string }
  | { kind: "not-found"; path: string };

const PROOF_PARAM = /^\/proof\/(\d+)$/;

export function resolveRoute(pathname: string): ResolvedRoute {
  const path = normalizePath(pathname);
  const to = REDIRECTS[path];
  if (to !== undefined) return { kind: "redirect", to };
  if (path === LANDING_PATH) return { kind: "landing" };
  const route = NAV_ROUTES.find((candidate) => candidate.path === path);
  if (route) return { kind: "nav", route };
  // `/proof/<vault_id>`, shareable: the Proof nav item stays the current page.
  const proof = PROOF_PARAM.exec(path);
  const vaultId = proof?.[1] === undefined ? null : canonicalVaultId(proof[1]);
  const proofRoute = NAV_ROUTES.find((candidate) => candidate.id === "proof");
  if (vaultId !== null && proofRoute) return { kind: "nav", route: proofRoute, vaultId };
  return { kind: "not-found", path };
}

/** The Proof Page of Vault `vaultId`. */
export const proofPath = (vaultId: string) => `${PROOF_PATH}/${vaultId}`;

/**
 * Product paths whose screen is real, not a placeholder. The landing's doors (Story 9.2) link
 * only to these, so a judge never lands on a stub: a story that ships its screen adds its path
 * here (1.11 `/vault`, 6.1 `/proof`) and its door appears.
 */
export const LIVE_PATHS: ReadonlySet<string> = new Set(["/challenge", "/proof"]);
