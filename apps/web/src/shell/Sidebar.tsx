import type { AppConfig } from "@/app/data";
import type { NavId } from "@/app/routes";
import { copy } from "@/copy";
import { NavItems } from "./NavItems";
import { SystemCard } from "./SystemCard";

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
      <div className="px-2.5 pb-[30px] font-display text-[22px] leading-none font-semibold tracking-[-0.02em]">
        {copy.wordmark}
      </div>
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
