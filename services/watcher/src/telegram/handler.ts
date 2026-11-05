import type { MorrowEvent, SpendOp } from "@morrow/core-ts";
import type { EventHandler, HandlerContext } from "../loop.js";
import { formatAlert, type Alert } from "./alerts.js";
import type { ChainClock } from "../clock.js";
import type { LinkStore } from "./links.js";

/** Sends one alert to one chat. */
export interface Sender {
  send(chatId: number, alert: Alert): Promise<void>;
}

export interface AlertsHandlerOptions {
  links: LinkStore;
  sender: Sender;
  appUrl: string | null;
  getOp: (opId: string) => Promise<SpendOp>;
  /** NEAR time, so the recipients reflect owner-link promotions; without it, the stored links. */
  clock?: ChainClock;
}

/** Sends the Guardian Alert for each alertable event to every chat linked to the Vault. */
export class AlertsHandler implements EventHandler {
  readonly name = "telegram-alerts";

  constructor(private readonly options: AlertsHandlerOptions) {}

  async handle(event: MorrowEvent, ctx?: HandlerContext): Promise<void> {
    const alert = await formatAlert(event, {
      appUrl: this.options.appUrl,
      getOp: this.options.getOp,
    });
    if (!alert) return;
    const now = this.options.clock ? await this.options.clock.now() : null;
    const links = await this.options.links.linksForVault(event.vault_id, now);
    for (const link of links) {
      await this.options.sender.send(link.chat_id, alert);
    }
    if (links.length) {
      ctx?.log("info", "guardian alert sent", {
        seq: event.seq,
        vault_id: event.vault_id,
        kind: event.kind,
        chats: links.length,
      });
    }
  }
}
