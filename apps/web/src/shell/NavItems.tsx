import { Link } from "@/app/router";
import { NAV_ROUTES, type NavId } from "@/app/routes";
import { Badge } from "@/components/ui/badge";

// The six nav items, shared by the sidebar and the phone menu.
export function NavItems({
  activeId,
  onNavigate,
}: {
  activeId: NavId | null;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ROUTES.map(({ id, path, label, Icon, badge }) => (
        <li key={id}>
          <Link
            to={path}
            aria-current={id === activeId ? "page" : undefined}
            onClick={onNavigate}
            className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2.5 text-[15px] leading-none text-muted transition-colors hover:text-ink aria-[current=page]:bg-card-raised aria-[current=page]:text-ink"
          >
            <Icon />
            {label}
            {badge !== undefined && (
              <Badge
                variant="chip"
                className="ml-auto rounded-[8px] border-0 bg-line px-[7px] py-0.5 text-[11px] tracking-normal text-ink"
              >
                {badge}
              </Badge>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
