import { Suspense, lazy, useEffect, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { Landing } from "@/landing/Landing";
import { landingCopy } from "@/landing/copy";
import { AppShell } from "@/shell/AppShell";
import { ChallengeView } from "@/views/ChallengeView";
import { LostView } from "@/views/LostView";
import { NotFoundView } from "@/views/NotFoundView";
import { ProofView } from "@/views/ProofView";
import { useRouter } from "./router";
import { LANDING_PATH, resolveRoute, type ResolvedRoute } from "./routes";

// The X-Ray page carries core-ts `buildXRay`: its own chunk, loaded when an X-Ray route opens.
// A chunk that fails to load (a redeploy changed the asset hashes) shows a notice, not a blank app.
const XRayView = lazy(() =>
  import("@/views/XRayView").then(
    (m) => ({ default: m.XRayView }),
    () => ({ default: XRayLoadFailed }),
  ),
);

// The wallet pages (story 1.11b) carry the key, Policy and spend code: their own chunks, loaded
// only on `/vault/new` and `/vault/<id>`; near-connect is a further chunk, loaded on Connect.
const CreateVaultView = lazy(() =>
  import("@/vault/CreateVaultView").then(
    (m) => ({ default: m.CreateVaultView }),
    () => ({ default: VaultLoadFailed }),
  ),
);
const VaultView = lazy(() =>
  import("@/vault/VaultView").then(
    (m) => ({ default: m.VaultView }),
    () => ({ default: VaultLoadFailed }),
  ),
);

function XRayLoadFailed() {
  return (
    <LoadFailed
      testId="xray-load-failed"
      title={copy.xrayPage.loadFailed}
      body={copy.xrayPage.loadFailedBody}
      reload={copy.xrayPage.reload}
    />
  );
}

function VaultLoadFailed() {
  return (
    <LoadFailed
      testId="vault-load-failed"
      title={copy.vault.loadFailed}
      body={copy.vault.loadFailedBody}
      reload={copy.vault.reload}
    />
  );
}

function LoadFailed({
  testId,
  title,
  body,
  reload,
}: {
  testId: string;
  title: string;
  body: string;
  reload: string;
}) {
  return (
    <Card
      data-testid={testId}
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle>{title}</CardTitle>
      <CardDescription className="max-w-[560px]">{body}</CardDescription>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        {reload}
      </Button>
    </Card>
  );
}

export function App() {
  const { path, navigate } = useRouter();
  const resolved = resolveRoute(path);

  // The router settles redirects itself; this only guards a redirect added to the table.
  const redirectTo = resolved.kind === "redirect" ? resolved.to : null;
  useEffect(() => {
    if (redirectTo !== null) navigate(redirectTo, { replace: true });
  }, [redirectTo, navigate]);

  const documentTitle =
    resolved.kind === "landing"
      ? landingCopy.documentTitle
      : `${resolved.kind === "nav" ? resolved.route.title : copy.titles.notFound} · ${copy.wordmark}`;

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  if (resolved.kind === "redirect") return null;

  // The landing is full-bleed: no shell, no sidebar, no banner bar.
  if (resolved.kind === "landing") return <Landing />;

  const title = resolved.kind === "nav" ? resolved.route.title : copy.titles.notFound;
  // A detail page (`/proof/33`, `/xray/30`) leads back to its list page; every other page home,
  // the Vault pages included (`/vault/new` is no list of Vaults).
  const detail =
    resolved.kind === "nav" &&
    resolved.route.id !== "vault" &&
    (resolved.vaultId !== undefined || resolved.xray !== undefined);
  const back = detail
    ? { to: resolved.route.path, label: copy.nav.backTo(resolved.route.label) }
    : { to: LANDING_PATH, label: copy.nav.backHome };
  return (
    <AppShell
      activeId={resolved.kind === "nav" ? resolved.route.id : null}
      title={title}
      back={back}
    >
      {resolved.kind === "not-found" ? (
        <NotFoundView path={resolved.path} />
      ) : (
        <Screen {...resolved} />
      )}
    </AppShell>
  );
}

/** One screen per nav item; the switch is exhaustive, so a nav item without a screen fails to compile. */
function Screen({ route, vaultId, xray }: Extract<ResolvedRoute, { kind: "nav" }>): ReactElement {
  switch (route.id) {
    case "vault":
      return (
        <Suspense fallback={null}>
          {vaultId === undefined ? <CreateVaultView /> : <VaultView vaultId={vaultId} />}
        </Suspense>
      );
    case "challenge":
      return <ChallengeView />;
    case "proof":
      return <ProofView vaultId={vaultId ?? null} />;
    case "xray":
      return (
        <Suspense fallback={null}>
          <XRayView target={xray ?? null} />
        </Suspense>
      );
    case "lost":
      return <LostView />;
  }
}
