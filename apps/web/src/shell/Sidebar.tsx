import type { AppConfig } from "@/app/data";
import { LANDING_PATH } from "@/app/routes";
import { Link } from "@/app/router";
import type { NavId } from "@/app/routes";
import { copy } from "@/copy";
import { NavItems } from "./NavItems";
import { SystemCard } from "./SystemCard";

const wordmark =
  "px-2.5 pb-[30px] font-display text-[22px] leading-none font-semibold tracking-[-0.02em]";

// Desktop sidebar (900 px and wider): wordmark, the nav items, the system card.
// `decorative` is the picture of the sidebar on the landing: no nav landmark, no links, no
// current page, hidden from assistive tech and out of reach.
export function Sidebar({
  activeId,
  config,
  decorative = false,
}: {
  activeId: NavId | null;
  config: AppConfig;
  decorative?: boolean;
}) {
  return (
    <aside
      data-testid="sidebar"
      aria-hidden={decorative || undefined}
      inert={decorative}
      className="hidden min-w-0 flex-col overflow-hidden border-r border-line bg-page px-[18px] py-[22px] desktop:flex"
    >
      {decorative ? (
        <div className={wordmark}>{copy.wordmark}</div>
      ) : (
        // The way back to the landing from every app page, also for a judge who opened a deep link.
        <Link to={LANDING_PATH} data-testid="home-link" className={`${wordmark} self-start`}>
          {copy.wordmark}
        </Link>
      )}
      {decorative ? (
        <div className="mb-[22px]">
          <NavItems activeId={activeId} decorative />
        </div>
      ) : (
        <nav aria-label={copy.nav.label} className="mb-[22px]">
          <NavItems activeId={activeId} />
        </nav>
      )}
      <SystemCard config={config} />
    </aside>
  );
}
