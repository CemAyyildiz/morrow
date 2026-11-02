import type * as React from "react";
import { cn } from "@/lib/utils";

// Decorative placeholder block. The sweep stops under prefers-reduced-motion (theme.css).
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("skeleton-sweep animate-shimmer rounded-sm", className)}
      {...props}
    />
  );
}

export { Skeleton };
