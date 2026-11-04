import type { AppConfig, HeartbeatState } from "@/app/data";
import { copy } from "@/copy";
import { cn } from "@/lib/utils";

/**
 * The Alerts line: healthy only on a fresh heartbeat; alarm unless still checking. The Proof
 * Page shows the same line.
 */
export function alerts(heartbeat: HeartbeatState): { text: string; ok: boolean; alarm: boolean } {
  switch (heartbeat.kind) {
    case "seen":
      return {
        text: copy.system.alertsSeen(heartbeat.minutes),
        ok: !heartbeat.stale,
        alarm: heartbeat.stale,
      };
    case "none":
      return { text: copy.system.alertsNone, ok: false, alarm: true };
    case "checking":
      return { text: copy.system.alertsChecking, ok: false, alarm: false };
    case "unreachable":
      return { text: copy.system.alertsUnreachable, ok: false, alarm: true };
    case "silent":
      return { text: copy.system.alertsSilent, ok: false, alarm: true };
  }
}

// Pinned to the bottom of the sidebar: network, contract state, co-signer account and the
// watcher heartbeat. The dot is `ok` only while the contract is locked and the watcher has
// reported within 5 minutes, alarm when either check fails, and muted while one is still
// checking; the failing line shows the alarm signal too.
export function SystemCard({ config }: { config: AppConfig }) {
  const locked = config.contract === "locked";
  const contractAlarm = config.contract === "unlocked" || config.contract === "unknown";
  const alert = alerts(config.heartbeat);
  const dot = contractAlarm || alert.alarm ? "alarm" : locked && alert.ok ? "ok" : "checking";
  return (
    <div
      data-testid="system-card"
      className="mt-auto min-w-0 rounded-md border border-line p-[14px] font-mono text-[12px] leading-[1.9] whitespace-nowrap text-muted"
    >
      <div className="flex items-center">
        <i
          aria-hidden="true"
          data-testid="system-dot"
          data-state={dot}
          className={cn(
            "mr-1.5 inline-block size-[7px] shrink-0 rounded-full",
            dot === "ok" && "bg-ok shadow-[0_0_10px_var(--color-ok)]",
            dot === "alarm" && "bg-alarm shadow-[0_0_10px_var(--color-alarm)]",
            dot === "checking" && "bg-muted",
          )}
        />
        <span className="truncate">{copy.systemNetwork(config.network)}</span>
      </div>
      <div data-testid="system-contract">
        {copy.system.contract}{" "}
        <b className={cn("font-medium", locked && "text-ink", contractAlarm && "text-alarm")}>
          {copy.system.contractState[config.contract]}
        </b>
      </div>
      <div className="flex min-w-0">
        <span className="shrink-0">{copy.system.coSigner}&nbsp;</span>
        <b className="truncate font-medium text-ink" title={config.coSigner}>
          {config.coSigner}
        </b>
      </div>
      <div
        data-testid="system-alerts"
        data-alarm={alert.alarm}
        className={cn("leading-[1.5] whitespace-normal", alert.alarm && "text-alarm")}
      >
        {alert.text}
      </div>
    </div>
  );
}
