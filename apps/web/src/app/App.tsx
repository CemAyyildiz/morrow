import { useEffect } from "react";
import { copy } from "@/copy";
import { AppShell } from "@/shell/AppShell";
import { ChallengeView } from "@/views/ChallengeView";
import { NotFoundView } from "@/views/NotFoundView";
import { PlaceholderView } from "@/views/PlaceholderView";
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

  const title = resolved.kind === "nav" ? resolved.route.title : copy.titles.notFound;

  useEffect(() => {
    document.title = `${title} · ${copy.wordmark}`;
  }, [title]);

  if (resolved.kind === "redirect") return null;

  return (
    <AppShell activeId={resolved.kind === "nav" ? resolved.route.id : null} title={title}>
      {resolved.kind === "not-found" ? (
        <NotFoundView path={resolved.path} />
      ) : resolved.route.id === "challenge" ? (
        <ChallengeView />
      ) : (
        <PlaceholderView title={resolved.route.title} />
      )}
    </AppShell>
  );
}
