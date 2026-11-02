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

export function VaultIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function ChallengeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z" />
    </Icon>
  );
}

export function GuardiansIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
    </Icon>
  );
}

export function PolicyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
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
