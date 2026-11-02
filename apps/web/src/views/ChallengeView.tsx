import { useAppData } from "@/app/data";
import { HeroCard } from "@/components/HeroCard";
import { DotGrid, StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { PageHeader } from "@/shell/PageHeader";

// The mockup's product screen. The actions have no handlers yet (story 1.9a).
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

  const chips = [copy.challenge.round(challenge.round)];
  if (challenge.keysPublished) chips.push(copy.challenge.keysPublished);

  return (
    <>
      <PageHeader
        title={copy.titles.challenge}
        chips={chips}
        actions={
          <>
            <Button variant="secondary">{copy.challenge.downloadKeys}</Button>
            <Button variant="primary">{copy.challenge.tryKeys}</Button>
          </>
        }
      />
      <HeroCard data={challenge} />
      <div
        data-testid="stats"
        className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 desktop:grid-cols-[repeat(4,minmax(0,1fr))] desktop:gap-stack"
      >
        <StatCard
          label={copy.challenge.heldInVault}
          value={challenge.vault.amount}
          unit={challenge.vault.unit}
        />
        <StatCard
          label={copy.challenge.delay}
          value={challenge.vault.delay}
          unit={copy.challenge.perWithdrawal}
        />
        <StatCard
          label={copy.challenge.satsTaken}
          value={String(challenge.satsTaken)}
          tone={challenge.satsTaken === 0 ? "ok" : "default"}
        />
        <StatCard
          label={copy.challenge.coSigner}
          value={`${challenge.coSigner.threshold}/${challenge.coSigner.total}`}
          aside={<DotGrid on={challenge.coSigner.threshold} total={challenge.coSigner.total} />}
        />
      </div>
    </>
  );
}
