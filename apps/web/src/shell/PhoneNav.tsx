import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import type { NavId } from "@/app/routes";
import { copy } from "@/copy";
import { CloseIcon, MenuIcon } from "./icons";
import { NavItems } from "./NavItems";

const DESKTOP_QUERY = "(min-width: 900px)";
const SCROLL_LOCK_CLASS = "scroll-locked";
const MENU_ID = "phone-menu";

/** Where focus goes when the menu closes: back to the menu button, or to main. */
export type MenuCloseFocus = "menu" | "main";

const iconButton =
  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-card-raised text-ink transition-colors hover:bg-line";

const wordmark = "font-display text-[22px] leading-none font-semibold tracking-[-0.02em]";

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
}

// Phone shell (below 900 px): a top bar with the wordmark and a menu button.
export function PhoneBar({
  open,
  onOpen,
  buttonRef,
}: {
  open: boolean;
  onOpen: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <div
      data-testid="phone-bar"
      className="flex items-center justify-between border-b border-line px-gutter-mobile py-2 desktop:hidden"
    >
      <div className={wordmark}>{copy.wordmark}</div>
      <button
        ref={buttonRef}
        type="button"
        aria-label={copy.nav.openMenu}
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
        onClick={onOpen}
        className={iconButton}
      >
        <MenuIcon />
      </button>
    </div>
  );
}

// The six nav items as a full-height panel. No dialog library: focus moves into the panel
// and is kept there, Esc / close / choosing an item closes it, page scroll is locked with a
// class on <html>, and the shell marks everything else `inert` while it is open. The shell
// owns `open` and restores focus after it closes.
export function PhoneMenu({
  open,
  activeId,
  onClose,
}: {
  open: boolean;
  activeId: NavId | null;
  onClose: (focus: MenuCloseFocus) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add(SCROLL_LOCK_CLASS);
    const first = panel.current ? focusables(panel.current)[0] : undefined;
    first?.focus();
    return () => root.classList.remove(SCROLL_LOCK_CLASS);
  }, [open]);

  // The panel only exists on phones: close it if the window grows into the desktop layout,
  // where the menu button is hidden, so focus goes to main.
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (query.matches) onClose("main");
    };
    if (query.matches) onClose("main");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open, onClose]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose("menu");
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = focusables(panel.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    // Focus on the panel itself (a tap on blank space) counts as before the first item.
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={panel}
      id={MENU_ID}
      role="dialog"
      aria-modal="true"
      aria-label={copy.nav.menu}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-page px-gutter-mobile py-2 outline-none desktop:hidden"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className={wordmark}>{copy.wordmark}</div>
        <button
          type="button"
          aria-label={copy.nav.closeMenu}
          onClick={() => onClose("menu")}
          className={iconButton}
        >
          <CloseIcon />
        </button>
      </div>
      <nav aria-label={copy.nav.label}>
        <NavItems activeId={activeId} onNavigate={() => onClose("menu")} />
      </nav>
    </div>
  );
}
