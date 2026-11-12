// Building blocks shared by the two wallet pages: a labelled card section, the wallet card,
// and the outcome line (also read out through the shell's polite live region).
import { useEffect, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { useAnnounce } from "@/shell/announce";
import { errorGloss, type Connected } from "./near";

const t = copy.vault;

/** `aria-disabled` keeps a button in the Tab order, so its reason can still be reached. */
export const softDisabled = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

export const inputClass =
  "min-h-11 w-full rounded-[12px] border border-line bg-page px-3 font-mono text-[13px] text-ink aria-invalid:border-alarm disabled:opacity-50";

export const body = "text-[14px] leading-[1.55] text-muted [overflow-wrap:anywhere]";

export const linkClass =
  "inline-flex min-h-11 items-center text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink";

/** A card that is a labelled region, with its heading. */
export function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `vault-${id}-title`;
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      data-testid={`vault-${id}`}
      className={cn("min-w-0 p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]", className)}
    >
      <h2 id={headingId} className="text-label text-muted">
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </Card>
  );
}

export type WalletStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "failed"; message: string }
  | { kind: "connected"; connected: Connected };

/** Connect (the page's orange action while nothing is connected), or the connected account. */
export function WalletCard({
  status,
  onConnect,
  onDisconnect,
}: {
  status: WalletStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Section id="wallet" title={t.wallet.title}>
      {status.kind === "connected" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="ok" data-testid="wallet-account">
            {t.wallet.connected(status.connected.accountId)}
          </Badge>
          <Button variant="secondary" onClick={onDisconnect}>
            {t.wallet.disconnect}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            data-testid="wallet-connect"
            aria-disabled={status.kind === "connecting"}
            className={softDisabled}
            onClick={() => status.kind !== "connecting" && onConnect()}
          >
            {status.kind === "connecting"
              ? t.wallet.connecting
              : status.kind === "failed"
                ? t.wallet.retry
                : t.wallet.connect}
          </Button>
        </div>
      )}
      {status.kind === "failed" && (
        <p data-testid="wallet-error" className="text-[14px] text-alarm [overflow-wrap:anywhere]">
          {t.wallet.loadFailed(status.message)}
        </p>
      )}
      <p className={body}>{t.wallet.hint}</p>
    </Section>
  );
}

export interface Outcome {
  tone: "ok" | "alarm" | "neutral";
  text: string;
  /** A link to show with it, e.g. the transaction on mempool.space. */
  link?: { href: string; text: string };
}

/** The latest outcome or step, also announced through the shell's live region. */
export function OutcomeLine({ outcome, testId }: { outcome: Outcome | null; testId: string }) {
  const announce = useAnnounce();
  const last = useRef("");
  useEffect(() => {
    if (outcome === null || outcome.text === last.current) return;
    last.current = outcome.text;
    announce(outcome.text);
  }, [outcome, announce]);
  if (outcome === null) return null;
  return (
    <div data-testid={testId} data-tone={outcome.tone} className="flex flex-col gap-1">
      <p
        className={cn(
          "text-[14px] [overflow-wrap:anywhere]",
          outcome.tone === "alarm" ? "text-alarm" : outcome.tone === "ok" ? "text-ok" : "text-ink",
        )}
      >
        {outcome.text}
      </p>
      {outcome.link !== undefined && (
        <a href={outcome.link.href} target="_blank" rel="noreferrer" className={linkClass}>
          {outcome.link.text}
        </a>
      )}
    </div>
  );
}

/** A refusal line: the verbatim `ERR_*` code with its meaning, else NEAR's own words. */
export function refusalText(code: string | null, message: string): string {
  const meaning = code === null ? null : errorGloss(code);
  return code !== null && meaning !== null
    ? t.page.outcome.refused(code, meaning)
    : t.page.outcome.refusedRaw(message.slice(0, 200));
}
