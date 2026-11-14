import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppData } from "@/app/data";
import { Link, useRouter } from "@/app/router";
import { LANDING_PATH, LOST_PATH, PROOF_PATH } from "@/app/routes";
import { LIVE_VAULT_PATH, VAULT_NEW_PATH } from "@/app/wallet-paths";
import { copy } from "@/copy";
import { landingCopy } from "@/landing/copy";
import { cn } from "@/lib/utils";
import { AnnounceContext } from "@/shell/announce";
import { BackLink, type BackTarget } from "@/shell/BackLink";
import { TestnetBanner } from "@/shell/TestnetBanner";

const t = landingCopy;

// The frame of the wallet pages (`/vault/new`, `/vault/<id>`): the landing's top bar instead of
// the dashboard sidebar, one wide centred column, and the landing's footer. A visitor who came
// from the landing's "Try it" keeps the same nav, wordmark and orange pill; the product shell
// with its system card stays on the Challenge, Proof and X-Ray pages. It provides what screens
// take from the shell: the polite live region and `useAnnounce`.
export function WalletFrame({
  page,
  back,
  title,
  children,
}: {
  page: "create" | "vault";
  back: BackTarget;
  title: string;
  children: ReactNode;
}) {
  const { config } = useAppData();
  const { path } = useRouter();
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = useCallback(
    (text: string) => setAnnouncement((last) => ({ text, n: last.n + 1 })),
    [],
  );
  const main = useRef<HTMLElement>(null);
  const lastPath = useRef(path);
  useEffect(() => {
    if (path === lastPath.current) return;
    lastPath.current = path;
    announce(title);
    main.current?.focus();
  }, [path, title, announce]);

  const linkClass =
    "inline-flex min-h-11 items-center text-[15px] text-muted transition-colors hover:text-ink";
  return (
    <AnnounceContext.Provider value={announce}>
      <div className="flex min-h-dvh flex-col bg-page">
        <header className="sticky top-0 z-20 border-b border-line bg-page/90 backdrop-blur-md">
          <a
            href="#main"
            onClick={(event) => {
              event.preventDefault();
              main.current?.focus();
            }}
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-full focus:border focus:border-line focus:bg-card-raised focus:px-[18px] focus:text-[14px] focus:font-semibold focus:text-ink"
          >
            {copy.skipToContent}
          </a>
          <TestnetBanner network={config.network} />
          <nav
            aria-label={t.nav.label}
            data-testid="wallet-nav"
            className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-4 px-5 py-3 desktop:px-8"
          >
            <Link
              to={LANDING_PATH}
              data-testid="home-link"
              className="inline-flex min-h-11 items-center font-wordmark text-wordmark tracking-[0.02em] text-ink"
            >
              {t.wordmark}
            </Link>
            <div className="hidden items-center gap-7 desktop:flex">
              <a href={`${LANDING_PATH}#why`} className={linkClass}>
                {t.nav.howItWorks}
              </a>
              <a
                href={LIVE_VAULT_PATH}
                aria-current={path === LIVE_VAULT_PATH ? "page" : undefined}
                className={cn(linkClass, path === LIVE_VAULT_PATH && "text-ink")}
              >
                {t.nav.live}
              </a>
              <Link to={PROOF_PATH} className={linkClass}>
                {t.nav.proof}
              </Link>
              <a href={t.githubUrl} rel="noreferrer" className={linkClass}>
                {t.nav.github}
              </a>
            </div>
            {page === "vault" ? (
              <a
                href={VAULT_NEW_PATH}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-orange bg-orange px-5 text-[15px] font-semibold text-orange-foreground hover:bg-orange/90"
              >
                {copy.vault.frame.create}
              </a>
            ) : (
              <a
                href={LIVE_VAULT_PATH}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-line bg-card-raised px-5 text-[15px] font-semibold text-ink hover:bg-line"
              >
                {t.nav.live}
              </a>
            )}
          </nav>
        </header>
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-[1200px] min-w-0 flex-1 flex-col gap-7 px-5 pt-5 pb-16 outline-none desktop:gap-8 desktop:px-8 desktop:pt-7 desktop:pb-24"
        >
          <BackLink {...back} />
          {children}
        </main>
        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-5 font-mono text-[12px] text-muted desktop:px-8">
            <span>{t.footer.left}</span>
            <Link to={LOST_PATH} className="inline-flex min-h-11 items-center hover:text-ink">
              {t.footer.lost}
            </Link>
            <span>{t.footer.right(config.network.btc)}</span>
          </div>
        </footer>
        <div aria-live="polite" className="sr-only" data-testid="live-region">
          <p key={`${path} ${announcement.n}`}>{announcement.text}</p>
        </div>
      </div>
    </AnnounceContext.Provider>
  );
}
