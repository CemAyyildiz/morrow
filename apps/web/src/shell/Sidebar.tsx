import type { AppConfig } from "@/app/data";
import type { NavId } from "@/app/routes";
import { copy } from "@/copy";
import { NavItems } from "./NavItems";
import { SystemCard } from "./SystemCard";

// Desktop sidebar (900 px and wider): wordmark, the six nav items, the system card.
export function Sidebar({ activeId, config }: { activeId: NavId | null; config: AppConfig }) {
  return (
    <aside
      data-testid="sidebar"
      className="hidden min-w-0 flex-col overflow-hidden border-r border-line bg-page px-[18px] py-[22px] desktop:flex"
    >
      <div className="px-2.5 pb-[30px] font-display text-[22px] leading-none font-semibold tracking-[-0.02em]">
        {copy.wordmark}
      </div>
      <nav aria-label={copy.nav.label} className="mb-[22px]">
        <NavItems activeId={activeId} />
      </nav>
      <SystemCard config={config} />
    </aside>
  );
}
