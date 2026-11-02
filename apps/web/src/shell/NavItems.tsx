import { Link } from "@/app/router";
import { NAV_ROUTES, type NavId } from "@/app/routes";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const item =
  "flex min-h-11 items-center gap-3 rounded-sm px-3 py-2.5 text-[15px] leading-none text-muted transition-colors";

// The six nav items, shared by the sidebar and the phone menu. `decorative` draws them as
// plain text (no links, no current page) for the product pictured on the landing.
export function NavItems({
  activeId,
  onNavigate,
  decorative = false,
}: {
  activeId: NavId | null;
  onNavigate?: () => void;
  decorative?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ROUTES.map(({ id, path, label, Icon, badge }) => {
        const content = (
          <>
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
          </>
        );
        return (
          <li key={id}>
            {decorative ? (
              <span className={cn(item, id === activeId && "bg-card-raised text-ink")}>
                {content}
              </span>
            ) : (
              <Link
                to={path}
                aria-current={id === activeId ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  item,
                  "hover:text-ink aria-[current=page]:bg-card-raised aria-[current=page]:text-ink",
                )}
              >
                {content}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
