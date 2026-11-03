import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { downloadKeys } from "@/app/challenge";
import { useAppData, type ChallengeData } from "@/app/data";
import { AttemptLog } from "@/components/AttemptLog";
import { HeroCard } from "@/components/HeroCard";
import { DotGrid, StatCard } from "@/components/StatCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";
import { useAnnounce } from "@/shell/announce";
import { PageHeader } from "@/shell/PageHeader";

// The Challenge product screen, fed by the challenge feed (story 7.2a): the round, its
// published keys, the Vault and every attempt. "Try with these keys" has no handler in the
// product yet (story 7.2b).
export function ChallengeView() {
  const { challenge, challengeStatus } = useAppData();

  if (!challenge) {
    // Until `/round` first answers, nothing is claimed: the header only.
    if (challengeStatus === "loading") return <PageHeader title={copy.titles.challenge} />;
    const unreachable = challengeStatus === "unreachable";
    // No feed configured, no round open, or a feed that does not answer: say which, instead
    // of showing skeletons that would suggest something is loading.
    return (
      <>
        <PageHeader title={copy.titles.challenge} />
        <Card
          data-testid={unreachable ? "challenge-unreachable" : "challenge-empty"}
          className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
        >
          <CardTitle>{unreachable ? copy.challenge.unreachable : copy.challenge.noRound}</CardTitle>
          <CardDescription className="max-w-[460px]">
            {unreachable ? copy.challenge.unreachableBody : copy.challenge.noRoundBody}
          </CardDescription>
        </Card>
      </>
    );
  }

  const keys = challenge.keys;
  return (
    <ChallengeScreen
      data={challenge}
      onDownload={keys ? () => downloadKeys(keys) : undefined}
      facts={<RoundFacts data={challenge} />}
    >
      <AttemptLog rows={challenge.log} />
      <AnnounceNewRows data={challenge} />
    </ChallengeScreen>
  );
}

/** The coins note, the rotation deadline and, once the bounty is open, its link. */
function RoundFacts({ data }: { data: ChallengeData }) {
  return (
    <section
      aria-label={copy.challenge.factsLabel}
      data-testid="round-facts"
      className="flex flex-wrap items-center gap-2 text-[14px] text-muted"
    >
      <Badge variant="chip" data-testid="coins-note">
        {data.coins}
      </Badge>
      {data.rotation && (
        <Badge variant="chip" data-testid="rotation">
          {copy.challenge.rotation(data.rotation.height, data.rotation.at)}
        </Badge>
      )}
      {data.bountyUrl !== null && (
        <Button asChild variant="secondary" className="desktop:ml-auto">
          <a href={data.bountyUrl} data-testid="bounty-link" rel="noreferrer">
            {copy.challenge.bounty}
          </a>
        </Button>
      )}
    </section>
  );
}

/** Reads each new Attempt Log row out once through the shell's polite live region. */
function AnnounceNewRows({ data }: { data: ChallengeData }) {
  const announce = useAnnounce();
  const fresh = (data.log ?? []).filter((row) => row.fresh);
  const text = fresh
    .map((row) => copy.attemptLog.announce(row.n, row.action, row.outcome.text))
    .join(". ");
  const last = useRef("");
  useEffect(() => {
    if (text === "" || text === last.current) return;
    last.current = text;
    announce(text);
  }, [text, announce]);
  return null;
}

/**
 * The Challenge screen for one round: header with chips and actions, the round facts, hero
 * card, stat row, then `children` (the attempt log; the landing adds the X-Ray). Shared by the
 * product route and the laptop screen of the landing.
 */
export function ChallengeScreen({
  data,
  headingLevel,
  onTry,
  onDownload,
  tryRef,
  facts,
  children,
}: {
  data: ChallengeData;
  headingLevel?: 1 | 2 | undefined;
  onTry?: (() => void) | undefined;
  onDownload?: (() => void) | undefined;
  tryRef?: Ref<HTMLButtonElement> | undefined;
  facts?: ReactNode;
  children?: ReactNode;
}) {
  const chips = [copy.challenge.round(data.round)];
  if (data.keysPublished) chips.push(copy.challenge.keysPublished);
  const coSigner = data.coSigner;

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
      {facts}
      <HeroCard data={data} />
      <div
        data-testid="stats"
        className={cn(
          "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 desktop:gap-stack",
          coSigner === "unreadable"
            ? "desktop:grid-cols-[repeat(3,minmax(0,1fr))]"
            : "desktop:grid-cols-[repeat(4,minmax(0,1fr))]",
        )}
      >
        <StatCard
          label={copy.challenge.heldInVault}
          value={data.vault.amount ?? undefined}
          unit={data.vault.unit}
        />
        <StatCard
          label={copy.challenge.delay}
          value={data.vault.delay ?? undefined}
          unit={copy.challenge.perWithdrawal}
        />
        <StatCard
          label={copy.challenge.satsTaken}
          value={data.satsTaken === null ? undefined : String(data.satsTaken)}
          tone={data.satsTaken === 0 ? "ok" : "default"}
        />
        {coSigner !== "unreadable" && (
          <StatCard
            label={copy.challenge.coSigner}
            value={coSigner === null ? undefined : `${coSigner.threshold}/${coSigner.total}`}
            aside={
              coSigner === null ? undefined : (
                <DotGrid on={coSigner.threshold} total={coSigner.total} />
              )
            }
          />
        )}
      </div>
      {children}
    </>
  );
}
