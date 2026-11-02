import type { MorrowEvent, SpendOp } from "@morrow/core-ts";
import { GrammyError, type Bot } from "grammy";
import { describe, expect, it } from "vitest";
import { createApiServer } from "../heartbeat.js";
import { InMemoryStore } from "../store.js";
import { TelegramBot } from "./bot.js";
import { formatAlert, formatBtc, formatTime, SAFETY_FOOTER, type Alert } from "./alerts.js";
import { AlertsHandler, type Sender } from "./handler.js";
import { CODE_TTL_MS, InMemoryLinkStore } from "./links.js";

const T = "1793608920000000000"; // 2026-11-02 08:42 UTC
const DEST = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

const withdrawal = {
  seq: "3",
  block_timestamp: T,
  vault_id: "7",
  kind: "withdrawal_requested",
  data: {
    op_id: "4",
    amount_sats: "1500000",
    destination: DEST,
    executable_at: "1793695320000000000",
    utxos: [],
    envelope: "ab".repeat(80),
  },
} as MorrowEvent;

describe("formatAlert", () => {
  it("renders the Guardian Alert anatomy for a withdrawal request", async () => {
    const alert = await formatAlert(withdrawal, { appUrl: "https://app.morrow.test" });
    const html = alert?.html ?? "";
    expect(html).toContain("Morrow · Vault 7 · 2026-11-02 08:42 UTC");
    expect(html).toContain("<b>Withdrawal requested</b>");
    expect(html).toContain("0.01500000 BTC");
    expect(html).toContain(DEST);
    expect(html).toContain("2026-11-03 08:42 UTC");
    expect(html).toContain(SAFETY_FOOTER);
    expect(alert?.buttons).toEqual([
      { text: "Clawback", url: "https://app.morrow.test/g/7/clawback" },
      { text: "It was the Owner", url: "https://app.morrow.test/g/7" },
    ]);
  });

  it("carries no links without a configured app domain", async () => {
    expect((await formatAlert(withdrawal, { appUrl: null }))?.buttons).toEqual([]);
  });

  it("alerts on clawbacks and allowance spends but not on signatures", async () => {
    const clawed = {
      ...withdrawal,
      kind: "vault_clawed_back",
      data: { op_id: "5", by: "emma.testnet", recovery_address: DEST },
    } as MorrowEvent;
    expect((await formatAlert(clawed, { appUrl: null }))?.html).toContain("Vault clawed back");
    const getOp = async () => ({ amount_sats: "20000", destination: DEST }) as SpendOp;
    const allowance = {
      ...withdrawal,
      kind: "op_frozen",
      data: { op_id: "6", kind: "allowance", envelope: null },
    } as MorrowEvent;
    expect((await formatAlert(allowance, { appUrl: null, getOp }))?.html).toContain(
      "0.00020000 BTC",
    );
    const signed = {
      ...withdrawal,
      kind: "input_signed",
      data: { op_id: "4", input_index: 0 },
    } as MorrowEvent;
    expect(await formatAlert(signed, { appUrl: null })).toBeNull();
  });

  it("never asks for keys and escapes HTML", async () => {
    const proposal = {
      ...withdrawal,
      kind: "policy_change_proposed",
      data: {
        change_id: "1",
        changes: { recovery_address: "<script>" },
        effective_at: T,
        envelope: "",
      },
    } as MorrowEvent;
    const html = (await formatAlert(proposal, { appUrl: null }))?.html ?? "";
    expect(html).toContain("&lt;script&gt;");
    expect(html.toLowerCase()).not.toMatch(/enter (your )?(key|seed|pin)|send (your )?(key|seed)/);
  });

  it("formats times and amounts", () => {
    expect(formatTime(T)).toBe("2026-11-02 08:42 UTC");
    expect(formatBtc("1")).toBe("0.00000001 BTC");
  });
});

describe("links", () => {
  it("links a chat with a single-use code that expires", async () => {
    const links = new InMemoryLinkStore();
    const code = await links.createCode("7", "emma.testnet", "guardian", 0);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(await links.redeem(code, 42, 1)).toMatchObject({
      chat_id: 42,
      vault_id: "7",
      role: "guardian",
    });
    expect(await links.redeem(code, 43, 2)).toBeNull();
    const late = await links.createCode("7", "emma.testnet", "guardian", 0);
    expect(await links.redeem(late, 44, CODE_TTL_MS + 1)).toBeNull();
    expect((await links.linksForVault("7")).map((l) => l.chat_id)).toEqual([42]);
  });
});

describe("AlertsHandler", () => {
  it("sends the alert to every chat linked to the Vault", async () => {
    const links = new InMemoryLinkStore();
    for (const [chat, role] of [
      [1, "owner"],
      [2, "guardian"],
    ] as const) {
      await links.redeem(await links.createCode("7", `a${chat}.testnet`, role), chat);
    }
    await links.redeem(await links.createCode("8", "other.testnet", "guardian"), 3);
    const sent: [number, Alert][] = [];
    const sender: Sender = { send: async (chat, alert) => void sent.push([chat, alert]) };
    const handler = new AlertsHandler({
      links,
      sender,
      appUrl: null,
      getOp: async () => ({}) as SpendOp,
    });
    await handler.handle(withdrawal);
    expect(sent.map(([chat]) => chat)).toEqual([1, 2]);
  });
});

describe("TelegramBot.send", () => {
  const failing = (error_code: number, description: string) => {
    const bot = new TelegramBot("1:test", new InMemoryLinkStore(), () => undefined);
    (bot as unknown as { bot: Bot }).bot.api.sendMessage = () =>
      Promise.reject(
        new GrammyError("send failed", { ok: false, error_code, description }, "sendMessage", {}),
      );
    return bot;
  };
  const alert: Alert = { html: "x", buttons: [] };

  it("skips a chat that blocked the bot so the loop is not stalled", async () => {
    await expect(
      failing(403, "Forbidden: bot was blocked by the user").send(1, alert),
    ).resolves.toBeUndefined();
    await expect(
      failing(400, "Bad Request: chat not found").send(1, alert),
    ).resolves.toBeUndefined();
  });

  it("throws on other failures so the event is retried", async () => {
    await expect(failing(429, "Too Many Requests").send(1, alert)).rejects.toThrow();
  });
});

describe("POST /link-codes", () => {
  it("returns a code and a t.me deep link, and validates input", async () => {
    const links = new InMemoryLinkStore();
    const server = createApiServer(new InMemoryStore(), {
      links,
      botUsername: "MorrowAlert_Bot",
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const post = (body: unknown) =>
        fetch(`http://127.0.0.1:${port}/link-codes`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const ok = await post({ vault_id: "7", account_id: "emma.testnet", role: "guardian" });
      expect(ok.status).toBe(201);
      const { code, deep_link } = (await ok.json()) as { code: string; deep_link: string };
      expect(deep_link).toBe(`https://t.me/MorrowAlert_Bot?start=${code}`);
      expect((await post({ vault_id: "x", account_id: "a", role: "admin" })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
