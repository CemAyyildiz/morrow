import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Pill buttons from DESIGN.md. Focus uses the global 2 px `ink` ring (theme.css).
// `primary` is orange and appears at most once per view.
const buttonVariants = cva(
  "inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border px-[18px] py-[11px] font-sans text-[14px] leading-none font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "border-orange bg-orange text-orange-foreground hover:bg-orange/90",
        secondary: "border-line bg-card-raised text-ink hover:bg-line",
        clawback: "border-alarm bg-alarm text-alarm-foreground hover:bg-alarm/90",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

function Button({
  className,
  variant = "secondary",
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
