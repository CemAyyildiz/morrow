import type * as React from "react";
import { cn } from "@/lib/utils";

// DESIGN.md card: lit gradient surface, 1 px `line` border, 18 px radius, no shadow.
// Padding is set per use (hero 26/30, stat 14/18).
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("bg-card-surface rounded-lg border border-line text-ink", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("font-display text-[22px] font-normal tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-muted", className)} {...props} />;
}

export { Card, CardTitle, CardDescription };
