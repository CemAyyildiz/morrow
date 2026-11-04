import { useEffect } from "react";
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
      ) : (
        <PlaceholderView title={resolved.route.title} />
      )}
    </AppShell>
  );
}
