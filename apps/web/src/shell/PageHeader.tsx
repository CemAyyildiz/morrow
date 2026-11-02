import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

// Page title, mono chips and the action row. On phones the row takes the full width and
// each action spans it, the primary one included.
export function PageHeader({
  title,
  chips = [],
  actions,
}: {
  title: string;
  chips?: readonly string[];
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 desktop:flex-nowrap desktop:gap-[14px]">
      <h1 className="font-display text-[22px] leading-[1.2] font-medium tracking-[-0.02em] desktop:text-[26px]">
        {title}
      </h1>
      {chips.map((chip) => (
        <Badge key={chip} variant="chip">
          {chip}
        </Badge>
      ))}
      {actions !== undefined && (
        <div
          data-testid="header-actions"
          className="flex w-full flex-col gap-2 desktop:ml-auto desktop:w-auto desktop:flex-row desktop:gap-2.5 max-desktop:[&>*]:w-full"
        >
          {actions}
        </div>
      )}
    </header>
  );
}
