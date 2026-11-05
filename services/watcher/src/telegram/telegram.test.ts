import {
  MIN_VAULT_STORAGE_YOCTO,
  MockContractClient,
  presetPolicy,
  type MorrowEvent,
  type SpendOp,
} from "@morrow/core-ts";
import { GrammyError, type Bot } from "grammy";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINK_TS_WINDOW_NS,
  createApiServer,
  issueLinkCode,
  type LinkingOptions,
} from "../heartbeat.js";
import { InMemoryStore } from "../store.js";
import { TelegramBot } from "./bot.js";
import { formatAlert, formatBtc, formatTime, SAFETY_FOOTER, type Alert } from "./alerts.js";
import { AlertsHandler, type Sender } from "./handler.js";
import { CODE_TTL_NS, FileLinkStore, InMemoryLinkStore } from "./links.js";
import {
  AUTO,
  CONTACT,
  CONTACT_KEYS,
  EMMA,
  OWNER,
  OWNER_KEYS,
  THIEF_KEYS,
  linkChat,
  signedBody,
  type LinkAs,
} from "./test-fixtures.js";

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

/** A Vault on the mock with real keys, and the linking options of a watcher reading it. */
async function linkingSetup() {
  const mock = new MockContractClient();
  mock.setNow(1_793_608_920_000_000_000n);
  const vaultId = await mock.asCaller(OWNER).createVault({
    owner_key: OWNER_KEYS.publicKey,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    policy: presetPolicy("standard", {
      plannedDepositSats: 10_000_000n,
      guardians: [AUTO, CONTACT],
      recoveryAddress: `tb1qrcvry${"q".repeat(33)}`,
      network: "signet",
      watcherX25519Pk: "44".repeat(32),
    }),
  });
  const links = new InMemoryLinkStore();
  const linking: LinkingOptions = {
    links,
    botUsername: "MorrowAlert_Bot",
    reader: mock,
    clock: { now: async () => mock.now() },
  };
  const owner: LinkAs = {
    vault_id: vaultId,
    role: "owner",
    account_id: OWNER,
    secret: OWNER_KEYS.secret,
  };
  const emma: LinkAs = {
    vault_id: vaultId,
    role: "guardian",
    account_id: EMMA,
    secret: CONTACT_KEYS.secret,
  };
  return { mock, vaultId, links, linking, owner, emma };
}

describe("links", () => {
  it("links a chat with a single-use code that expires", async () => {
    const { mock, linking, links, emma, vaultId } = await linkingSetup();
    const issued = await issueLinkCode(signedBody(emma, mock.now()), linking);
    const { code } = issued.body as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await links.redeem(code, 42, mock.now()))?.link).toMatchObject({
      chat_id: 42,
      vault_id: vaultId,
      role: "guardian",
      activated_at: mock.now().toString(),
    });
    expect(await links.redeem(code, 43, mock.now())).toBeNull();
    const late = await issueLinkCode(signedBody(emma, mock.now() + 1n), linking);
    expect(
      await links.redeem((late.body as { code: string }).code, 44, mock.now() + CODE_TTL_NS + 1n),
    ).toBeNull();
    expect((await links.linksForVault(vaultId)).map((l) => l.chat_id)).toEqual([42]);
  });
});

describe("links made before signed link codes", () => {
  it("keep their alerts but have no say over the owner link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-links-"));
    try {
      const path = join(dir, "links.json");
      // A 5.3a links file: an unsigned owner link and an old millisecond code.
      await writeFile(
        path,
        JSON.stringify({
          links: [{ chat_id: 9, vault_id: "1", account_id: OWNER, role: "owner", linked_at: "x" }],
          codes: {
            OLDCODE1: { vault_id: "1", account_id: OWNER, role: "owner", expires_at: Date.now() },
          },
        }),
      );
      const links = new FileLinkStore(path);
      expect((await links.linksForVault("1")).map((l) => l.chat_id)).toEqual([9]);
      expect(await links.ownerLinks("1", 0n)).toEqual({ current: null, pending: null });
      expect(await links.redeem("OLDCODE1", 9, 1_793_608_920_000_000_000n)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("are replaced by a signed link of the same chat, which a new owner link then waits behind", async () => {
    const { linking, links, owner, vaultId, mock } = await linkingSetup();
    const first = await linkChat(linking, owner, 9);
    expect(first.replaces).toBeNull();
    expect((await links.ownerLinks(vaultId, mock.now())).current?.chat_id).toBe(9);
  });
});

describe("AlertsHandler", () => {
  it("sends the alert to every chat linked to the Vault", async () => {
    const { links, linking, owner, emma, vaultId } = await linkingSetup();
    await linkChat(linking, owner, 1);
    await linkChat(linking, { ...emma, account_id: EMMA }, 2);
    const sent: [number, Alert][] = [];
    const sender: Sender = { send: async (chat, alert) => void sent.push([chat, alert]) };
    const handler = new AlertsHandler({
      links,
      sender,
      appUrl: null,
      getOp: async () => ({}) as SpendOp,
    });
    await handler.handle({ ...withdrawal, vault_id: vaultId } as MorrowEvent);
    await handler.handle({ ...withdrawal, vault_id: "999" } as MorrowEvent);
    expect(sent.map(([chat]) => chat)).toEqual([1, 2]);
  });
});

describe("TelegramBot.send", () => {
  const failing = (error_code: number, description: string) => {
    const bot = new TelegramBot("1:test", new InMemoryLinkStore(), () => undefined, {
      now: async () => 0n,
    });
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
  it("issues a code only for a fresh request signed by the Vault's key for the role", async () => {
    const { mock, linking, owner, emma } = await linkingSetup();
    const server = createApiServer(new InMemoryStore(), linking).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const post = (body: unknown) =>
        fetch(`http://127.0.0.1:${port}/link-codes`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const now = mock.now();
      const ok = await post(signedBody(owner, now));
      expect(ok.status).toBe(201);
      const { code, deep_link } = (await ok.json()) as { code: string; deep_link: string };
      expect(deep_link).toBe(`https://t.me/MorrowAlert_Bot?start=${code}`);
      // A Guardian signs with its own guardian_key.
      expect((await post(signedBody(emma, now))).status).toBe(201);

      // Unsigned, or malformed: 400.
      const unsigned: Record<string, string> = signedBody(owner, now + 1n);
      delete unsigned.signature;
      expect((await post(unsigned)).status).toBe(400);
      expect((await post({ vault_id: "x", account_id: "a", role: "admin" })).status).toBe(400);
      // Bad signature, wrong key, the key of another role or account, a stale ts: 401.
      const tampered = { ...signedBody(owner, now + 2n), ts: (now + 3n).toString() };
      expect((await post(tampered)).status).toBe(401);
      expect(
        (await post(signedBody({ ...owner, secret: THIEF_KEYS.secret }, now + 4n))).status,
      ).toBe(401);
      expect(
        (await post(signedBody({ ...owner, secret: CONTACT_KEYS.secret }, now + 5n))).status,
      ).toBe(401);
      expect((await post(signedBody({ ...emma, role: "owner" }, now + 6n))).status).toBe(401);
      expect(
        (await post(signedBody({ ...emma, account_id: "mallory.testnet" }, now + 7n))).status,
      ).toBe(401);
      const stale = now - LINK_TS_WINDOW_NS - 1n;
      expect((await post(signedBody(owner, stale))).status).toBe(401);
      expect((await post(signedBody(owner, now + LINK_TS_WINDOW_NS + 1n))).status).toBe(401);
      expect((await post(signedBody({ ...owner, vault_id: "999" }, now))).status).toBe(404);
      // Single use: the same signed request twice.
      const once = signedBody(owner, now + 8n);
      expect((await post(once)).status).toBe(201);
      const again = await post(once);
      expect(again.status).toBe(409);
      expect(await again.json()).not.toHaveProperty("code");
    } finally {
      server.close();
    }
  });

  it("answers 503 when NEAR time is unavailable", async () => {
    const { linking, owner, mock } = await linkingSetup();
    const down = { ...linking, clock: { now: () => Promise.reject(new Error("rpc down")) } };
    await expect(issueLinkCode(signedBody(owner, mock.now()), down)).rejects.toThrow();
  });
});
