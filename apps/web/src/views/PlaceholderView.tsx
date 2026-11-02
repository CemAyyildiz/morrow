import { HeroCard } from "@/components/HeroCard";
import { StatSkeletonRow } from "@/components/StatCard";
import { copy } from "@/copy";
import { PageHeader } from "@/shell/PageHeader";

// Vault, Guardians, Policy, Proof and X-Ray before their stories land: the title and
// skeleton cards, and no primary action.
export function PlaceholderView({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <p className="sr-only">{copy.placeholder}</p>
      <HeroCard />
      <StatSkeletonRow />
    </>
  );
}
