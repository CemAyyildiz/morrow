import type { MorrowEvent, SpendOp } from "@morrow/core-ts";

/** A link button, or an inline button whose callback data is a server-side token. */
export type AlertButton = { text: string; url: string } | { text: string; callback: string };

export interface Alert {
  /** Telegram HTML. */
  html: string;
  buttons: AlertButton[];
  /**
   * Asks the chat to reply to this message (the typed-confirmation step). Only for a message
   * without buttons: Telegram allows one reply markup, and the inline keyboard wins.
   */
  forceReply?: boolean;
}

export interface AlertContext {
  /** Fixed app domain; without it alerts carry no links. */
  appUrl: string | null;
  /** Looks up an op for events that only carry its id. */
  getOp?: (opId: string) => Promise<SpendOp>;
}

export const SAFETY_FOOTER = "Morrow never asks for keys or seed words.";

export const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "2026-11-02 08:42 UTC" from NEAR nanoseconds. */
export function formatTime(ns: string): string {
  const iso = new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "0.01500000 BTC" from sats. */
export function formatBtc(sats: string): string {
  const value = BigInt(sats);
  return `${value / 100_000_000n}.${(value % 100_000_000n).toString().padStart(8, "0")} BTC`;
}

/**
 * The alert's link buttons, all to pages the web app has: the Vault's Proof Page (its state,
 * read live from the chain) and, when a Guardian may need to act, the Lost a device page,
 * which says how a Guardian claws back in this build (`begin_clawback`). There is no one-tap
 * Guardian screen yet, so no button claims one.
 */
export function alertButtons(
  appUrl: string | null,
  vaultId: string,
  actionable: boolean,
): AlertButton[] {
  const base = appUrl?.replace(/\/+$/, "");
  if (!base) return [];
  const proof: AlertButton = {
    text: "Proof Page",
    url: `${base}/proof/${encodeURIComponent(vaultId)}`,
  };
  return actionable ? [proof, { text: "How to claw back", url: `${base}/lost` }] : [proof];
}

function render(
  event: MorrowEvent,
  title: string,
  rows: [string, string][],
  appUrl: string | null,
  actionable: boolean,
): Alert {
  const lines = [
    `<i>Morrow · Vault ${escape(event.vault_id)} · ${formatTime(event.block_timestamp)}</i>`,
    `<b>${escape(title)}</b>`,
    "",
    ...rows.map(([label, value]) => `${escape(label)}: <code>${escape(value)}</code>`),
    "",
    escape(SAFETY_FOOTER),
  ];
  return { html: lines.join("\n"), buttons: alertButtons(appUrl, event.vault_id, actionable) };
}

/** The Guardian Alert for an event, or null when the event needs no alert. */
export async function formatAlert(event: MorrowEvent, ctx: AlertContext): Promise<Alert | null> {
  switch (event.kind) {
    case "withdrawal_requested":
      return render(
        event,
        "Withdrawal requested",
        [
          ["Amount", formatBtc(event.data.amount_sats)],
          ["To", event.data.destination],
          ["Executable at", formatTime(event.data.executable_at)],
          ["Request", `#${event.data.op_id}`],
        ],
        ctx.appUrl,
        true,
      );
    case "op_frozen": {
      if (event.data.kind !== "allowance" || !ctx.getOp) return null;
      const op = await ctx.getOp(event.data.op_id);
      return render(
        event,
        "Allowance spend",
        [
          ["Amount", formatBtc(op.amount_sats)],
          ["To", op.destination],
        ],
        ctx.appUrl,
        true,
      );
    }
    case "fast_approved":
      return render(
        event,
        `Fast-approved by ${event.data.by}`,
        [
          ["Request", `#${event.data.op_id}`],
          ["Executable at", formatTime(event.data.executable_at)],
        ],
        ctx.appUrl,
        true,
      );
    case "withdrawal_cancelled":
      return render(
        event,
        `Withdrawal #${event.data.op_id} cancelled`,
        [["By", event.data.by]],
        ctx.appUrl,
        false,
      );
    case "policy_change_proposed":
      return render(
        event,
        "Policy change proposed",
        [
          ...Object.entries(event.data.changes).map(([field, value]): [string, string] => [
            field,
            String(value),
          ]),
          ["Takes effect at", formatTime(event.data.effective_at)],
        ],
        ctx.appUrl,
        true,
      );
    case "policy_change_vetoed":
      return render(
        event,
        `Policy change #${event.data.change_id} vetoed`,
        [["By", event.data.by]],
        ctx.appUrl,
        false,
      );
    case "policy_change_withdrawn":
      return render(
        event,
        `Policy change #${event.data.change_id} withdrawn by the Owner`,
        [],
        ctx.appUrl,
        false,
      );
    case "policy_change_applied":
      return render(
        event,
        `Policy change #${event.data.change_id} is now in effect`,
        [],
        ctx.appUrl,
        false,
      );
    case "vault_clawed_back":
      return render(
        event,
        "Vault clawed back",
        [
          ["Sent home to", event.data.recovery_address],
          ["By", event.data.by],
        ],
        ctx.appUrl,
        false,
      );
    default:
      return null;
  }
}
