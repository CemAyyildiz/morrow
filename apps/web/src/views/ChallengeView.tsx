import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { downloadKeys } from "@/app/challenge";
import { useAppData, type ChallengeData } from "@/app/data";
import { LIVE_VAULT_ID, LIVE_VAULT_PATH, VAULT_NEW_PATH } from "@/app/wallet-paths";
import { linkClass } from "@/vault/ui";
import { AttemptLog } from "@/components/AttemptLog";
import { HeroCard } from "@/components/HeroCard";
import { TryPanel } from "@/components/TryPanel";
import { DotGrid, StatCard } from "@/components/StatCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useAnnounce } from "@/shell/announce";
import { PageHeader } from "@/shell/PageHeader";

// The Challenge product screen, fed by the challenge feed (story 7.2a): the round, its
// published keys, the Vault and every attempt. "Try with these keys" (story 7.2b) sends the
// full-balance request at once and brings the Try panel, with its X-Ray, into view.
export function ChallengeView() {
  const { challenge, challengeStatus, attempt } = useAppData();
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

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
          {!unreachable && (
            <p
              className="max-w-[460px] text-[14px] leading-[1.6] text-muted"
              data-testid="challenge-live"
            >
              {copy.challenge.noRoundLive}{" "}
              <a href={LIVE_VAULT_PATH} className={linkClass}>
                {copy.challenge.noRoundLiveLink(LIVE_VAULT_ID)}
              </a>
              ,{" "}
              <a href={VAULT_NEW_PATH} className={linkClass}>
                {copy.challenge.noRoundMake}
              </a>
            </p>
          )}
        </Card>
      </>
    );
  }

  const keys = challenge.keys;
  const onTry = attempt
    ? () => {
        if (attempt.request.enabled) attempt.run("request");
        panel.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
      }
    : undefined;
  return (
    <ChallengeScreen
      data={challenge}
      onTry={onTry}
      onDownload={keys ? () => downloadKeys(keys) : undefined}
      facts={<RoundFacts data={challenge} />}
    >
      {attempt && <TryPanel attempt={attempt} panelRef={panel} />}
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
  illustration = false,
  onTry,
  onDownload,
  tryRef,
  facts,
  children,
}: {
  data: ChallengeData;
  headingLevel?: 1 | 2 | undefined;
  /** The landing's laptop while no round is live: one chip says the values are a sample. */
  illustration?: boolean | undefined;
  onTry?: (() => void) | undefined;
  onDownload?: (() => void) | undefined;
  tryRef?: Ref<HTMLButtonElement> | undefined;
  facts?: ReactNode;
  children?: ReactNode;
}) {
  const chips = illustration ? [copy.challenge.sample] : [copy.challenge.round(data.round)];
  if (!illustration && data.keysPublished) chips.push(copy.challenge.keysPublished);
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
