// The visual pieces of the wallet pages: line icons, the vertical step rail of /vault/new, the
// "how it works" strip, the Delay diagram and a copy button. No inline styles: the CSP of story
// 1.9b forbids style attributes, so every size is a class.
import { useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import type { IconProps } from "@/shell/icons";

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

/** A coin dropping into a tray: putting bitcoin in. */
export function DepositIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M4 13v4.5A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V13" strokeLinecap="round" />
      <path d="M8 15h8" strokeLinecap="round" />
    </Icon>
  );
}

/** A clock: the Delay. */
export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  );
}

/** An arrow turning back home: Claw back. */
export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Icon>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" strokeLinecap="round" />
    </Icon>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6.5A1.5 1.5 0 0 1 5.5 5H17" />
      <circle cx="16" cy="13.5" r="1.2" />
    </Icon>
  );
}

export function ThiefIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6" strokeLinecap="round" />
      <path d="M8.2 7.5h7.6" strokeLinecap="round" />
    </Icon>
  );
}

export type StepStatus = "done" | "current" | "later";

/** The numbered node of a step: its number, or a check once done. */
export function StepNode({ n, status }: { n: number; status: StepStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-full border font-mono text-[13px] transition-colors",
        status === "done" && "border-ok/40 bg-ok/10 text-ok",
        status === "current" && "border-ink bg-ink text-page",
        status === "later" && "border-line bg-card text-muted",
      )}
    >
      {status === "done" ? <CheckIcon className="size-4 stroke-2" /> : n}
    </span>
  );
}

/**
 * One step of the vertical rail: the node on a line that runs down to the next step, the title
 * with its done or current mark, and the step's card.
 */
export function RailStep({
  id,
  n,
  title,
  summary,
  status,
  last = false,
  children,
}: {
  id: string;
  n: number;
  title: string;
  /** Shown beside the title once the step is done. */
  summary?: string | null | undefined;
  status: StepStatus;
  last?: boolean;
  children: ReactNode;
}) {
  const headingId = `vault-${id}-title`;
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      data-testid={`vault-${id}`}
      data-status={status}
      className="relative flex gap-4 desktop:gap-5"
    >
      {!last && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-9 bottom-0 left-[17px] w-px",
            status === "done" ? "bg-ok/30" : "bg-line",
          )}
        />
      )}
      <StepNode n={n} status={status} />
      <div className={cn("min-w-0 flex-1", !last && "pb-7")}>
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
          <h2
            id={headingId}
            className={cn(
              "font-display text-[19px] font-normal tracking-[-0.01em]",
              status === "later" ? "text-muted" : "text-ink",
            )}
          >
            {title}
          </h2>
          {status === "done" && summary && (
            <span className="max-w-full truncate font-mono text-mono text-ok">{summary}</span>
          )}
        </div>
        <div
          className={cn(
            "bg-card-surface mt-3 flex flex-col gap-3 rounded-lg border p-card-pad-mobile transition-colors desktop:px-[22px] desktop:py-[18px]",
            status === "current" ? "border-muted/60" : "border-line",
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

const how = copy.vault.create.howSteps;

/** Three tiles: put bitcoin in, every withdrawal waits in public, Claw back sends it home. */
export function HowStrip() {
  const icons = [DepositIcon, ClockIcon, HomeIcon];
  return (
    <ol data-testid="vault-how" className="grid grid-cols-1 gap-3 desktop:grid-cols-3">
      {how.map((step, index) => {
        const StepIcon = icons[index] ?? DepositIcon;
        return (
          <li
            key={step.title}
            className="bg-card-surface relative flex gap-3 rounded-lg border border-line p-4 desktop:flex-col desktop:gap-4 desktop:p-5"
          >
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] border border-line bg-card-raised text-ink">
              <StepIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-mono text-muted">{`0${index + 1}`}</p>
              <p className="mt-1 text-[15px] font-semibold text-ink">{step.title}</p>
              <p className="mt-1 text-[13.5px] leading-[1.5] text-muted">{step.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const diagram = copy.vault.diagram;

/**
 * The Vault's two paths, drawn: a withdrawal request waits the Delay in public before NEAR
 * co-signs; during the wait Claw back sends the coins to the Recovery Address instead.
 */
export function DelayDiagram({
  delay,
  recovery,
  progress,
}: {
  /** The Delay, e.g. "1 hour". */
  delay: string;
  /** The Recovery Address, shortened, or null before one is chosen. */
  recovery: string | null;
  /** 0 to 1 while a request is waiting; null to draw the empty path. */
  progress?: number | null | undefined;
}) {
  const filled = progress === null || progress === undefined ? 0 : Math.min(1, progress);
  const ticks = 12;
  const lit = Math.round(filled * ticks);
  return (
    <figure data-testid="delay-diagram" className="flex flex-col gap-3">
      <figcaption className="sr-only">{diagram.caption(delay)}</figcaption>
      <div className="flex items-center gap-2" aria-hidden="true">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-card-raised text-ink">
          <ThiefIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex gap-[3px]">
            {Array.from({ length: ticks }, (_, i) => (
              <span
                key={i}
                className={cn("h-2 flex-1 rounded-full", i < lit ? "bg-ink" : "bg-line")}
              />
            ))}
          </div>
          <div className="flex justify-between font-mono text-[11px] text-muted">
            <span>{diagram.request}</span>
            <span className="text-ink">{diagram.waits(delay)}</span>
            <span>{diagram.cosign}</span>
          </div>
        </div>
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-card-raised font-mono text-[10px] text-muted">
          {diagram.near}
        </span>
      </div>
      <div className="ml-4 flex items-stretch gap-3" aria-hidden="true">
        <span className="w-4 shrink-0 rounded-bl-[10px] border-b border-l border-dashed border-ok/50" />
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-ok/25 bg-ok/5 px-3 py-2">
          <HomeIcon className="size-4 text-ok" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ok">{diagram.clawback}</p>
            <p className="truncate font-mono text-[11px] text-muted">
              {recovery ?? diagram.noRecovery}
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}

/** "tb1qabcd…wxyz": the start and end of a long address. */
export function shorten(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Copies `text` to the clipboard and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => undefined,
        );
      }}
      className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-card-raised px-3.5 text-[13px] font-medium text-ink hover:bg-line"
    >
      {copied ? <CheckIcon className="size-4 text-ok" /> : <CopyIcon className="size-4" />}
      {copied ? copy.vault.copied : copy.vault.copy}
    </button>
  );
}
