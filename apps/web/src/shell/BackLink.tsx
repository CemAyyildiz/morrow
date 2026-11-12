import { Link } from "@/app/router";
import { BackIcon } from "./icons";

/** Where the link above a page leads: the landing, or the list page a detail page opened from. */
export interface BackTarget {
  to: string;
  label: string;
}

// The way out of every app page, above its header: a judge who opened a deep link
// (`/proof/33` from the README) has no browser history to go back through.
export function BackLink({ to, label }: BackTarget) {
  return (
    <Link
      to={to}
      data-testid="back-link"
      className="-my-1 inline-flex min-h-11 items-center gap-1.5 self-start rounded-full text-[14px] font-medium text-muted transition-colors hover:text-ink"
    >
      <BackIcon className="size-4" />
      {label}
    </Link>
  );
}
