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
import {
  MAX_PROMPT_ATTEMPTS,
  type CallbackGrant,
  type Link,
  type LinkStore,
  type Redeemed,
} from "./links.js";

/** The typed-confirmation step stays open this long from the Confirm press; never extended. */
export const PROMPT_WINDOW_NS = 10n * MINUTE_NS;

const TOO_LATE = "Too late to confirm: the veto time has passed, so the change will be vetoed.";

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

/** "7 d", "24 h", "10 min", or nanoseconds when not a whole minute. */
function formatDuration(ns: string): string {
  const value = BigInt(ns);
  if (value > 0n && value % DAY_NS === 0n) return `${value / DAY_NS} d`;
  if (value > 0n && value % HOUR_NS === 0n) return `${value / HOUR_NS} h`;
  if (value > 0n && value % MINUTE_NS === 0n) return `${value / MINUTE_NS} min`;
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

/**
 * The Owner Confirmation request: every changed field old → new, the times, and the buttons.
 * A chat that cannot confirm (not the active owner chat, or linked after the proposal) gets
 * Reject only (`tokens.confirm` null).
 */
export function requestAlert(
  vault: Vault,
  change: PolicyChange,
  vetoAt: U64,
  tokens: { confirm: string | null; reject: string },
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
      tokens.confirm === null
        ? "This change loosens the Vault's rules. The Morrow watcher vetoes it at the veto time. This chat cannot confirm it: it is not the Vault's active owner chat, or was linked after the change was proposed. Reject vetoes it now."
        : "This change loosens the Vault's rules. Unless you confirm it, the Morrow watcher vetoes it at the veto time. Confirm only if you proposed it yourself." +
          (typed
            ? " To confirm, you will type the last 6 characters of the new Recovery Address."
            : ""),
      escape(SAFETY_FOOTER),
    ].join("\n"),
    buttons: [
      ...(tokens.confirm === null ? [] : [{ text: "Confirm", callback: tokens.confirm }]),
      { text: "Reject", callback: tokens.reject },
    ],
  };
}

const plain = (text: string): Alert => ({ html: escape(text), buttons: [] });

/** The typed step: a ForceReply prompt, with no inline keyboard. */
const promptAlert = (changeId: U64, closes: U64, left: number | null): Alert => ({
  html: escape(
    `${left === null ? "" : `That does not match (${left} ${left === 1 ? "try" : "tries"} left). `}To confirm Policy Change #${changeId}, reply with the last 6 characters of the new Recovery Address before ${formatTime(closes)}.`,
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
    return `Linked as the Owner of Vault ${vault}, pending. The current owner chat can approve this once it is active; otherwise this chat replaces it at ${when}. Every chat of the Vault is told. ${SAFETY_FOOTER}`;
  }
  return `Connected. You will get alerts for Vault ${vault} as its Owner. This chat can confirm Policy Changes proposed from ${when} on. ${SAFETY_FOOTER}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NOT_YOURS = "Only the person who linked this chat can use this button.";

/** The owner link of `chatId` among `links`, if `userId` is the person who made it. */
const ownedBy = (link: Link | null, chatId: number, userId: number) =>
  link !== null && link.chat_id === chatId && link.user_id === userId;

/**
 * Owner Confirmation over Telegram (5.3b), plus the owner-link announcements and buttons:
 * - `request`: delivers the request of a loosening change to the owner chats: Confirm and
 *   Reject to the active owner chat that was active at `proposed_at`, Reject only to the others;
 * - `press`: one inline button press, identified only by its random server-side token, and
 *   counted only from the person who linked the chat;
 * - `reply`: the typed last 6 characters of a new Recovery Address;
 * - `tickLinks`: delivers queued link announcements (R4), activation notices and the one-time
 *   notice to owner chats linked before signed codes, retrying until each send succeeds.
 * Every token is single-use, and every state change is written before the chat is answered.
 */
export class OwnerConfirmation implements ConfirmationRequests {
  constructor(private readonly options: OwnerConfirmationOptions) {}

  async request(entry: GuardEntry, now: bigint): Promise<void> {
    const { links, reader, log, guard } = this.options;
    if (!guard) return;
    const owners = await links.ownerLinks(entry.vault_id, now);
    const due: { link: Link; canConfirm: boolean }[] = [];
    for (const link of [owners.current, owners.pending]) {
      if (!link) continue;
      const canConfirm =
        link === owners.current && BigInt(link.activated_at as string) <= BigInt(entry.proposed_at);
      const delivered = entry.request_chats.includes(link.chat_id);
      // A chat that can confirm but holds no Confirm button and no open typed step (it became
      // the owner chat through an approval, or its step ran out) gets the request again.
      const needsConfirm =
        canConfirm && delivered && !(await this.holdsConfirm(link.chat_id, entry.change_id, now));
      if (!delivered || needsConfirm) due.push({ link, canConfirm });
    }
    if (!due.length) return;
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
    for (const { link, canConfirm } of due) {
      // Recorded before it is sent, so a restart never sends the same request twice.
      let added = false;
      const recorded = await guard.store.modify(entry.change_id, (e) => {
        if (
          e.status !== "scheduled" ||
          (e.confirmation !== "none" && e.confirmation !== "requested")
        ) {
          return null;
        }
        added = !e.request_chats.includes(link.chat_id);
        const request_chats = added ? [...e.request_chats, link.chat_id] : e.request_chats;
        return { ...e, confirmation: "requested", binding, request_chats };
      });
      if (!recorded) continue;
      try {
        await links.closePrompts(
          (p) => p.chat_id === link.chat_id && p.change_id === entry.change_id,
        );
        const grant = {
          vault_id: entry.vault_id,
          chat_id: link.chat_id,
          change_id: entry.change_id,
          link_chat_id: null,
        };
        const tokens = await links.issueCallbacks(
          [
            { ...grant, action: "reject" },
            ...(canConfirm ? [{ ...grant, action: "confirm" as const }] : []),
          ],
          now,
        );
        await this.options.sender.send(
          link.chat_id,
          requestAlert(vault, change, entry.veto_at, {
            reject: tokens[0] as string,
            confirm: tokens[1] ?? null,
          }),
        );
      } catch (error) {
        // Not delivered: undo the record so the next tick tries again.
        if (added) {
          await guard.store.modify(entry.change_id, (e) => {
            const request_chats = e.request_chats.filter((c) => c !== link.chat_id);
            const confirmation =
              e.confirmation === "requested" && request_chats.length === 0
                ? "none"
                : e.confirmation;
            return { ...e, request_chats, confirmation };
          });
        }
        throw error;
      }
      log("info", "loosening guard: owner confirmation requested", fields);
    }
  }

  /** Whether the chat still holds an unused Confirm button or an open typed step for the change. */
  private async holdsConfirm(chatId: number, changeId: U64, now: bigint): Promise<boolean> {
    const { links } = this.options;
    const prompt = await links.prompt(chatId);
    if (prompt && prompt.change_id === changeId && now <= BigInt(prompt.expires_at)) return true;
    return links.hasCallback(
      (g) => g.action === "confirm" && g.chat_id === chatId && g.change_id === changeId,
    );
  }

  async press(chatId: number, userId: number, token: string): Promise<PressResult> {
    const grant = await this.options.links.callback(token);
    // A token sent to another chat (a Guardian's, say) changes nothing.
    if (!grant || grant.chat_id !== chatId) return { answer: "This button is no longer valid." };
    switch (grant.action) {
      case "confirm":
        return this.confirm(grant, chatId, userId);
      case "reject":
        return this.reject(grant, chatId, userId);
      case "approve_link":
        return this.approve(grant, chatId, userId);
      case "cancel_link":
        return this.cancel(grant, chatId, userId);
    }
  }

  /**
   * Handles a text message; true when it answered an open typed-confirmation step. The window
   * is fixed when Confirm is pressed; after `MAX_PROMPT_ATTEMPTS` wrong answers the chat is
   * locked out until it closes, and then gets a new request.
   */
  async reply(chatId: number, userId: number, text: string): Promise<boolean> {
    const { links, clock, sender } = this.options;
    const prompt = await links.prompt(chatId);
    if (!prompt) return false;
    const now = await clock.now();
    const owner = (await links.ownerLinks(prompt.vault_id, now)).current;
    if (!ownedBy(owner, chatId, userId)) {
      await sender.send(chatId, plain(NOT_YOURS));
      return true;
    }
    if (now > BigInt(prompt.expires_at)) {
      await links.closePrompts((p) => p.chat_id === chatId);
      await sender.send(
        chatId,
        plain("The confirmation window closed. A new request will follow."),
      );
      return true;
    }
    if (prompt.attempts >= MAX_PROMPT_ATTEMPTS) {
      await sender.send(
        chatId,
        plain(
          `Too many wrong answers. A new request will follow after ${formatTime(prompt.expires_at)}.`,
        ),
      );
      return true;
    }
    if (text.trim().toLowerCase() !== prompt.suffix) {
      // Still requested: ask again, within the same window.
      const attempts = prompt.attempts + 1;
      await links.openPrompt({ ...prompt, attempts });
      const left = MAX_PROMPT_ATTEMPTS - attempts;
      await sender.send(
        chatId,
        left > 0
          ? promptAlert(prompt.change_id, prompt.expires_at, left)
          : plain(
              `That does not match. Too many wrong answers: a new request will follow after ${formatTime(prompt.expires_at)}.`,
            ),
      );
      return true;
    }
    await links.closePrompts((p) => p.chat_id === chatId);
    const check = await this.confirmable(prompt.change_id, chatId, userId);
    await sender.send(
      chatId,
      plain(typeof check === "string" ? check : await this.record(check.entry, chatId)),
    );
    return true;
  }

  /**
   * Delivers what the link store has queued: each new link to every other chat of the Vault
   * (with Approve and Cancel for an active owner chat it would replace), each owner link's
   * activation to its own chat, the chat it replaced and the Guardians, and the one-time
   * re-link notice to owner chats linked before signed codes. A failed send stays queued for the
   * next call; never throws.
   */
  async tickLinks(): Promise<void> {
    const { links, clock, log } = this.options;
    let now: bigint;
    try {
      now = await clock.now();
    } catch (error) {
      log("error", "telegram link alerts: NEAR time unavailable", { error: message(error) });
      return;
    }
    const failed = (vaultId: string, error: unknown) =>
      log("error", "telegram link alert failed; will retry", {
        vault_id: vaultId,
        error: message(error),
      });
    for (const link of await links.announcements(now)) {
      for (const chat of link.announce_to ?? []) {
        try {
          await this.options.sender.send(chat, await this.linkAlert(link, chat, now));
          await links.markAnnounced(link, "link", chat);
        } catch (error) {
          failed(link.vault_id, error);
        }
      }
      for (const chat of link.active_announce_to ?? []) {
        const text =
          link.replaced_chat != null
            ? `The owner chat of Vault #${link.vault_id} changed: the new owner chat is active from ${formatTime(link.activated_at as string)}, and the previous one is unlinked.`
            : `The owner chat of Vault #${link.vault_id} is active from ${formatTime(link.activated_at as string)}: it can confirm Policy Changes proposed from then on.`;
        try {
          await this.options.sender.send(chat, plain(text));
          await links.markAnnounced(link, "active", chat);
        } catch (error) {
          failed(link.vault_id, error);
        }
      }
    }
    for (const legacy of await links.legacyOwnerLinks()) {
      try {
        await this.options.sender.send(
          legacy.chat_id,
          plain(
            `This chat was linked to Vault #${legacy.vault_id} before Morrow signed its links, so it only gets alerts: it cannot confirm or reject Policy Changes. To link it as the Owner, run the watcher's link-code command with the Owner Key and open the new link in a private chat with the bot.`,
          ),
        );
        await links.markLegacyNotified(legacy);
      } catch (error) {
        failed(legacy.vault_id, error);
      }
    }
  }

  /** The announcement of `link` to `chat`; Approve and Cancel for an active owner chat it replaces. */
  private async linkAlert(link: Link, chat: number, now: bigint): Promise<Alert> {
    const when = link.activated_at ? formatTime(link.activated_at) : "now";
    const text = `A new ${link.role} chat was linked to Vault #${link.vault_id}; it becomes active ${when}.`;
    if (link.role !== "owner" || link.pending_replace_of !== chat) return plain(text);
    const { current } = await this.options.links.ownerLinks(link.vault_id, now);
    if (!current || current.chat_id !== chat || BigInt(current.activated_at as string) > now) {
      return plain(
        `${text} It would replace this chat as the Vault's owner chat at that time. This chat is not active yet, so it cannot approve or cancel it.`,
      );
    }
    const grant = {
      vault_id: link.vault_id,
      chat_id: chat,
      change_id: null,
      link_chat_id: link.chat_id,
    };
    const [approve, cancel] = await this.options.links.issueCallbacks(
      [
        { ...grant, action: "approve_link" },
        { ...grant, action: "cancel_link" },
      ],
      now,
    );
    return {
      html: escape(
        `${text} It would replace this chat as the Vault's owner chat. Approve makes it the owner chat now; Cancel drops it. If you do nothing, it replaces this chat at ${when}.`,
      ),
      buttons: [
        { text: "Approve", callback: approve as string },
        { text: "Cancel", callback: cancel as string },
      ],
    };
  }

  /**
   * Why the person `userId` in `chatId` cannot confirm the change now, or the entry, the change
   * and the NEAR time when they can: the entry waits for confirmation, the veto time has not
   * passed, the chat is the owner chat in force, linked by this person, and was active at
   * `proposed_at`, and the change on chain still has the requested binding.
   */
  private async confirmable(
    changeId: U64,
    chatId: number,
    userId: number,
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
    if (now >= BigInt(entry.veto_at)) return TOO_LATE;
    const { current } = await links.ownerLinks(entry.vault_id, now);
    if (!current || current.chat_id !== chatId) {
      return "Only the Vault's active owner chat can confirm.";
    }
    if (current.user_id !== userId) return NOT_YOURS;
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

  private async confirm(
    grant: CallbackGrant,
    chatId: number,
    userId: number,
  ): Promise<PressResult> {
    const { links, sender } = this.options;
    const check = await this.confirmable(grant.change_id as U64, chatId, userId);
    if (typeof check === "string") return { answer: check };
    // Single-use: this button is spent; a new request brings a new one if this attempt fails.
    await links.voidCallbacks(
      (g) => g.action === "confirm" && g.chat_id === chatId && g.change_id === grant.change_id,
    );
    const address = check.change.changes.recovery_address;
    if (typeof address === "string") {
      const expires = (check.now + PROMPT_WINDOW_NS).toString();
      await links.openPrompt({
        chat_id: chatId,
        vault_id: check.entry.vault_id,
        change_id: check.entry.change_id,
        suffix: address.slice(-6).toLowerCase(),
        expires_at: expires,
        attempts: 0,
      });
      return {
        answer: "Type the last 6 characters of the new Recovery Address.",
        after: () => sender.send(chatId, promptAlert(check.entry.change_id, expires, null)),
      };
    }
    return { answer: await this.record(check.entry, chatId) };
  }

  /**
   * Stores the confirmation unless the veto time has passed, read fresh right before the
   * compare-and-set; the answer reads the same whatever the duress flag.
   */
  private async record(entry: GuardEntry, chatId: number): Promise<string> {
    const { guard, links, log, clock } = this.options;
    const now = await clock.now();
    const written = await guard?.store.modify(entry.change_id, (e) =>
      e.status === "scheduled" && e.confirmation === "requested" && now < BigInt(e.veto_at)
        ? {
            ...e,
            confirmation: "confirmed",
            confirmed_by_chat: chatId,
            confirmed_at: now.toString(),
          }
        : null,
    );
    if (!written) {
      const latest = await guard?.store.entry(entry.change_id);
      return latest?.status === "scheduled" && now >= BigInt(latest.veto_at)
        ? TOO_LATE
        : "This change is no longer waiting for confirmation.";
    }
    // Reject stays usable until the change is settled: a veto is always the safe direction.
    await links.voidCallbacks((g) => g.action === "confirm" && g.change_id === entry.change_id);
    await links.closePrompts((p) => p.change_id === entry.change_id);
    log("info", "loosening guard: owner confirmation recorded", {
      vault_id: entry.vault_id,
      change_id: entry.change_id,
    });
    return `Confirmed. Recorded for Policy Change #${entry.change_id}.`;
  }

  /**
   * Reject vetoes at once, from any signed owner link of the Vault, mature or not, pressed by the
   * person who linked it. It also works after the guard left a confirmed change, for as long as
   * the change is pending on chain.
   */
  private async reject(grant: CallbackGrant, chatId: number, userId: number): Promise<PressResult> {
    const { guard, links, clock, log, sender, reader } = this.options;
    if (!guard) return { answer: "Owner Confirmation is not available on this watcher." };
    const changeId = grant.change_id as U64;
    const now = await clock.now();
    const { current, pending } = await links.ownerLinks(grant.vault_id, now);
    if (current?.chat_id !== chatId && pending?.chat_id !== chatId) {
      return { answer: "Only an owner chat of this Vault can reject." };
    }
    if (!ownedBy(current, chatId, userId) && !ownedBy(pending, chatId, userId)) {
      return { answer: NOT_YOURS };
    }
    const left = (e: GuardEntry | null) =>
      e?.status === "skipped" && e.cause === "owner confirmed" && e.confirmation === "confirmed";
    // A confirmed change the guard left can still be vetoed while the chain says pending.
    const reopen =
      left(await guard.store.entry(changeId)) &&
      (await reader.getPolicyChange(changeId).catch(() => null))?.state === "pending";
    const written = await guard.store.modify(changeId, (e) =>
      (e.status === "scheduled" && e.confirmation !== "rejected") || (reopen && left(e))
        ? {
            ...e,
            status: "scheduled",
            cause: null,
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

  /** Approve and Cancel count only from the active owner chat in force, pressed by its linker. */
  private async decider(grant: CallbackGrant, chatId: number, userId: number, now: bigint) {
    const { current } = await this.options.links.ownerLinks(grant.vault_id, now);
    if (!current || current.chat_id !== chatId) return "This request is no longer valid.";
    if (current.user_id !== userId) return NOT_YOURS;
    if (BigInt(current.activated_at as string) > now) {
      return "This chat is not active yet, so it cannot approve or cancel a replacement.";
    }
    return null;
  }

  private async approve(
    grant: CallbackGrant,
    chatId: number,
    userId: number,
  ): Promise<PressResult> {
    const { links, clock, log } = this.options;
    const now = await clock.now();
    const refused = await this.decider(grant, chatId, userId, now);
    if (refused) return { answer: refused };
    const result = await links.approveReplacement(
      grant.vault_id,
      chatId,
      grant.link_chat_id as number,
      now,
    );
    if (!result) return { answer: "This request is no longer valid." };
    await this.voidLinkButtons(grant);
    log("info", "telegram owner link replaced (approved)", { vault_id: grant.vault_id });
    // The store queued the activation notice for the old chat, the new chat and the Guardians.
    return {
      answer: "Approved. The new chat is now the owner chat.",
      after: () => this.tickLinks(),
    };
  }

  private async cancel(grant: CallbackGrant, chatId: number, userId: number): Promise<PressResult> {
    const { links, clock, sender, log } = this.options;
    const now = await clock.now();
    const refused = await this.decider(grant, chatId, userId, now);
    if (refused) return { answer: refused };
    const dropped = await links.cancelReplacement(
      grant.vault_id,
      chatId,
      grant.link_chat_id as number,
      now,
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
