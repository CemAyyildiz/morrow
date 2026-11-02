import { Bot, GrammyError } from "grammy";
import type { Logger } from "../log.js";
import type { Alert } from "./alerts.js";
import type { Sender } from "./handler.js";
import type { LinkStore } from "./links.js";

/** The Morrow Telegram bot: links chats with /start <code> and delivers alerts. */
export class TelegramBot implements Sender {
  private readonly bot: Bot;

  constructor(
    token: string,
    private readonly links: LinkStore,
    private readonly log: Logger,
  ) {
    this.bot = new Bot(token);
    this.bot.command("start", async (ctx) => {
      const code = ctx.match.trim();
      if (!code) {
        await ctx.reply(
          "Open the Morrow app and choose “Connect Telegram” to get your link. Morrow never asks for keys or seed words.",
        );
        return;
      }
      const link = await this.links.redeem(code, ctx.chat.id);
      if (!link) {
        await ctx.reply("That link has expired or was already used. Ask the app for a new one.");
        return;
      }
      this.log("info", "telegram chat linked", { vault_id: link.vault_id, role: link.role });
      await ctx.reply(
        `Connected. You will get alerts for Vault ${link.vault_id} as its ${link.role === "owner" ? "Owner" : "Guardian"}. Morrow never asks for keys or seed words.`,
      );
    });
  }

  async username(): Promise<string> {
    return (await this.bot.api.getMe()).username;
  }

  start(): void {
    void this.bot.start({ onStart: () => this.log("info", "telegram bot polling") });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /**
   * A chat that blocked the bot or no longer exists is skipped, so one unreachable Guardian
   * cannot stall the event loop; any other failure throws and the event is retried.
   */
  async send(chatId: number, alert: Alert): Promise<void> {
    try {
      await this.deliver(chatId, alert);
    } catch (error) {
      if (!(error instanceof GrammyError) || !isUnreachable(error)) throw error;
      this.log("warn", "telegram chat unreachable; alert skipped", {
        chat_id: chatId,
        error: error.description,
      });
    }
  }

  private async deliver(chatId: number, alert: Alert): Promise<void> {
    await this.bot.api.sendMessage(chatId, alert.html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(alert.buttons.length
        ? {
            reply_markup: {
              inline_keyboard: [alert.buttons.map((b) => ({ text: b.text, url: b.url }))],
            },
          }
        : {}),
    });
  }
}

const isUnreachable = (error: GrammyError) =>
  error.error_code === 403 ||
  (error.error_code === 400 && /chat not found/i.test(error.description));
