import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAY_NS,
  HOUR_NS,
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  generateEnvelopeKeypair,
  presetPolicy,
  sealEnvelope,
  verifyLinkRequest,
  type ContractClient,
  type EnvelopeKeypair,
  type ProposePolicyChangeArgs,
} from "@morrow/core-ts";
import type { Bot } from "grammy";
import { afterEach, describe, expect, it } from "vitest";
import { linkCode, parseArgs, type LinkCodeDeps } from "../cli/link-code.js";
import { LooseningGuard, envelopeKeypair } from "../guard/handler.js";
import { FileGuardStore, InMemoryGuardStore, type GuardStore } from "../guard/store.js";
import { GuardTicker } from "../guard/ticker.js";
import type { LinkingOptions } from "../heartbeat.js";
import type { LogLevel } from "../log.js";
import { EventLoop } from "../loop.js";
import { InMemoryStore } from "../store.js";
import type { Alert } from "./alerts.js";
import { TelegramBot } from "./bot.js";
import { OwnerConfirmation, PROMPT_WINDOW_NS } from "./confirm.js";
import type { Sender } from "./handler.js";
import {
  FileLinkStore,
  InMemoryLinkStore,
  OWNER_LINK_MATURITY_NS,
  type LinkStore,
} from "./links.js";
import {
  AUTO,
  CONTACT,
  CONTACT_KEYS,
  EMMA,
  GUARDIAN,
  OWNER,
  OWNER_KEYS,
  linkChat,
  type LinkAs,
} from "./test-fixtures.js";

const T0 = 1_793_608_920_000_000_000n; // 2026-11-02 08:42 UTC
const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
const NEW_RECOVERY = `tb1qnewrcv${"q".repeat(26)}xk7r3p`;
const OWNER_CHAT = 100;
const EMMA_CHAT = 200;
const NEW_PHONE = 300;

/** A view of the shared mock that signs every call as `account`. */
function as(mock: MockContractClient, account: string): ContractClient {
  return new Proxy(mock, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        target.asCaller(account);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

let vaultKey: EnvelopeKeypair;

interface SetupOptions {
  owner?: string;
  links?: LinkStore;
  guardStore?: GuardStore;
  mock?: MockContractClient;
  vaultId?: string;
  challengeOwnerParent?: string | null;
  /** `MORROW_WATCHER_X25519_SK` is set (default: yes, the Vault's own key). */
  keyConfigured?: boolean;
}

async function setup(options: SetupOptions = {}) {
  vaultKey ??= await generateEnvelopeKeypair();
  const owner = options.owner ?? OWNER;
  const mock = options.mock ?? new MockContractClient().setNow(T0);
  const vaultId =
    options.vaultId ??
    (await as(mock, owner).createVault({
      owner_key: OWNER_KEYS.publicKey,
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
      policy: presetPolicy("standard", {
        plannedDepositSats: 10_000_000n,
        guardians: [AUTO, CONTACT],
        recoveryAddress: RECOVERY,
        network: "signet",
        watcherX25519Pk: vaultKey.publicKeyHex,
      }),
    }));
  const links = options.links ?? new InMemoryLinkStore();
  const guardStore = options.guardStore ?? new InMemoryGuardStore();
  /** `clockHook` runs on every NEAR time read, e.g. to move time between two reads. */
  const hooks = {
    clock: null as null | (() => void),
    /** Runs once after the ticker reads an entry, e.g. to land a Reject in between. */
    afterTickerEntry: null as null | (() => Promise<void>),
    /** Makes a send throw while it returns true. */
    failSend: null as null | ((chat: number, alert: Alert) => boolean),
  };
  const clock = {
    now: async () => {
      hooks.clock?.();
      return mock.now();
    },
  };
  const linking: LinkingOptions = {
    links,
    botUsername: "MorrowAlert_Bot",
    reader: mock,
    clock,
    wallNow: () => mock.now(),
  };
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) =>
    logs.push({ level, msg, fields });
  const sent: { chat: number; alert: Alert }[] = [];
  const sender: Sender = {
    send: async (chat, alert) => {
      if (hooks.failSend?.(chat, alert)) throw new Error("Telegram unavailable");
      sent.push({ chat, alert });
    },
  };
  const guardian = as(mock, GUARDIAN);
  const veto = { calls: 0, fail: false };
  const signer = new Proxy(guardian, {
    get: (target, prop, receiver) =>
      prop === "vetoPolicyChange"
        ? async (changeId: string) => {
            veto.calls++;
            if (veto.fail) throw new Error("RPC unavailable");
            return guardian.vetoPolicyChange(changeId);
          }
        : Reflect.get(target, prop, receiver),
  });
  const loop = new EventLoop({
    client: mock,
    store: new InMemoryStore(),
    handlers: [
      new LooseningGuard({
        reader: mock,
        guardianAccount: GUARDIAN,
        store: guardStore,
        envelopeKeypair: envelopeKeypair(vaultKey.secretKeyHex),
        challengeOwnerParent: options.challengeOwnerParent ?? null,
      }),
    ],
    clock,
    log,
  });
  let confirmation: OwnerConfirmation | null = null;
  const tickerStore = new Proxy(guardStore, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "entry" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (id: string) => {
        const found = await target.entry(id);
        const hook = hooks.afterTickerEntry;
        hooks.afterTickerEntry = null;
        await hook?.();
        return found;
      };
    },
  });
  const ticker = new GuardTicker({
    reader: mock,
    signer,
    store: tickerStore,
    guardianAccount: GUARDIAN,
    clock,
    log,
    callTimeoutMs: 200,
    requests: { request: async (entry, now) => confirmation?.request(entry, now) },
    envelopeKeyConfigured: options.keyConfigured ?? true,
  });
  confirmation = new OwnerConfirmation({
    links,
    sender,
    reader: mock,
    clock,
    log,
    guard: { store: guardStore, vetoNow: (id) => ticker.vetoNow(id) },
  });
  const actions = confirmation;
  /** One pass of what main runs: the guard loop, the guard ticker and the link ticker. */
  const tick = async () => {
    await loop.tick();
    await ticker.tick();
    await actions.tickLinks();
  };
  const ownerAs: LinkAs = {
    vault_id: vaultId,
    role: "owner",
    account_id: owner,
    secret: OWNER_KEYS.secret,
  };
  const emmaAs: LinkAs = {
    vault_id: vaultId,
    role: "guardian",
    account_id: EMMA,
    secret: CONTACT_KEYS.secret,
  };
  /** Links a chat with a signed code and announces it, as the bot does. */
  const link = async (who: LinkAs, chat: number) => {
    const redeemed = await linkChat(linking, who, chat);
    await actions.tickLinks();
    return redeemed;
  };
  /** `unreadable`: an envelope sealed to another key, so the guard reads `unknown`. */
  const propose = async (
    changes: ProposePolicyChangeArgs["changes"],
    flag: "normal" | "duress" | "unreadable" = "normal",
  ) =>
    as(mock, owner).proposePolicyChange({
      vault_id: vaultId,
      changes,
      envelope:
        flag === "unreadable"
          ? await sealEnvelope("normal", (await generateEnvelopeKeypair()).publicKeyHex)
          : await sealEnvelope(flag, vaultKey.publicKeyHex),
    });
  /** The callback tokens of the last message with buttons sent to `chat`. */
  const buttons = (chat: number): Record<string, string> => {
    const last = sent.filter((s) => s.chat === chat && s.alert.buttons.length).at(-1);
    return Object.fromEntries(
      (last?.alert.buttons ?? []).map((b) => [b.text, "callback" in b ? b.callback : b.url]),
    );
  };
  /** Presses a button and runs its follow-up, as the bot does; returns the answer. */
  const press = async (chat: number, token: string | undefined, user = chat) => {
    const result = await actions.press(chat, user, token ?? "missing");
    await result.after?.();
    return result.answer;
  };
  /** A typed reply from the chat's own user (the user id is the chat id in these tests). */
  const reply = (chat: number, text: string, user = chat) => actions.reply(chat, user, text);
  const entry = async (id: string) => (await guardStore.entry(id))!;
  const toVetoAt = async (id: string) => mock.setNow(BigInt((await entry(id)).veto_at));
  const requests = () => sent.filter((s) => s.alert.html.includes("Owner Confirmation for"));
  return {
    mock,
    vaultId,
    links,
    guardStore,
    linking,
    logs,
    sent,
    veto,
    ticker,
    confirmation: actions,
    tick,
    link,
    ownerAs,
    emmaAs,
    propose,
    buttons,
    press,
    reply,
    hooks,
    entry,
    toVetoAt,
    requests,
    change: (id: string) => mock.getPolicyChange(id),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The Owner's chat and Emma's chat, the owner link matured; returns the change proposed after. */
async function linkedAndProposed(
  t: Setup,
  changes: ProposePolicyChangeArgs["changes"],
  flag?: "duress" | "unreadable",
) {
  await t.link(t.ownerAs, OWNER_CHAT);
  await t.link(t.emmaAs, EMMA_CHAT);
  t.mock.advance(OWNER_LINK_MATURITY_NS + HOUR_NS);
  const id = await t.propose(changes, flag);
  await t.tick();
  return id;
}

describe("owner links (R2–R4)", () => {
  it("activates a first owner link after 7 days and announces it to every other chat", async () => {
    const t = await setup();
    await t.link(t.emmaAs, EMMA_CHAT);
    const { link } = await t.link(t.ownerAs, OWNER_CHAT);
    expect(link).toMatchObject({
      chat_id: OWNER_CHAT,
      role: "owner",
      activated_at: (T0 + 7n * DAY_NS).toString(),
      pending_replace_of: null,
    });
    const alert = t.sent.find((s) => s.chat === EMMA_CHAT);
    expect(alert?.alert.html).toBe(
      `A new owner chat was linked to Vault #${t.vaultId}; it becomes active 2026-11-09 08:42 UTC.`,
    );
    expect(t.sent.filter((s) => s.chat === OWNER_CHAT)).toEqual([]);
    expect((await t.links.ownerLinks(t.vaultId, T0)).current?.chat_id).toBe(OWNER_CHAT);
  });

  it("keeps the old owner link in force until a replacement matures at +7 d", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    await t.link(t.emmaAs, EMMA_CHAT);
    t.mock.advance(8n * DAY_NS);
    const { link, replaces } = await t.link(t.ownerAs, NEW_PHONE);
    expect(replaces?.chat_id).toBe(OWNER_CHAT);
    expect(link).toMatchObject({ pending_replace_of: OWNER_CHAT });
    expect(t.buttons(OWNER_CHAT)).toHaveProperty("Approve");
    expect(
      t.sent.some((s) => s.chat === EMMA_CHAT && s.alert.html.includes("new owner chat")),
    ).toBe(true);
    const at = BigInt(link.activated_at as string);
    expect((await t.links.ownerLinks(t.vaultId, at - 1n)).current?.chat_id).toBe(OWNER_CHAT);
    const after = await t.links.ownerLinks(t.vaultId, at);
    expect(after).toMatchObject({ current: { chat_id: NEW_PHONE }, pending: null });
    // The matured replacement took over; the old link is gone once a write promotes it.
    t.mock.setNow(at);
    await t.link(t.emmaAs, EMMA_CHAT + 1);
    expect((await t.links.linksForVault(t.vaultId)).map((l) => l.chat_id)).not.toContain(
      OWNER_CHAT,
    );
  });

  it("Approve from the owner chat in force makes the replacement active at once with the old activated_at", async () => {
    const t = await setup();
    const { link: old } = await t.link(t.ownerAs, OWNER_CHAT);
    await t.link(t.emmaAs, EMMA_CHAT);
    t.mock.advance(8n * DAY_NS);
    await t.link(t.ownerAs, NEW_PHONE);
    const { Approve } = t.buttons(OWNER_CHAT);
    // Only the chat the button was sent to can press it.
    expect(await t.press(EMMA_CHAT, Approve)).toBe("This button is no longer valid.");
    expect(await t.press(OWNER_CHAT, Approve)).toBe(
      "Approved. The new chat is now the owner chat.",
    );
    const { current, pending } = await t.links.ownerLinks(t.vaultId, t.mock.now());
    expect(current).toMatchObject({ chat_id: NEW_PHONE, activated_at: old.activated_at });
    expect(pending).toBeNull();
    expect((await t.links.linksForVault(t.vaultId)).map((l) => l.chat_id).sort()).toEqual([
      EMMA_CHAT,
      NEW_PHONE,
    ]);
    // The old chat, the new chat and the Guardians are told.
    for (const chat of [OWNER_CHAT, EMMA_CHAT, NEW_PHONE]) {
      expect(
        t.sent.some(
          (s) => s.chat === chat && s.alert.html.includes("owner chat of Vault #1 changed"),
        ),
      ).toBe(true);
    }
    // Single use.
    expect(await t.press(OWNER_CHAT, Approve)).toBe("This button is no longer valid.");
  });

  it("Cancel from the owner chat in force drops the pending link", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    t.mock.advance(8n * DAY_NS);
    await t.link(t.ownerAs, NEW_PHONE);
    expect(await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Cancel)).toMatch(/^Cancelled/);
    expect(await t.links.ownerLinks(t.vaultId, T0 + 30n * DAY_NS)).toMatchObject({
      current: { chat_id: OWNER_CHAT, replaced_by: null },
      pending: null,
    });
    expect(t.sent.some((s) => s.chat === NEW_PHONE && s.alert.html.includes("cancelled"))).toBe(
      true,
    );
  });

  it("a newer pending replacement supersedes an older one; re-linking the same chat changes nothing", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    await t.link(t.ownerAs, NEW_PHONE);
    const later = await t.link(t.ownerAs, NEW_PHONE + 1);
    expect(later.superseded?.chat_id).toBe(NEW_PHONE);
    expect((await t.links.ownerLinks(t.vaultId, T0)).pending?.chat_id).toBe(NEW_PHONE + 1);
    const again = await t.link(t.ownerAs, OWNER_CHAT);
    expect(again.relinked).toBe(true);
    expect(again.link.activated_at).toBe((T0 + 7n * DAY_NS).toString());
    // The superseded chat is told about the newer link.
    expect(
      t.sent.some((s) => s.chat === NEW_PHONE && s.alert.html.includes("new owner chat")),
    ).toBe(true);
  });

  it("gives an immature owner chat in force no Approve or Cancel, and the store refuses it too", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    await t.link(t.ownerAs, NEW_PHONE);
    expect(t.buttons(OWNER_CHAT)).toEqual({});
    expect(t.sent.find((s) => s.chat === OWNER_CHAT)?.alert.html).toMatch(
      /cannot approve or cancel/,
    );
    expect(await t.links.approveReplacement(t.vaultId, OWNER_CHAT, NEW_PHONE, T0)).toBeNull();
    expect(await t.links.cancelReplacement(t.vaultId, OWNER_CHAT, NEW_PHONE, T0)).toBeNull();
  });

  it("keeps an announcement queued until its send succeeds, and announces activation", async () => {
    const t = await setup();
    await t.link(t.emmaAs, EMMA_CHAT);
    t.hooks.failSend = (chat) => chat === EMMA_CHAT;
    await t.link(t.ownerAs, OWNER_CHAT);
    expect(t.sent.filter((s) => s.chat === EMMA_CHAT)).toEqual([]);
    expect(t.logs.some((l) => l.msg.includes("link alert failed; will retry"))).toBe(true);
    t.hooks.failSend = null;
    await t.confirmation.tickLinks();
    await t.confirmation.tickLinks();
    expect(t.sent.filter((s) => s.chat === EMMA_CHAT).map((s) => s.alert.html)).toEqual([
      `A new owner chat was linked to Vault #${t.vaultId}; it becomes active 2026-11-09 08:42 UTC.`,
    ]);
    // At maturity the owner chat and the Guardians are told, once.
    t.mock.setNow(T0 + OWNER_LINK_MATURITY_NS);
    await t.confirmation.tickLinks();
    await t.confirmation.tickLinks();
    for (const chat of [OWNER_CHAT, EMMA_CHAT]) {
      expect(
        t.sent.filter((s) => s.chat === chat && s.alert.html.includes("is active from")),
      ).toHaveLength(1);
    }
  });

  it("persists a promotion, so a fresh store and every reader agree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-promote-"));
    try {
      const path = join(dir, "links.json");
      const t = await setup({ links: new FileLinkStore(path) });
      await t.link(t.ownerAs, OWNER_CHAT);
      await t.link(t.emmaAs, EMMA_CHAT);
      t.mock.advance(8n * DAY_NS);
      const { link } = await t.link(t.ownerAs, NEW_PHONE);
      t.mock.setNow(BigInt(link.activated_at as string));
      await t.confirmation.tickLinks(); // any read with NEAR time promotes and saves
      const fresh = new FileLinkStore(path);
      const stored = await fresh.linksForVault(t.vaultId); // no NEAR time: as stored
      expect(stored.map((l) => l.chat_id).sort()).toEqual([EMMA_CHAT, NEW_PHONE]);
      expect(stored.find((l) => l.chat_id === NEW_PHONE)).toMatchObject({
        pending_replace_of: null,
      });
      for (const chat of [OWNER_CHAT, NEW_PHONE, EMMA_CHAT]) {
        expect(t.sent.some((s) => s.chat === chat && s.alert.html.includes("changed"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends an owner chat linked before signed codes a one-time re-link notice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-legacy-"));
    try {
      const path = join(dir, "links.json");
      await writeFile(
        path,
        JSON.stringify({
          links: [{ chat_id: 9, vault_id: "1", account_id: OWNER, role: "owner", linked_at: "x" }],
        }),
      );
      const t = await setup({ links: new FileLinkStore(path) });
      await t.confirmation.tickLinks();
      await t.confirmation.tickLinks();
      const notices = t.sent.filter((s) => s.chat === 9);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.alert.html).toMatch(/link-code command/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Owner Confirmation", () => {
  it("a confirmed loosening change (last 6 characters typed) is not vetoed and applies", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const requests = t.requests();
    expect(requests.map((r) => r.chat)).toEqual([OWNER_CHAT]);
    const html = requests[0]?.alert.html ?? "";
    expect(html).toContain(
      `Recovery Address: <code>${RECOVERY}</code> → <code>${NEW_RECOVERY}</code>`,
    );
    const { effective_at } = await t.change(id);
    expect(html).toContain(`Takes effect at: <code>2026-11-16 09:42 UTC</code>`);
    expect(BigInt(effective_at)).toBe(T0 + OWNER_LINK_MATURITY_NS + HOUR_NS + 7n * DAY_NS);
    expect(html).toContain("Veto at: <code>2026-11-16 08:37 UTC</code>");
    expect(html.toLowerCase()).not.toMatch(/duress|envelope/);
    expect(await t.entry(id)).toMatchObject({
      confirmation: "requested",
      request_chats: [OWNER_CHAT],
    });

    const { Confirm } = t.buttons(OWNER_CHAT);
    expect(await t.press(OWNER_CHAT, Confirm)).toBe(
      "Type the last 6 characters of the new Recovery Address.",
    );
    expect(t.sent.at(-1)).toMatchObject({ chat: OWNER_CHAT, alert: { forceReply: true } });
    // Wrong characters: still requested, asked again.
    expect(await t.reply(OWNER_CHAT, "xk7r3q")).toBe(true);
    expect(t.sent.at(-1)?.alert.html).toMatch(/^That does not match/);
    expect((await t.entry(id)).confirmation).toBe("requested");
    expect(await t.reply(OWNER_CHAT, " XK7R3P ")).toBe(true);
    expect(t.sent.at(-1)?.alert.html).toBe(`Confirmed. Recorded for Policy Change #${id}.`);
    expect(await t.entry(id)).toMatchObject({
      confirmation: "confirmed",
      confirmed_by_chat: OWNER_CHAT,
      confirmed_at: t.mock.now().toString(),
    });
    // A text with no open prompt is not ours.
    expect(await t.reply(OWNER_CHAT, "hello")).toBe(false);

    await t.toVetoAt(id);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect(await t.entry(id)).toMatchObject({ status: "skipped", cause: "owner confirmed" });
    t.mock.setNow(BigInt(effective_at));
    await t.mock.applyPolicyChange(id);
    expect((await t.mock.getVault(t.vaultId)).policy.recovery_address).toBe(NEW_RECOVERY);
    await t.tick();
    expect(t.requests()).toHaveLength(1);
    expect(t.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(JSON.stringify(t.logs)).not.toMatch(/duress|confirmed_by/);
  });

  it("confirms a change without a new Recovery Address at the press, with no typing", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    expect(t.requests()[0]?.alert.html).toContain(
      "Fee Cap: <code>0.00100000 BTC</code> → <code>0.00200000 BTC</code>",
    );
    expect(await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm)).toBe(
      `Confirmed. Recorded for Policy Change #${id}.`,
    );
    await t.toVetoAt(id);
    await t.tick();
    expect(t.veto.calls).toBe(0);
    expect((await t.change(id)).state).toBe("pending");
  });

  it("vetoes an unconfirmed loosening change at veto_at", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const { Confirm } = t.buttons(OWNER_CHAT);
    await t.press(OWNER_CHAT, Confirm); // never typed
    await t.toVetoAt(id);
    await t.tick();
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect((await t.entry(id)).status).toBe("vetoed");
    // The Confirm button was spent on the first press.
    expect(await t.press(OWNER_CHAT, Confirm)).toBe("This button is no longer valid.");
  });

  it("refuses a Confirm once the veto time has passed and after the prompt window", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const { Confirm } = t.buttons(OWNER_CHAT);
    await t.press(OWNER_CHAT, Confirm);
    // Single-use: a second press of the same button does nothing (and cannot extend the window).
    expect(await t.press(OWNER_CHAT, Confirm)).toBe("This button is no longer valid.");
    t.mock.advance(PROMPT_WINDOW_NS + 1n);
    await t.reply(OWNER_CHAT, "xk7r3p");
    expect(t.sent.at(-1)?.alert.html).toMatch(/window closed/);
    expect((await t.entry(id)).confirmation).toBe("requested");
    // The next tick brings a new request with a new Confirm button.
    await t.tick();
    expect(t.requests().map((r) => r.chat)).toEqual([OWNER_CHAT, OWNER_CHAT]);
    await t.toVetoAt(id);
    expect(await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm)).toBe(
      "Too late to confirm: the veto time has passed, so the change will be vetoed.",
    );
  });

  it("vetoes a confirmed change with a duress envelope, with the same answers to the chat", async () => {
    const normal = await setup();
    const a = await linkedAndProposed(normal, { fee_cap_sats: "200000" });
    const duress = await setup();
    const b = await linkedAndProposed(duress, { fee_cap_sats: "200000" }, "duress");
    expect(duress.requests()[0]?.alert.html).toBe(normal.requests()[0]?.alert.html);
    expect(await duress.press(OWNER_CHAT, duress.buttons(OWNER_CHAT).Confirm)).toBe(
      await normal.press(OWNER_CHAT, normal.buttons(OWNER_CHAT).Confirm),
    );
    expect(a).toBe(b);
    await duress.toVetoAt(b);
    await duress.tick();
    expect(await duress.change(b)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect((await duress.entry(b)).confirmation).toBe("confirmed");
    expect(JSON.stringify(duress.logs)).not.toContain("duress");
  });

  it("refuses a Confirm from a chat linked after proposed_at, and the change is vetoed", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    t.mock.advance(DAY_NS);
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    // The owner chat in force still gets the request, with Reject only.
    expect(Object.keys(t.buttons(OWNER_CHAT))).toEqual(["Reject"]);
    expect(t.requests()[0]?.alert.html).toMatch(/This chat cannot confirm it/);
    // Still no Confirm once the link has matured: it was not active at proposed_at.
    t.mock.setNow(T0 + OWNER_LINK_MATURITY_NS + MINUTE_NS);
    await t.tick();
    expect(t.requests()).toHaveLength(1);
    expect(Object.keys(t.buttons(OWNER_CHAT))).toEqual(["Reject"]);
    expect((await t.entry(id)).confirmation).toBe("requested");
    await t.toVetoAt(id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");
  });

  it("lets an approved replacement confirm a change proposed before it was linked", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    await t.link(t.ownerAs, NEW_PHONE);
    // The pending chat gets the request too, with Reject only.
    await t.tick();
    expect(t.requests().map((r) => r.chat)).toEqual([OWNER_CHAT, NEW_PHONE]);
    expect(Object.keys(t.buttons(NEW_PHONE))).toEqual(["Reject"]);
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Approve);
    // Once it is the owner chat, active since before the proposal, it gets a Confirm button.
    await t.tick();
    expect(t.requests().map((r) => r.chat)).toEqual([OWNER_CHAT, NEW_PHONE, NEW_PHONE]);
    expect(await t.press(NEW_PHONE, t.buttons(NEW_PHONE).Confirm)).toBe(
      `Confirmed. Recorded for Policy Change #${id}.`,
    );
    expect((await t.entry(id)).confirmed_by_chat).toBe(NEW_PHONE);
  });

  it("Reject vetoes at once, from any owner link, and the tokens are single-use", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const { Confirm, Reject } = t.buttons(OWNER_CHAT);
    expect(await t.press(OWNER_CHAT, Reject)).toBe("Rejected. Sending the veto now.");
    expect(t.veto.calls).toBe(1);
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(await t.entry(id)).toMatchObject({ status: "vetoed", confirmation: "rejected" });
    expect(t.sent.at(-1)?.alert.html).toBe(`Policy Change #${id} is vetoed.`);
    expect(await t.press(OWNER_CHAT, Reject)).toBe("This button is no longer valid.");
    expect(await t.press(OWNER_CHAT, Confirm)).toBe("This button is no longer valid.");
  });

  it("Reject from a pending owner link counts; a failed veto is retried by the ticker", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    await t.link(t.ownerAs, NEW_PHONE);
    await t.tick();
    t.veto.fail = true;
    expect(await t.press(NEW_PHONE, t.buttons(NEW_PHONE).Reject)).toBe(
      "Rejected. Sending the veto now.",
    );
    expect(t.sent.at(-1)?.alert.html).toMatch(/did not land yet/);
    expect(await t.entry(id)).toMatchObject({ status: "scheduled", confirmation: "rejected" });
    expect(BigInt((await t.entry(id)).veto_at)).toBe(t.mock.now());
    t.veto.fail = false;
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");
    expect((await t.entry(id)).status).toBe("vetoed");
  });

  it("treats a binding mismatch as unconfirmed", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm);
    expect((await t.entry(id)).confirmation).toBe("confirmed");
    await t.guardStore.modify(id, (e) => ({ ...e, binding: "00".repeat(32) }));
    await t.toVetoAt(id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");

    // And a Confirm is refused when the stored binding no longer matches the change.
    const u = await setup();
    const other = await linkedAndProposed(u, { fee_cap_sats: "200000" });
    await u.guardStore.modify(other, (e) => ({ ...e, binding: "00".repeat(32) }));
    expect(await u.press(OWNER_CHAT, u.buttons(OWNER_CHAT).Confirm)).toBe(
      "This change no longer matches the request.",
    );
  });

  it("sends no request without an owner link, and vetoes (fail-closed)", async () => {
    const t = await setup();
    await t.link(t.emmaAs, EMMA_CHAT);
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    expect(t.requests()).toEqual([]);
    expect((await t.entry(id)).confirmation).toBe("none");
    await t.toVetoAt(id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");
  });

  it("refuses a press from another chat with no state change", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    const before = await t.entry(id);
    const { Confirm, Reject } = t.buttons(OWNER_CHAT);
    expect(await t.press(EMMA_CHAT, Confirm)).toBe("This button is no longer valid.");
    expect(await t.press(EMMA_CHAT, Reject)).toBe("This button is no longer valid.");
    expect(await t.press(EMMA_CHAT, "made-up-token")).toBe("This button is no longer valid.");
    expect(await t.entry(id)).toEqual(before);
    expect(t.veto.calls).toBe(0);
    expect(t.sent.filter((s) => s.chat === EMMA_CHAT && s.alert.buttons.length)).toEqual([]);
  });

  it("sends no request for a Challenge Vault or a tightening change", async () => {
    const parent = "challenge.testnet";
    const t = await setup({ owner: `alice.${parent}`, challengeOwnerParent: parent });
    await t.link(t.ownerAs, OWNER_CHAT);
    t.mock.advance(8n * DAY_NS);
    await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick();
    expect(t.requests()).toEqual([]);

    const u = await setup();
    const id = await linkedAndProposed(u, { delay_ns: (48n * HOUR_NS).toString() });
    expect(u.requests()).toEqual([]);
    expect((await u.entry(id)).status).toBe("skipped");
  });

  it("Reject after Confirm still vetoes, before and after the guard left the change (G2)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    const { Confirm, Reject } = t.buttons(OWNER_CHAT);
    await t.press(OWNER_CHAT, Confirm);
    await t.toVetoAt(id);
    await t.tick();
    expect(await t.entry(id)).toMatchObject({ status: "skipped", cause: "owner confirmed" });
    // The chain still says pending, so a Reject reopens the entry and vetoes now.
    expect(await t.press(OWNER_CHAT, Reject)).toBe("Rejected. Sending the veto now.");
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(await t.entry(id)).toMatchObject({ status: "vetoed", confirmation: "rejected" });

    // Before veto_at: confirmed, then rejected.
    const u = await setup();
    const other = await linkedAndProposed(u, { fee_cap_sats: "200000" });
    await u.press(OWNER_CHAT, u.buttons(OWNER_CHAT).Confirm);
    expect(await u.press(OWNER_CHAT, u.buttons(OWNER_CHAT).Reject)).toBe(
      "Rejected. Sending the veto now.",
    );
    expect((await u.change(other)).state).toBe("vetoed");
  });

  it("a Reject that lands between the ticker's read and its leave wins (G3)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    const { Confirm, Reject } = t.buttons(OWNER_CHAT);
    await t.press(OWNER_CHAT, Confirm);
    await t.toVetoAt(id);
    // The ticker reads the confirmed entry; the Reject is recorded before it can leave it.
    t.hooks.afterTickerEntry = async () => {
      await t.confirmation.press(OWNER_CHAT, OWNER_CHAT, Reject as string); // its veto not run yet
    };
    await t.ticker.tick();
    expect(await t.change(id)).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(await t.entry(id)).toMatchObject({ status: "vetoed", confirmation: "rejected" });
  });

  it("counts an unreadable duress flag as duress when a watcher key is configured (G7)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" }, "unreadable");
    expect((await t.entry(id)).duress).toBe("unknown");
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm);
    await t.toVetoAt(id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");

    // Without a key configured, unknown is every Vault's flag and the confirmation counts.
    const u = await setup({ keyConfigured: false });
    const other = await linkedAndProposed(u, { fee_cap_sats: "200000" }, "unreadable");
    await u.press(OWNER_CHAT, u.buttons(OWNER_CHAT).Confirm);
    await u.toVetoAt(other);
    await u.tick();
    expect((await u.change(other)).state).toBe("pending");
  });

  it("rolls a failed request back and delivers it on the next tick (G9)", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
    t.mock.advance(OWNER_LINK_MATURITY_NS + HOUR_NS);
    const id = await t.propose({ fee_cap_sats: "200000" });
    t.hooks.failSend = (_chat, alert) => alert.html.includes("Owner Confirmation for");
    await t.tick();
    expect(await t.entry(id)).toMatchObject({ confirmation: "none", request_chats: [] });
    expect(t.logs.some((l) => l.msg.includes("confirmation request failed; will retry"))).toBe(
      true,
    );
    t.hooks.failSend = null;
    await t.tick();
    expect(t.requests().map((r) => r.chat)).toEqual([OWNER_CHAT]);
    expect(await t.entry(id)).toMatchObject({
      confirmation: "requested",
      request_chats: [OWNER_CHAT],
    });
    expect(await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm)).toBe(
      `Confirmed. Recorded for Policy Change #${id}.`,
    );
  });

  it("does not record a Confirm once the veto time passes between the checks and the write (G10)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    const vetoAt = BigInt((await t.entry(id)).veto_at);
    let reads = 0;
    // The checks read NEAR time first; the write's own fresh read comes last.
    t.hooks.clock = () => {
      if (++reads === 2) t.mock.setNow(vetoAt);
    };
    expect(await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm)).toBe(
      "Too late to confirm: the veto time has passed, so the change will be vetoed.",
    );
    t.hooks.clock = null;
    expect((await t.entry(id)).confirmation).toBe("requested");
  });

  it("fixes the typing window at the press and allows 3 wrong answers (G14)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm);
    const deadline = (await t.links.prompt(OWNER_CHAT))?.expires_at;
    for (const left of ["2 tries left", "1 try left"]) {
      t.mock.advance(MINUTE_NS);
      await t.reply(OWNER_CHAT, "aaaaaa");
      expect(t.sent.at(-1)?.alert.html).toContain(left);
    }
    await t.reply(OWNER_CHAT, "aaaaaa");
    expect(t.sent.at(-1)?.alert.html).toMatch(/Too many wrong answers/);
    expect((await t.links.prompt(OWNER_CHAT))?.expires_at).toBe(deadline);
    // Locked out: even the right answer does not count now.
    await t.reply(OWNER_CHAT, "xk7r3p");
    expect(t.sent.at(-1)?.alert.html).toMatch(/Too many wrong answers/);
    expect((await t.entry(id)).confirmation).toBe("requested");
    // No new request while the lockout lasts; one after it.
    await t.tick();
    expect(t.requests()).toHaveLength(1);
    t.mock.setNow(BigInt(deadline as string) + 1n);
    await t.tick();
    expect(t.requests()).toHaveLength(2);
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Confirm);
    await t.reply(OWNER_CHAT, "xk7r3p");
    expect((await t.entry(id)).confirmation).toBe("confirmed");
  });

  it("counts presses and replies only from the person who linked the owner chat (G4)", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const { Confirm, Reject } = t.buttons(OWNER_CHAT);
    const stranger = 999;
    const notYours = "Only the person who linked this chat can use this button.";
    expect(await t.press(OWNER_CHAT, Confirm, stranger)).toBe(notYours);
    expect(await t.press(OWNER_CHAT, Reject, stranger)).toBe(notYours);
    expect(await t.entry(id)).toMatchObject({ confirmation: "requested", status: "scheduled" });
    await t.press(OWNER_CHAT, Confirm);
    expect(await t.reply(OWNER_CHAT, "xk7r3p", stranger)).toBe(true);
    expect(t.sent.at(-1)?.alert.html).toBe(notYours);
    expect((await t.entry(id)).confirmation).toBe("requested");
    await t.reply(OWNER_CHAT, "xk7r3p");
    expect((await t.entry(id)).confirmation).toBe("confirmed");
  });
});

describe("Owner Confirmation restart", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("keeps the buttons working after a restart and sends no duplicate request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-confirm-"));
    dirs.push(dir);
    const files = () => ({
      links: new FileLinkStore(join(dir, "links.json")),
      guardStore: new FileGuardStore(join(dir, "guard.json")),
    });
    const first = await setup(files());
    const id = await linkedAndProposed(first, { fee_cap_sats: "200000" });
    const { Confirm } = first.buttons(OWNER_CHAT);
    expect(first.requests()).toHaveLength(1);

    // A new process: new stores on the same files, a new guard loop that replays from event 0.
    const second = await setup({ ...files(), mock: first.mock, vaultId: first.vaultId });
    await second.tick();
    await second.tick();
    expect(second.requests()).toEqual([]);
    expect(await second.press(OWNER_CHAT, Confirm)).toBe(
      `Confirmed. Recorded for Policy Change #${id}.`,
    );
    await second.toVetoAt(id);
    await second.tick();
    expect(second.veto.calls).toBe(0);
    expect((await second.entry(id)).status).toBe("skipped");
  });
});

describe("TelegramBot with Owner Confirmation", () => {
  it("links with /start, answers every button press and reads the typed step", async () => {
    const t = await setup();
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = new TelegramBot("1:test", t.links, () => undefined, t.linking.clock);
    const inner = (bot as unknown as { bot: Bot }).bot;
    inner.botInfo = {
      id: 1,
      is_bot: true,
      first_name: "Morrow",
      username: "MorrowAlert_Bot",
    } as never;
    // Every Bot API call is answered here: nothing reaches Telegram.
    inner.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      const chat = { id: (payload as { chat_id?: number }).chat_id ?? 0, type: "private" };
      return {
        ok: true,
        result: (method === "sendMessage"
          ? { message_id: calls.length, date: 0, chat, text: "" }
          : true) as never,
      };
    });
    const actions = new OwnerConfirmation({
      links: t.links,
      sender: bot,
      reader: t.mock,
      clock: t.linking.clock,
      log: () => undefined,
      guard: { store: t.guardStore, vetoNow: (id) => t.ticker.vetoNow(id) },
    });
    bot.attach(actions);
    const user = { id: OWNER_CHAT, is_bot: false, first_name: "Daniel" };
    const chat = { id: OWNER_CHAT, type: "private" as const, first_name: "Daniel" };
    let update = 0;
    const text = (body: string) =>
      inner.handleUpdate({
        update_id: ++update,
        message: {
          message_id: update,
          date: 0,
          chat,
          from: user,
          text: body,
          ...(body.startsWith("/")
            ? { entities: [{ type: "bot_command", offset: 0, length: body.split(" ")[0]!.length }] }
            : {}),
        },
      } as never);

    const { signedBody } = await import("./test-fixtures.js");
    const { issueLinkCode } = await import("../heartbeat.js");
    const issued = await issueLinkCode(signedBody(t.ownerAs, t.mock.now()), t.linking);
    const code = (issued.body as { code: string }).code;
    // An owner code from a group chat is refused, and the code is kept for the private chat.
    await inner.handleUpdate({
      update_id: ++update,
      message: {
        message_id: update,
        date: 0,
        chat: { id: -500, type: "group", title: "Family" },
        from: user,
        text: `/start ${code}`,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    } as never);
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", payload: { chat_id: -500 } });
    expect(String(calls.at(-1)?.payload.text)).toMatch(/only in a private chat/);
    await text(`/start ${code}`);
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", payload: { chat_id: OWNER_CHAT } });
    expect(String(calls.at(-1)?.payload.text)).toMatch(
      /can confirm Policy Changes proposed from 2026-11-09 08:42 UTC on/,
    );

    t.mock.advance(8n * DAY_NS);
    const id = await t.propose({ recovery_address: NEW_RECOVERY });
    await t.tick(); // the ticker's requests go through the setup's fake sender
    await actions.request((await t.entry(id))!, t.mock.now()); // already delivered: no-op
    const token = t.buttons(OWNER_CHAT).Confirm;
    await inner.handleUpdate({
      update_id: ++update,
      callback_query: {
        id: "q1",
        from: user,
        chat_instance: "c",
        data: token,
        message: { message_id: 1, date: 0, chat },
      },
    } as never);
    const answer = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer?.payload).toMatchObject({
      callback_query_id: "q1",
      text: "Type the last 6 characters of the new Recovery Address.",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: { chat_id: OWNER_CHAT, reply_markup: { force_reply: true } },
    });
    await text("xk7r3p");
    expect(String(calls.at(-1)?.payload.text)).toBe(
      `Confirmed. Recorded for Policy Change #${id}.`,
    );
    expect((await t.entry(id)).confirmation).toBe("confirmed");

    // A stale token is answered too, and changes nothing.
    await inner.handleUpdate({
      update_id: ++update,
      callback_query: {
        id: "q2",
        from: user,
        chat_instance: "c",
        data: "stale",
        message: { message_id: 1, date: 0, chat },
      },
    } as never);
    expect(calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "q2", text: "This button is no longer valid." },
    });
  });
});

describe("link-code CLI", () => {
  const SECRET_HEX = "11".repeat(32);
  const argv = (watcher: string, role = "owner", account = OWNER) => [
    "--watcher",
    watcher,
    "--bot",
    "@MorrowAlert_Bot",
    "--vault",
    "7",
    "--role",
    role,
    "--account",
    account,
    "--key-file",
    "/keys/owner.key",
  ];
  const deps = (fetchFn: typeof fetch, overrides: Partial<LinkCodeDeps> = {}) => {
    const said: string[] = [];
    return {
      said,
      deps: {
        fetch: fetchFn,
        readFile: async () => `${SECRET_HEX}\n`,
        fileMode: async () => 0o100600,
        say: (line: string) => void said.push(line),
        now: () => T0,
        ...overrides,
      } satisfies LinkCodeDeps,
    };
  };

  it("signs the request for the named bot with the key file's secret and posts it", async () => {
    const args = parseArgs(["--", ...argv("https://watcher.test/")]);
    let posted: { url: string; body: Record<string, string> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posted = { url, body: JSON.parse(String(init.body)) as Record<string, string> };
      return new Response(
        JSON.stringify({ code: "ABCDEFGH", deep_link: "https://t.me/x?start=ABCDEFGH" }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const { said, deps: d } = deps(fakeFetch);
    const result = await linkCode(args, d);
    expect(result.code).toBe("ABCDEFGH");
    const sentRequest = posted as unknown as { url: string; body: Record<string, string> };
    expect(sentRequest.url).toBe("https://watcher.test/link-codes");
    const { signature, ...request } = sentRequest.body;
    expect(request).toEqual({ vault_id: "7", role: "owner", account_id: OWNER, ts: T0.toString() });
    const signed = { ...request, bot: "MorrowAlert_Bot" } as never;
    expect(verifyLinkRequest(signed, signature as string, OWNER_KEYS.publicKey)).toBe(true);
    expect(said).toEqual(["The key is used here to sign the request; it is never sent."]);
    // No key material anywhere but the signature.
    expect(JSON.stringify([sentRequest, said, result])).not.toContain(SECRET_HEX);
  });

  it("refuses plain http except to localhost, and a key file others can read", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ code: "C", deep_link: "D" }), {
        status: 201,
      })) as unknown as typeof fetch;
    await expect(linkCode(parseArgs(argv("http://watcher.test")), deps(ok).deps)).rejects.toThrow(
      /https/,
    );
    for (const local of ["http://localhost:8080", "http://127.0.0.1:8080"]) {
      await expect(linkCode(parseArgs(argv(local)), deps(ok).deps)).resolves.toMatchObject({
        code: "C",
      });
    }
    const loose = deps(ok, { fileMode: async () => 0o100644 });
    const error = await linkCode(parseArgs(argv("https://w.test")), loose.deps).catch(
      (e: Error) => e,
    );
    expect(String(error)).toMatch(/mode 644.*chmod 600 \/keys\/owner.key/);
    expect(String(error)).not.toContain(SECRET_HEX);
  });

  it("refuses bad arguments, a bad key file and a refusal from the watcher", async () => {
    expect(() => parseArgs(["--vault", "7"])).toThrow(/usage/);
    expect(() => parseArgs(argv("https://w.test", "admin"))).toThrow(/usage/);
    const args = parseArgs(argv("https://w.test", "guardian", EMMA));
    const refuse = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as unknown as typeof fetch;
    const bad = deps(refuse, { readFile: async () => "zz" });
    await expect(linkCode(args, bad.deps)).rejects.toThrow(/key file/);
    await expect(linkCode(args, deps(refuse).deps)).rejects.toThrow(/HTTP 401 nope/);
  });
});
