import type { AppConfig } from "@/app/data";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

// Pinned to the bottom of the sidebar: network, contract state and co-signer account.
// The dot is `ok` only while the contract is locked.
export function SystemCard({ config }: { config: AppConfig }) {
  const locked = config.contract === "locked";
  return (
    <div
      data-testid="system-card"
      className="mt-auto min-w-0 rounded-md border border-line p-[14px] font-mono text-[12px] leading-[1.9] whitespace-nowrap text-muted"
    >
      <div className="flex items-center">
        <i
          aria-hidden="true"
          data-testid="system-dot"
          className={cn(
            "mr-1.5 inline-block size-[7px] shrink-0 rounded-full",
            locked
              ? "bg-ok shadow-[0_0_10px_var(--color-ok)]"
              : "bg-alarm shadow-[0_0_10px_var(--color-alarm)]",
          )}
        />
        <span className="truncate">{copy.systemNetwork(config.network)}</span>
      </div>
      <div>
        {copy.system.contract}{" "}
        <b className={cn("font-medium", locked ? "text-ink" : "text-alarm")}>
          {copy.system.contractState[config.contract]}
        </b>
      </div>
      <div className="flex min-w-0">
        <span className="shrink-0">{copy.system.coSigner}&nbsp;</span>
        <b className="truncate font-medium text-ink" title={config.coSigner}>
          {config.coSigner}
        </b>
      </div>
    </div>
  );
}
