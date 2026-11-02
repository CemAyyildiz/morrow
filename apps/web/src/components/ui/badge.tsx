import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Pill tags from DESIGN.md: `ok` and `alarm` for outcomes and error codes, `chip` for
// neutral facts in Geist Mono.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center rounded-full whitespace-nowrap",
  {
    variants: {
      variant: {
        ok: "bg-ok/8 px-2.5 py-1 text-[12px] font-medium text-ok",
        alarm: "bg-alarm/8 px-2.5 py-1 text-[12px] font-medium text-alarm",
        chip: "border border-line px-2.5 py-[5px] font-mono text-mono font-medium text-muted",
      },
    },
    defaultVariants: {
      variant: "chip",
    },
  },
);

function Badge({
  className,
  variant = "chip",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
