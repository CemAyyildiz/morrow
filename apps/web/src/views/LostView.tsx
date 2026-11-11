import type { ReactNode } from "react";
import { Link } from "@/app/router";
import { PROOF_PATH } from "@/app/routes";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";

const t = copy.lost;
const REPO = copy.proof.repoUrl;

/** Where the page's links lead: README sections and tools/escape on GitHub, and the Proof Page. */
export const LOST_LINKS = {
  scenarios: `${REPO}#scenarios`,
  trust: `${REPO}#trust-model`,
  escape: `${REPO}/tree/main/tools/escape`,
  proof: PROOF_PATH,
} as const;

const linkClass =
  "inline-flex min-h-11 items-center text-[13px] text-muted underline decoration-line underline-offset-4 hover:text-ink";
const body = "text-[14px] leading-[1.55] text-muted [overflow-wrap:anywhere]";
const note = "mt-1 text-[13px] leading-[1.5] text-muted [overflow-wrap:anywhere]";

// FR-31 / UJ-9: what to do when a device holding the Owner keys is lost. Public and static: it
// reads no chain data and needs no sign-in or key, and it links only to things that exist.
export function LostView() {
  const steps = [t.steps.clawback, t.steps.backup, t.steps.fresh];
  return (
    <>
      <PageHeader title={copy.titles.lost} />
      <p className="max-w-[720px] text-[15px] leading-[1.55] text-ink">{t.intro}</p>

      <Section id="steps" title={t.stepsTitle}>
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => (
            <li key={step.title} data-testid="lost-step" className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line font-mono text-mono text-ink"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] leading-7 font-semibold">{step.title}</h3>
                <p className={body}>{step.body}</p>
                {"build" in step && <p className={note}>{step.build}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <div className="grid grid-cols-1 items-start gap-stack desktop:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="guardian" title={t.guardianTitle}>
            <p className={body}>{t.guardian}</p>
            <p className={cn(body, "mt-2")}>{t.guardianAlert}</p>
            <p className={cn(body, "mt-2")}>{t.guardianNoAnswer}</p>
            <Link
              to={LOST_LINKS.proof}
              className={cn(buttonVariants({ variant: "secondary" }), "mt-3")}
            >
              {t.openProof}
            </Link>
          </Section>
          <Section id="escape" title={t.escapeTitle}>
            <Item title={t.escape.title}>{t.escape.body}</Item>
            <Item title={t.refresh.title} note={t.refresh.build}>
              {t.refresh.body}
            </Item>
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-stack">
          <Section id="thief" title={t.thiefTitle}>
            <List testId="lost-can" title={t.canTitle} items={Object.values(t.can)} />
            <List testId="lost-cannot" title={t.cannotTitle} items={Object.values(t.cannot)} />
          </Section>
          <Section id="links" title={t.linksTitle}>
            <ul className="flex flex-col">
              <li>
                <External href={LOST_LINKS.scenarios}>{t.links.scenarios}</External>
              </li>
              <li>
                <External href={LOST_LINKS.trust}>{t.links.trust}</External>
              </li>
              <li>
                <External href={LOST_LINKS.escape}>{t.links.escape}</External>
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

/** A card that is a labelled region, with its heading (the Proof Page's section style). */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `lost-${id}-title`;
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      data-testid={`lost-${id}`}
      className="min-w-0 p-card-pad-mobile desktop:px-[22px] desktop:py-[18px]"
    >
      <h2 id={headingId} className="text-label text-muted">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function Item({
  title,
  note: extra,
  children,
}: {
  title: string;
  note?: string;
  children: string;
}) {
  return (
    <div className="not-first:mt-4">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <p className={cn(body, "mt-1")}>{children}</p>
      {extra !== undefined && <p className={note}>{extra}</p>}
    </div>
  );
}

function List({ testId, title, items }: { testId: string; title: string; items: string[] }) {
  return (
    <div className="not-first:mt-4">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <ul data-testid={testId} className="mt-1 flex list-disc flex-col gap-1 pl-5">
        {items.map((item) => (
          <li key={item} className={body}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A link off the site, in a new tab; its accessible name says so. */
function External({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={t.newTab(children)}
      className={linkClass}
    >
      {children}
    </a>
  );
}
