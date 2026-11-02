import { Link } from "@/app/router";
import { HOME_PATH } from "@/app/routes";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";
import { PageHeader } from "@/shell/PageHeader";

export function NotFoundView({ path }: { path: string }) {
  return (
    <>
      <PageHeader title={copy.titles.notFound} />
      <Card
        data-testid="not-found"
        className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
      >
        <CardTitle>{copy.titles.notFound}</CardTitle>
        <CardDescription className="max-w-full font-mono text-mono [overflow-wrap:anywhere]">
          {copy.notFound.body(path)}
        </CardDescription>
        <Link to={HOME_PATH} className={buttonVariants({ variant: "secondary" })}>
          {copy.notFound.link}
        </Link>
      </Card>
    </>
  );
}
