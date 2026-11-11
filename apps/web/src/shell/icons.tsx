// The mockup's own line icons (24 × 24, stroke 1.6), plus menu and close for the phone bar.
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type IconProps = Omit<ComponentProps<"svg">, "children">;

function Icon({ className, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn("size-[18px] shrink-0 fill-none stroke-current stroke-[1.6]", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChallengeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z" />
    </Icon>
  );
}

export function ProofIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4h10l4 4v12H5z" />
      <path d="M9 13l2 2 4-4" />
    </Icon>
  );
}

export function XRayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h4l2-6 4 12 2-6h4" />
    </Icon>
  );
}

/** A phone with a question mark: the Lost a device page. */
export function LostIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="3" width="12" height="18" rx="2.5" />
      <path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5" strokeLinecap="round" />
      <path d="M12 16.5v.01" strokeLinecap="round" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </Icon>
  );
}
