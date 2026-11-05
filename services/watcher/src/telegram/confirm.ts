import {
  DAY_NS,
  HOUR_NS,
  MINUTE_NS,
  type ContractClient,
  type PolicyChange,
  type U64,
  type Vault,
} from "@morrow/core-ts";
import type { ChainClock } from "../clock.js";
import { changeBinding } from "../guard/binding.js";
import type { GuardEntry, GuardStore } from "../guard/store.js";
import type { ConfirmationRequests } from "../guard/ticker.js";
import type { Logger } from "../log.js";
import { SAFETY_FOOTER, escape, formatBtc, formatTime, type Alert } from "./alerts.js";
import type { Sender } from "./handler.js";
import type { CallbackGrant, Link, LinkStore, Redeemed } from "./links.js";

/** The typed-confirmation step stays open this long. */
export const PROMPT_WINDOW_NS = 10n * MINUTE_NS;

/** The loosening guard's side of Owner Confirmation. */
export interface ConfirmationGuard {
  store: GuardStore;
  /** Sends the veto now (Reject); true once the change is vetoed. A failure is retried by the ticker. */
  vetoNow(changeId: U64): Promise<boolean>;
}

export interface OwnerConfirmationOptions {
  links: LinkStore;
  sender: Sender;
  /** Unsigned client for views. */
  reader: Pick<ContractClient, "getVault" | "getPolicyChange">;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  log: Logger;
  /** Without the guard (no Auto-Clawback Guardian configured) only link buttons work. */
  guard?: ConfirmationGuard;
}

/** What a button press answers (`answerCallbackQuery`), plus work to run after the answer. */
export interface PressResult {
  answer: string;
  after?: () => Promise<void>;
}

const pad = (n: bigint) => n.toString();

/** "7 d", "24 h", "10 min", or nanoseconds when not a whole minute. */
function formatDuration(ns: string): string {
  const value = BigInt(ns);
  if (value > 0n && value % DAY_NS === 0n) return `${pad(value / DAY_NS)} d`;
  if (value > 0n && value % HOUR_NS === 0n) return `${pad(value / HOUR_NS)} h`;
  if (value > 0n && value % MINUTE_NS === 0n) return `${pad(value / MINUTE_NS)} min`;
  return `${ns} ns`;
}

const FIELDS: Record<string, { label: string; format: (value: string) => string }> = {
  recovery_address: { label: "Recovery Address", format: (v) => v },
  delay_ns: { label: "Delay", format: formatDuration },
  policy_change_delay_ns: { label: "Policy Change Delay", format: formatDuration },
  allowance_limit_sats: { label: "Spending Allowance (24 h)", format: formatBtc },
  fee_cap_sats: { label: "Fee Cap", format: formatBtc },
  fast_approval: { label: "Fast Approval", format: (v) => (v === "true" ? "on" : "off") },
  fast_approval_floor_ns: { label: "Fast Approval Floor", format: formatDuration },
};

/** One field as "Label: old → new", each value in full. */
function changeRow(field: string, old: unknown, next: unknown): string {
  const known = FIELDS[field];
  const show = (value: unknown) => {
    if (value === undefined || value === null) return "unset";
    try {
      return known ? known.format(String(value)) : String(value);
    } catch {
      return String(value);
    }
  };
  return `${escape(known?.label ?? field)}: <code>${escape(show(old))}</code> → <code>${escape(show(next))}</code>`;
}

/** The Owner Confirmation request: every changed field old → new, the times, and the buttons. */
export function requestAlert(
  vault: Vault,
  change: PolicyChange,
  vetoAt: U64,
  tokens: { confirm: string; reject: string },
): Alert {
  const policy = vault.policy as unknown as Record<string, unknown>;
  const rows = Object.keys(change.changes)
    .sort()
    .map((field) =>
      changeRow(field, policy[field], (change.changes as Record<string, unknown>)[field]),
    );
  const typed = typeof change.changes.recovery_address === "string";
  return {
    html: [
      `<i>Morrow · Vault ${escape(vault.vault_id)} · ${formatTime(change.proposed_at)}</i>`,
      `<b>Owner Confirmation for Policy Change #${escape(change.change_id)}</b>`,
      "",
      ...rows,
      `Takes effect at: <code>${formatTime(change.effective_at)}</code>`,
      `Veto at: <code>${formatTime(vetoAt)}</code>`,
      "",
      "This change loosens the Vault's rules. Unless you confirm it, the Morrow watcher vetoes it at the veto time. Confirm only if you proposed it yourself." +
        (typed
          ? " To confirm, you will type the last 6 characters of the new Recovery Address."
          : ""),
      escape(SAFETY_FOOTER),
    ].join("\n"),
    buttons: [
      { text: "Confirm", callback: tokens.confirm },
      { text: "Reject", callback: tokens.reject },
    ],
  };
}

const plain = (text: string): Alert => ({ html: escape(text), buttons: [] });

const promptAlert = (changeId: U64, again: boolean): Alert => ({
  html: escape(
    `${again ? "That does not match. " : ""}To confirm Policy Change #${changeId}, reply with the last 6 characters of the new Recovery Address within 10 minutes.`,
  ),
  buttons: [],
  forceReply: true,
});

const roleName = (link: Link) => (link.role === "owner" ? "Owner" : "Guardian");

/** The /start answer for a redeemed link code. */
export function linkedReply(redeemed: Redeemed): string {
  const { link } = redeemed;
  const vault = link.vault_id;
  const when = link.activated_at ? formatTime(link.activated_at) : "now";
  if (redeemed.relinked) {
    return `This chat is already linked to Vault ${vault} as its ${roleName(link)}. ${SAFETY_FOOTER}`;
  }
  if (link.role === "guardian") {
    return `Connected. You will get alerts for Vault ${vault} as its Guardian. ${SAFETY_FOOTER}`;
  }
  if (redeemed.replaces) {
    return `Linked as the Owner of Vault ${vault}, pending. The current owner chat can approve this now; otherwise this chat replaces it at ${when}. Every chat of the Vault was told. ${SAFETY_FOOTER}`;
  }
  return `Connected. You will get alerts for Vault ${vault} as its Owner. This chat can confirm Policy Changes proposed from ${when} on. ${SAFETY_FOOTER}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Owner Confirmation over Telegram (5.3b), plus the owner-link buttons:
 * - `request`: delivers the Confirm / Reject request of a loosening change to the owner chats;
 * - `press`: one inline button press, identified only by its random server-side token;
 * - `reply`: the typed last 6 characters of a new Recovery Address;
 * - `announceLink`: tells every other chat of the Vault about a new link (R4), with Approve and
 *   Cancel for the owner chat in force when the new link would replace it (R2).
 * Every state change is written before the chat is answered.
 */
export class OwnerConfirmation implements ConfirmationRequests {
  constructor(private readonly options: OwnerConfirmationOptions) {}

  async request(entry: GuardEntry, now: bigint): Promise<void> {
    const { links, reader, sender, log, guard } = this.options;
    if (!guard) return;
    const owners = await links.ownerLinks(entry.vault_id, now);
    const recipients = [owners.current, owners.pending].filter(
      (link): link is Link => link !== null && !entry.request_chats.includes(link.chat_id),
    );
    if (!recipients.length) return;
    const change = await reader.getPolicyChange(entry.change_id);
    if (change.state !== "pending") return;
    const binding = changeBinding(change);
    const fields = { vault_id: entry.vault_id, change_id: entry.change_id };
    if (entry.binding !== null && entry.binding !== binding) {
      log(
        "error",
        "loosening guard: change differs from the one requested; no request sent",
        fields,
      );
      return;
    }
    const vault = await reader.getVault(entry.vault_id);
    for (const link of recipients) {
      // Recorded before it is sent, so a restart never sends the same request twice.
      const recorded = await guard.store.modify(entry.change_id, (e) =>
        e.status === "scheduled" &&
        (e.confirmation === "none" || e.confirmation === "requested") &&
        !e.request_chats.includes(link.chat_id)
          ? {
              ...e,
              confirmation: "requested",
              binding,
              request_chats: [...e.request_chats, link.chat_id],
            }
          : null,
      );
      if (!recorded) continue;
      const grant = {
        vault_id: entry.vault_id,
        chat_id: link.chat_id,
        change_id: entry.change_id,
        link_chat_id: null,
      };
      const [confirm, reject] = await links.issueCallbacks(
        [
          { ...grant, action: "confirm" },
          { ...grant, action: "reject" },
        ],
        now,
      );
      try {
        await sender.send(
          link.chat_id,
          requestAlert(vault, change, entry.veto_at, {
            confirm: confirm as string,
            reject: reject as string,
          }),
        );
      } catch (error) {
        // Not delivered: let the next tick try again.
        await guard.store.modify(entry.change_id, (e) => {
          const request_chats = e.request_chats.filter((c) => c !== link.chat_id);
          const confirmation =
            e.confirmation === "requested" && request_chats.length === 0 ? "none" : e.confirmation;
          return { ...e, request_chats, confirmation };
        });
        throw error;
      }
      log("info", "loosening guard: owner confirmation requested", fields);
    }
  }

  async press(chatId: number, token: string): Promise<PressResult> {
    const grant = await this.options.links.callback(token);
    // A token sent to another chat (a Guardian's, say) changes nothing.
    if (!grant || grant.chat_id !== chatId) return { answer: "This button is no longer valid." };
    switch (grant.action) {
      case "confirm":
        return this.confirm(grant, chatId);
      case "reject":
        return this.reject(grant, chatId);
      case "approve_link":
        return this.approve(grant, chatId);
      case "cancel_link":
        return this.cancel(grant, chatId);
    }
  }

  /** Handles a text message; true when it answered an open typed-confirmation step. */
  async reply(chatId: number, text: string): Promise<boolean> {
    const { links, clock, sender } = this.options;
    const prompt = await links.prompt(chatId);
    if (!prompt) return false;
    const now = await clock.now();
    if (now > BigInt(prompt.expires_at)) {
      await links.closePrompts((p) => p.chat_id === chatId);
      await sender.send(
        chatId,
        plain("The 10-minute window closed. Press Confirm again to retry."),
      );
      return true;
    }
    if (text.trim().toLowerCase() !== prompt.suffix) {
      // Still requested: ask again, with a new window.
      await links.openPrompt({ ...prompt, expires_at: (now + PROMPT_WINDOW_NS).toString() });
      await sender.send(chatId, promptAlert(prompt.change_id, true));
      return true;
    }
    await links.closePrompts((p) => p.chat_id === chatId);
    const check = await this.confirmable(prompt.change_id, chatId);
    await sender.send(
      chatId,
      plain(typeof check === "string" ? check : await this.record(check.entry, chatId, check.now)),
    );
    return true;
  }

  /** Tells every other chat of the Vault about a new link; never throws. */
  async announceLink(redeemed: Redeemed): Promise<void> {
    if (redeemed.relinked) return;
    const { links, clock, sender, log } = this.options;
    const { link, replaces, superseded, others } = redeemed;
    const when = link.activated_at ? formatTime(link.activated_at) : "now";
    const text = `A new ${link.role} chat was linked to Vault #${link.vault_id}; it becomes active ${when}.`;
    const chats = [...new Set(others.map((l) => l.chat_id))].filter((c) => c !== link.chat_id);
    const now = await clock.now().catch(() => null);
    for (const chat of chats) {
      try {
        let alert = plain(text);
        if (replaces && chat === replaces.chat_id && now !== null) {
          const grant = {
            vault_id: link.vault_id,
            chat_id: chat,
            change_id: null,
            link_chat_id: link.chat_id,
          };
          const [approve, cancel] = await links.issueCallbacks(
            [
              { ...grant, action: "approve_link" },
              { ...grant, action: "cancel_link" },
            ],
            now,
          );
          alert = {
            html: escape(
              `${text} It would replace this chat as the Vault's owner chat. Approve makes it the owner chat now; Cancel drops it. If you do nothing, it replaces this chat at ${when}.`,
            ),
            buttons: [
              { text: "Approve", callback: approve as string },
              { text: "Cancel", callback: cancel as string },
            ],
          };
        }
        await sender.send(chat, alert);
      } catch (error) {
        log("error", "telegram link alert failed", {
          vault_id: link.vault_id,
          error: message(error),
        });
      }
    }
    if (superseded) {
      await sender
        .send(
          superseded.chat_id,
          plain(`A newer owner link to Vault #${link.vault_id} replaced this pending one.`),
        )
        .catch((error: unknown) =>
          log("error", "telegram link alert failed", {
            vault_id: link.vault_id,
            error: message(error),
          }),
        );
    }
  }

  /**
   * Why `chatId` cannot confirm the change now, or the entry, the change and the NEAR time when
   * it can: the entry waits for confirmation, the veto time has not passed, the chat is the
   * owner chat in force and was active at `proposed_at`, and the change on chain still has the
   * requested binding.
   */
  private async confirmable(
    changeId: U64,
    chatId: number,
  ): Promise<string | { entry: GuardEntry; change: PolicyChange; now: bigint }> {
    const { guard, links, clock, reader } = this.options;
    if (!guard) return "Owner Confirmation is not available on this watcher.";
    const entry = await guard.store.entry(changeId);
    if (!entry || entry.status !== "scheduled" || !entry.loosening) {
      return "This change is no longer waiting for confirmation.";
    }
    if (entry.confirmation === "confirmed") return "This change is already confirmed.";
    if (entry.confirmation === "rejected") return "This change was rejected.";
    const now = await clock.now();
    if (now >= BigInt(entry.veto_at)) return "Too late to confirm: the veto time has passed.";
    const { current } = await links.ownerLinks(entry.vault_id, now);
    if (!current || current.chat_id !== chatId) {
      return "Only the Vault's active owner chat can confirm.";
    }
    if (BigInt(current.activated_at as string) > BigInt(entry.proposed_at)) {
      return "This chat was linked too recently to confirm this change.";
    }
    const change = await reader.getPolicyChange(changeId);
    if (change.state !== "pending") return "This change is no longer pending.";
    if (entry.binding === null || changeBinding(change) !== entry.binding) {
      return "This change no longer matches the request.";
    }
    return { entry, change, now };
  }

  private async confirm(grant: CallbackGrant, chatId: number): Promise<PressResult> {
    const { links, sender } = this.options;
    const check = await this.confirmable(grant.change_id as U64, chatId);
    if (typeof check === "string") return { answer: check };
    const address = check.change.changes.recovery_address;
    if (typeof address === "string") {
      await links.openPrompt({
        chat_id: chatId,
        vault_id: check.entry.vault_id,
        change_id: check.entry.change_id,
        suffix: address.slice(-6).toLowerCase(),
        expires_at: (check.now + PROMPT_WINDOW_NS).toString(),
      });
      return {
        answer: "Type the last 6 characters of the new Recovery Address.",
        after: () => sender.send(chatId, promptAlert(check.entry.change_id, false)),
      };
    }
    return { answer: await this.record(check.entry, chatId, check.now) };
  }

  /** Stores the confirmation; the answer reads the same whatever the duress flag. */
  private async record(entry: GuardEntry, chatId: number, now: bigint): Promise<string> {
    const { guard, links, log } = this.options;
    const written = await guard?.store.modify(entry.change_id, (e) =>
      e.status === "scheduled" && e.confirmation === "requested"
        ? {
            ...e,
            confirmation: "confirmed",
            confirmed_by_chat: chatId,
            confirmed_at: now.toString(),
          }
        : null,
    );
    if (!written) return "This change is no longer waiting for confirmation.";
    // Reject stays usable until the change is settled: a veto is always the safe direction.
    await links.voidCallbacks((g) => g.action === "confirm" && g.change_id === entry.change_id);
    await links.closePrompts((p) => p.change_id === entry.change_id);
    log("info", "loosening guard: owner confirmation recorded", {
      vault_id: entry.vault_id,
      change_id: entry.change_id,
    });
    return `Confirmed. Recorded for Policy Change #${entry.change_id}.`;
  }

  /** Reject vetoes at once, from any signed owner link of the Vault, mature or not. */
  private async reject(grant: CallbackGrant, chatId: number): Promise<PressResult> {
    const { guard, links, clock, log, sender } = this.options;
    if (!guard) return { answer: "Owner Confirmation is not available on this watcher." };
    const changeId = grant.change_id as U64;
    const now = await clock.now();
    const { current, pending } = await links.ownerLinks(grant.vault_id, now);
    if (current?.chat_id !== chatId && pending?.chat_id !== chatId) {
      return { answer: "Only an owner chat of this Vault can reject." };
    }
    const written = await guard.store.modify(changeId, (e) =>
      e.status === "scheduled" && e.confirmation !== "rejected"
        ? {
            ...e,
            confirmation: "rejected",
            // The ticker retries from now on if this veto fails.
            veto_at: BigInt(e.veto_at) < now ? e.veto_at : now.toString(),
          }
        : null,
    );
    if (!written) {
      const entry = await guard.store.entry(changeId);
      return {
        answer:
          entry?.status === "scheduled"
            ? "Already rejected; the veto is being sent."
            : "This change is no longer pending.",
      };
    }
    await links.voidCallbacks(
      (g) => (g.action === "confirm" || g.action === "reject") && g.change_id === changeId,
    );
    await links.closePrompts((p) => p.change_id === changeId);
    const fields = { vault_id: grant.vault_id, change_id: changeId };
    log("info", "loosening guard: owner rejected the change; vetoing now", fields);
    return {
      answer: "Rejected. Sending the veto now.",
      after: async () => {
        let vetoed = false;
        try {
          vetoed = await guard.vetoNow(changeId);
        } catch (error) {
          log("error", "loosening guard: veto after Reject failed; the ticker retries", {
            ...fields,
            error: message(error),
          });
        }
        await sender.send(
          chatId,
          plain(
            vetoed
              ? `Policy Change #${changeId} is vetoed.`
              : `The veto of Policy Change #${changeId} did not land yet; the watcher keeps retrying while the change is pending.`,
          ),
        );
      },
    };
  }

  private async approve(grant: CallbackGrant, chatId: number): Promise<PressResult> {
    const { links, clock, sender, log } = this.options;
    const pendingChat = grant.link_chat_id as number;
    const result = await links.approveReplacement(
      grant.vault_id,
      chatId,
      pendingChat,
      await clock.now(),
    );
    if (!result) return { answer: "This request is no longer valid." };
    await this.voidLinkButtons(grant);
    log("info", "telegram owner link replaced (approved)", { vault_id: grant.vault_id });
    return {
      answer: "Approved. The new chat is now the owner chat.",
      after: async () => {
        const text = `The owner chat of Vault #${grant.vault_id} was replaced with approval from the previous owner chat; the new chat is active ${formatTime(result.link.activated_at as string)}.`;
        const chats = new Set([
          chatId,
          ...(await links.linksForVault(grant.vault_id)).map((l) => l.chat_id),
        ]);
        for (const chat of chats) {
          await sender.send(chat, plain(text)).catch((error: unknown) =>
            log("error", "telegram link alert failed", {
              vault_id: grant.vault_id,
              error: message(error),
            }),
          );
        }
      },
    };
  }

  private async cancel(grant: CallbackGrant, chatId: number): Promise<PressResult> {
    const { links, clock, sender, log } = this.options;
    const pendingChat = grant.link_chat_id as number;
    const dropped = await links.cancelReplacement(
      grant.vault_id,
      chatId,
      pendingChat,
      await clock.now(),
    );
    if (!dropped) return { answer: "This request is no longer valid." };
    await this.voidLinkButtons(grant);
    log("info", "telegram owner link replacement cancelled", { vault_id: grant.vault_id });
    return {
      answer: "Cancelled. This chat stays the owner chat.",
      after: () =>
        sender.send(
          dropped.chat_id,
          plain(`The owner chat of Vault #${grant.vault_id} cancelled this chat's owner link.`),
        ),
    };
  }

  private voidLinkButtons(grant: CallbackGrant): Promise<void> {
    return this.options.links.voidCallbacks(
      (g) =>
        (g.action === "approve_link" || g.action === "cancel_link") &&
        g.vault_id === grant.vault_id &&
        g.link_chat_id === grant.link_chat_id,
    );
  }
}
