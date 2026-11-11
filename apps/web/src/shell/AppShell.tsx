import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppData } from "@/app/data";
import { useRouter } from "@/app/router";
import type { NavId } from "@/app/routes";
import { copy } from "@/copy";
import { AnnounceContext } from "./announce";
import { PhoneBar, PhoneMenu, type MenuCloseFocus } from "./PhoneNav";
import { Sidebar } from "./Sidebar";
import { TestnetBanner } from "./TestnetBanner";

// The product frame: skip link, testnet banner, phone bar or sidebar, the main column, the
// phone menu, and the one polite live region. Screens announce live outcomes (a new Attempt
// Log row) through it with `useAnnounce`. Each announcement re-renders the region's line under
// a new key, so the same text announced twice (two flips in a row) is read twice.
//
// After each in-app navigation (not on first load) the region announces the page title,
// keyed on the path so two pages with one title are both announced, and focus moves to
// main. Closing the phone menu with Esc, its close button or an item returns focus to the
// menu button instead. While the menu is open everything else is `inert`.
export function AppShell({
  activeId,
  title,
  children,
}: {
  activeId: NavId | null;
  title: string;
  children: ReactNode;
}) {
  const { config } = useAppData();
  const { path } = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = useCallback(
    (text: string) => setAnnouncement((last) => ({ text, n: last.n + 1 })),
    [],
  );
  const main = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const lastPath = useRef(path);
  const pendingFocus = useRef<MenuCloseFocus | null>(null);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback((focus: MenuCloseFocus) => {
    pendingFocus.current = focus;
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    if (path === lastPath.current) return;
    lastPath.current = path;
    announce(title);
    // Browser Back with the menu open closes it.
    setMenuOpen(false);
    // A choice from the phone menu has already asked for the menu button.
    pendingFocus.current ??= "main";
  }, [path, title, announce]);

  // Restore focus once the menu is closed and the new page is rendered.
  useEffect(() => {
    if (menuOpen || pendingFocus.current === null) return;
    const target = pendingFocus.current === "menu" ? menuButton.current : main.current;
    pendingFocus.current = null;
    target?.focus();
  });

  return (
    <AnnounceContext.Provider value={announce}>
      <div className="flex min-h-dvh flex-col">
        <div inert={menuOpen} className="contents">
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
          {/* The banner landmark: the network strip and the phone bar sit in it, so no content
              is outside a landmark (story 9.5). */}
          <header>
            <TestnetBanner network={config.network} />
            <PhoneBar open={menuOpen} onOpen={openMenu} buttonRef={menuButton} />
          </header>
          <div className="flex flex-1 flex-col desktop:grid desktop:grid-cols-[232px_minmax(0,1fr)]">
            <Sidebar activeId={activeId} config={config} />
            <main
              ref={main}
              id="main"
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-stack px-gutter-mobile py-4 outline-none desktop:px-7 desktop:py-[22px]"
            >
              {children}
            </main>
          </div>
        </div>
        <PhoneMenu open={menuOpen} activeId={activeId} onClose={closeMenu} />
        <div aria-live="polite" className="sr-only" data-testid="live-region">
          <p key={`${path} ${announcement.n}`}>{announcement.text}</p>
        </div>
      </div>
    </AnnounceContext.Provider>
  );
}
