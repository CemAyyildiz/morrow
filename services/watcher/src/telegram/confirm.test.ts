import { mkdtemp, rm } from "node:fs/promises";
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
import { linkCode, parseArgs } from "../cli/link-code.js";
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
  const clock = { now: async () => mock.now() };
  const linking: LinkingOptions = { links, botUsername: "MorrowAlert_Bot", reader: mock, clock };
  const logs: { level: LogLevel; msg: string; fields: Record<string, unknown> }[] = [];
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) =>
    logs.push({ level, msg, fields });
  const sent: { chat: number; alert: Alert }[] = [];
  const sender: Sender = { send: async (chat, alert) => void sent.push({ chat, alert }) };
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
  const ticker = new GuardTicker({
    reader: mock,
    signer,
    store: guardStore,
    guardianAccount: GUARDIAN,
    clock,
    log,
    callTimeoutMs: 200,
    requests: { request: async (entry, now) => confirmation?.request(entry, now) },
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
  const tick = async () => {
    await loop.tick();
    await ticker.tick();
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
    await actions.announceLink(redeemed);
    return redeemed;
  };
  const propose = async (
    changes: ProposePolicyChangeArgs["changes"],
    flag: "normal" | "duress" = "normal",
  ) =>
    as(mock, owner).proposePolicyChange({
      vault_id: vaultId,
      changes,
      envelope: await sealEnvelope(flag, vaultKey.publicKeyHex),
    });
  /** The callback tokens of the last message with buttons sent to `chat`. */
  const buttons = (chat: number): Record<string, string> => {
    const last = sent.filter((s) => s.chat === chat && s.alert.buttons.length).at(-1);
    return Object.fromEntries(
      (last?.alert.buttons ?? []).map((b) => [b.text, "callback" in b ? b.callback : b.url]),
    );
  };
  /** Presses a button and runs its follow-up, as the bot does; returns the answer. */
  const press = async (chat: number, token: string | undefined) => {
    const result = await actions.press(chat, token ?? "missing");
    await result.after?.();
    return result.answer;
  };
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
  flag?: "duress",
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
    for (const chat of [OWNER_CHAT, EMMA_CHAT, NEW_PHONE]) {
      expect(t.sent.some((s) => s.chat === chat && s.alert.html.includes("was replaced"))).toBe(
        true,
      );
    }
    // Single use.
    expect(await t.press(OWNER_CHAT, Approve)).toBe("This button is no longer valid.");
  });

  it("Cancel from the owner chat in force drops the pending link", async () => {
    const t = await setup();
    await t.link(t.ownerAs, OWNER_CHAT);
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
    expect(await t.confirmation.reply(OWNER_CHAT, "xk7r3q")).toBe(true);
    expect(t.sent.at(-1)?.alert.html).toMatch(/^That does not match/);
    expect((await t.entry(id)).confirmation).toBe("requested");
    expect(await t.confirmation.reply(OWNER_CHAT, " XK7R3P ")).toBe(true);
    expect(t.sent.at(-1)?.alert.html).toBe(`Confirmed. Recorded for Policy Change #${id}.`);
    expect(await t.entry(id)).toMatchObject({
      confirmation: "confirmed",
      confirmed_by_chat: OWNER_CHAT,
      confirmed_at: t.mock.now().toString(),
    });
    // A text with no open prompt is not ours.
    expect(await t.confirmation.reply(OWNER_CHAT, "hello")).toBe(false);

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
    // Too late now.
    expect(await t.press(OWNER_CHAT, Confirm)).toBe(
      "This change is no longer waiting for confirmation.",
    );
  });

  it("refuses a Confirm once the veto time has passed and after the prompt window", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { recovery_address: NEW_RECOVERY });
    const { Confirm } = t.buttons(OWNER_CHAT);
    await t.press(OWNER_CHAT, Confirm);
    t.mock.advance(PROMPT_WINDOW_NS + 1n);
    await t.confirmation.reply(OWNER_CHAT, "xk7r3p");
    expect(t.sent.at(-1)?.alert.html).toMatch(/window closed/);
    expect((await t.entry(id)).confirmation).toBe("requested");
    await t.toVetoAt(id);
    expect(await t.press(OWNER_CHAT, Confirm)).toBe(
      "Too late to confirm: the veto time has passed.",
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
    // The owner chat in force still gets the request, so it can Reject.
    const { Confirm } = t.buttons(OWNER_CHAT);
    expect(await t.press(OWNER_CHAT, Confirm)).toBe(
      "This chat was linked too recently to confirm this change.",
    );
    // Still refused once the link has matured: it was not active at proposed_at.
    t.mock.setNow(T0 + OWNER_LINK_MATURITY_NS + MINUTE_NS);
    expect(await t.press(OWNER_CHAT, Confirm)).toBe(
      "This chat was linked too recently to confirm this change.",
    );
    expect((await t.entry(id)).confirmation).toBe("requested");
    await t.toVetoAt(id);
    await t.tick();
    expect((await t.change(id)).state).toBe("vetoed");
  });

  it("lets an approved replacement confirm a change proposed before it was linked", async () => {
    const t = await setup();
    const id = await linkedAndProposed(t, { fee_cap_sats: "200000" });
    await t.link(t.ownerAs, NEW_PHONE);
    // The pending chat gets the request too, but cannot confirm.
    await t.tick();
    expect(t.requests().map((r) => r.chat)).toEqual([OWNER_CHAT, NEW_PHONE]);
    expect(await t.press(NEW_PHONE, t.buttons(NEW_PHONE).Confirm)).toBe(
      "Only the Vault's active owner chat can confirm.",
    );
    await t.press(OWNER_CHAT, t.buttons(OWNER_CHAT).Approve);
    const requestToNewPhone = t.sent.filter(
      (s) => s.chat === NEW_PHONE && s.alert.buttons.length,
    )[0];
    const confirm = requestToNewPhone?.alert.buttons.find((b) => b.text === "Confirm");
    expect(await t.press(NEW_PHONE, confirm && "callback" in confirm ? confirm.callback : "")).toBe(
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
    await text(`/start ${(issued.body as { code: string }).code}`);
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
  it("signs the request with the key file's secret and posts it", async () => {
    const args = parseArgs([
      "--",
      "--watcher",
      "http://watcher.test/",
      "--vault",
      "7",
      "--role",
      "owner",
      "--account",
      OWNER,
      "--key-file",
      "/keys/owner.key",
    ]);
    let posted: { url: string; body: Record<string, string> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posted = { url, body: JSON.parse(String(init.body)) as Record<string, string> };
      return new Response(
        JSON.stringify({ code: "ABCDEFGH", deep_link: "https://t.me/x?start=ABCDEFGH" }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;
    const result = await linkCode(args, {
      fetch: fakeFetch,
      readFile: async () => `${"11".repeat(32)}\n`,
      now: () => T0,
    });
    expect(result.code).toBe("ABCDEFGH");
    const sentRequest = posted as unknown as { url: string; body: Record<string, string> };
    expect(sentRequest.url).toBe("http://watcher.test/link-codes");
    const { signature, ...request } = sentRequest.body;
    expect(request).toEqual({ vault_id: "7", role: "owner", account_id: OWNER, ts: T0.toString() });
    expect(verifyLinkRequest(request as never, signature as string, OWNER_KEYS.publicKey)).toBe(
      true,
    );
  });

  it("refuses bad arguments, a bad key file and a refusal from the watcher", async () => {
    expect(() => parseArgs(["--vault", "7"])).toThrow(/usage/);
    expect(() =>
      parseArgs([
        "--role",
        "admin",
        "--watcher",
        "x",
        "--vault",
        "1",
        "--account",
        "a.testnet",
        "--key-file",
        "k",
      ]),
    ).toThrow(/usage/);
    const args = parseArgs([
      "--watcher",
      "http://w",
      "--vault",
      "7",
      "--role",
      "guardian",
      "--account",
      EMMA,
      "--key-file",
      "k",
    ]);
    const refuse = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as unknown as typeof fetch;
    await expect(
      linkCode(args, { fetch: refuse, readFile: async () => "zz", now: () => T0 }),
    ).rejects.toThrow(/key file/);
    await expect(
      linkCode(args, { fetch: refuse, readFile: async () => "33".repeat(32), now: () => T0 }),
    ).rejects.toThrow(/HTTP 401 nope/);
  });
});
