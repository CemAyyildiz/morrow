import type { ReactNode, Ref } from "react";
import { useAppData, type ChallengeData } from "@/app/data";
import { HeroCard } from "@/components/HeroCard";
import { DotGrid, StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { PageHeader } from "@/shell/PageHeader";

// The mockup's product screen. The actions have no handlers yet in the product (story 1.9a).
export function ChallengeView() {
  const { challenge } = useAppData();

  // No round data source exists before stories 7.1 and 7.2: say so instead of showing
  // skeletons that would suggest something is loading.
  if (!challenge) {
    return (
      <>
        <PageHeader title={copy.titles.challenge} />
        <Card
          data-testid="challenge-empty"
          className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
        >
          <CardTitle>{copy.challenge.noRound}</CardTitle>
          <CardDescription className="max-w-[460px]">{copy.challenge.noRoundBody}</CardDescription>
        </Card>
      </>
    );
  }

  return <ChallengeScreen data={challenge} />;
}

/**
 * The Challenge screen for one round: header with chips and actions, hero card, stat row,
 * then `children` (the landing adds the attempt log and the X-Ray). Shared by the product
 * route and the laptop screen of the landing.
 */
export function ChallengeScreen({
  data,
  headingLevel,
  onTry,
  onDownload,
  tryRef,
  children,
}: {
  data: ChallengeData;
  headingLevel?: 1 | 2 | undefined;
  onTry?: (() => void) | undefined;
  onDownload?: (() => void) | undefined;
  tryRef?: Ref<HTMLButtonElement> | undefined;
  children?: ReactNode;
}) {
  const chips = [copy.challenge.round(data.round)];
  if (data.keysPublished) chips.push(copy.challenge.keysPublished);

  return (
    <>
      <PageHeader
        title={copy.titles.challenge}
        chips={chips}
        headingLevel={headingLevel}
        actions={
          <>
            <Button variant="secondary" onClick={onDownload}>
              {copy.challenge.downloadKeys}
            </Button>
            <Button variant="primary" onClick={onTry} ref={tryRef}>
              {copy.challenge.tryKeys}
            </Button>
          </>
        }
      />
      <HeroCard data={data} />
      <div
        data-testid="stats"
        className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 desktop:grid-cols-[repeat(4,minmax(0,1fr))] desktop:gap-stack"
      >
        <StatCard
          label={copy.challenge.heldInVault}
          value={data.vault.amount}
          unit={data.vault.unit}
        />
        <StatCard
          label={copy.challenge.delay}
          value={data.vault.delay}
          unit={copy.challenge.perWithdrawal}
        />
        <StatCard
          label={copy.challenge.satsTaken}
          value={String(data.satsTaken)}
          tone={data.satsTaken === 0 ? "ok" : "default"}
        />
        <StatCard
          label={copy.challenge.coSigner}
          value={`${data.coSigner.threshold}/${data.coSigner.total}`}
          aside={<DotGrid on={data.coSigner.threshold} total={data.coSigner.total} />}
        />
      </div>
      {children}
    </>
  );
}
