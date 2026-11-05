import { Bot, GrammyError } from "grammy";
import type { ChainClock } from "../clock.js";
import type { Logger } from "../log.js";
import type { Alert } from "./alerts.js";
import { linkedReply, type OwnerConfirmation } from "./confirm.js";
import type { Sender } from "./handler.js";
import type { LinkStore } from "./links.js";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Morrow Telegram bot: links chats with /start <code>, delivers alerts, and carries Owner
 * Confirmation: inline button presses (`callback_query`, each answered with
 * `answerCallbackQuery`) and the typed last 6 characters of a new Recovery Address.
 */
export class TelegramBot implements Sender {
  private readonly bot: Bot;
  private actions: OwnerConfirmation | null = null;

  constructor(
    token: string,
    private readonly links: LinkStore,
    private readonly log: Logger,
    /** NEAR time for link maturity and code expiry. */
    private readonly clock: ChainClock,
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
      let now: bigint;
      try {
        now = await this.clock.now();
      } catch (error) {
        this.log("error", "telegram link failed: NEAR time unavailable", { error: failure(error) });
        await ctx.reply(
          "Morrow cannot read the NEAR time right now. Try the same link again in a minute.",
        );
        return;
      }
      const redeemed = await this.links.redeem(code, ctx.chat.id, now);
      if (!redeemed) {
        await ctx.reply("That link has expired or was already used. Ask for a new one.");
        return;
      }
      const { link } = redeemed;
      this.log("info", "telegram chat linked", {
        vault_id: link.vault_id,
        role: link.role,
        pending: link.pending_replace_of != null,
      });
      await ctx.reply(linkedReply(redeemed));
      await this.actions?.announceLink(redeemed);
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined || !this.actions) {
        await ctx.answerCallbackQuery({ text: "This button is no longer valid." });
        return;
      }
      let result;
      try {
        result = await this.actions.press(chatId, ctx.callbackQuery.data);
      } catch (error) {
        this.log("error", "telegram button failed", { error: failure(error) });
        await ctx.answerCallbackQuery({ text: "Something went wrong. Try again in a minute." });
        return;
      }
      await ctx.answerCallbackQuery({ text: result.answer, show_alert: true });
      await result
        .after?.()
        .catch((error: unknown) =>
          this.log("error", "telegram button follow-up failed", { error: failure(error) }),
        );
    });

    this.bot.on("message:text", async (ctx) => {
      if (!this.actions || ctx.message.text.startsWith("/")) return;
      try {
        await this.actions.reply(ctx.chat.id, ctx.message.text);
      } catch (error) {
        this.log("error", "telegram reply failed", { error: failure(error) });
        await ctx.reply("Something went wrong. Press Confirm again in a minute.");
      }
    });
  }

  /** Wires the buttons and the typed-confirmation step; until then presses are refused. */
  attach(actions: OwnerConfirmation): void {
    this.actions = actions;
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
              inline_keyboard: [
                alert.buttons.map((b) =>
                  "url" in b
                    ? { text: b.text, url: b.url }
                    : { text: b.text, callback_data: b.callback },
                ),
              ],
            },
          }
        : alert.forceReply
          ? { reply_markup: { force_reply: true as const } }
          : {}),
    });
  }
}

const isUnreachable = (error: GrammyError) =>
  error.error_code === 403 ||
  (error.error_code === 400 && /chat not found/i.test(error.description));
