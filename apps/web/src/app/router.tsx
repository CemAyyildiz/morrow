// A small history router: one path in state, pushState on navigation, popstate on Back. A move
// into or out of the wallet pages is a full page load instead (wallet-paths.ts).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { crossesWalletBoundary } from "./wallet-paths";

interface RouterValue {
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** `/challenge/` and `/challenge` are the same route. */
export function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function settle(pathname: string, redirects: Readonly<Record<string, string>>): string {
  const path = normalizePath(pathname);
  const target = redirects[path];
  if (target !== undefined && crossesWalletBoundary(path, target)) {
    window.location.replace(target);
    return path;
  }
  if (target !== undefined) {
    window.history.replaceState(window.history.state, "", target);
    return target;
  }
  return path;
}

export function RouterProvider({
  redirects,
  children,
}: {
  redirects: Readonly<Record<string, string>>;
  children: ReactNode;
}) {
  const [path, setPath] = useState(() => settle(window.location.pathname, redirects));

  useEffect(() => {
    const onPop = () => setPath(settle(window.location.pathname, redirects));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [redirects]);

  const navigate = useCallback<RouterValue["navigate"]>(
    (to, options) => {
      const target = redirects[normalizePath(to)] ?? to;
      // Re-choosing the current page adds no history entry.
      if (normalizePath(target) === normalizePath(window.location.pathname)) return;
      if (crossesWalletBoundary(window.location.pathname, target)) {
        if (options?.replace) window.location.replace(target);
        else window.location.assign(target);
        return;
      }
      if (options?.replace) window.history.replaceState(null, "", target);
      else window.history.pushState(null, "", target);
      setPath(normalizePath(target));
      window.scrollTo(0, 0);
    },
    [redirects],
  );

  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const router = useContext(RouterContext);
  if (!router) throw new Error("useRouter needs a RouterProvider");
  return router;
}

/**
 * An `<a>` that navigates in place; modified clicks keep the browser's behaviour, and so does a
 * link into or out of the wallet pages (a full page load).
 */
export function Link({
  to,
  onClick,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { to: string }) {
  const { navigate } = useRouter();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (crossesWalletBoundary(window.location.pathname, to)) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handleClick} {...props} />;
}
