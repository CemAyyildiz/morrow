import { Suspense, lazy, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { Landing } from "@/landing/Landing";
import { landingCopy } from "@/landing/copy";
import { AppShell } from "@/shell/AppShell";
import { ChallengeView } from "@/views/ChallengeView";
import { NotFoundView } from "@/views/NotFoundView";
import { PlaceholderView } from "@/views/PlaceholderView";
import { ProofView } from "@/views/ProofView";
import { useRouter } from "./router";
import { resolveRoute } from "./routes";

// The X-Ray page carries core-ts `buildXRay`: its own chunk, loaded when an X-Ray route opens.
// A chunk that fails to load (a redeploy changed the asset hashes) shows a notice, not a blank app.
const XRayView = lazy(() =>
  import("@/views/XRayView").then(
    (m) => ({ default: m.XRayView }),
    () => ({ default: XRayLoadFailed }),
  ),
);

function XRayLoadFailed() {
  return (
    <Card
      data-testid="xray-load-failed"
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle>{copy.xrayPage.loadFailed}</CardTitle>
      <CardDescription className="max-w-[560px]">{copy.xrayPage.loadFailedBody}</CardDescription>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        {copy.xrayPage.reload}
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
  return (
    <AppShell activeId={resolved.kind === "nav" ? resolved.route.id : null} title={title}>
      {resolved.kind === "not-found" ? (
        <NotFoundView path={resolved.path} />
      ) : resolved.route.id === "challenge" ? (
        <ChallengeView />
      ) : resolved.route.id === "proof" ? (
        <ProofView vaultId={resolved.vaultId ?? null} />
      ) : resolved.route.id === "xray" ? (
        <Suspense fallback={null}>
          <XRayView target={resolved.xray ?? null} />
        </Suspense>
      ) : (
        <PlaceholderView title={resolved.route.title} />
      )}
    </AppShell>
  );
}
