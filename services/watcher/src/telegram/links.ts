import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DAY_NS, MINUTE_NS, type U64 } from "@morrow/core-ts";

export type LinkRole = "owner" | "guardian";

/**
 * A Telegram chat linked to a Vault role. Owner links follow three rules (5.3b): a Vault has one
 * owner link in force; a new one replaces it only after `OWNER_LINK_MATURITY_NS`, or at once when
 * the chat in force approves; and a link counts for Owner Confirmation only once `activated_at`
 * has passed.
 */
export interface Link {
  chat_id: number;
  vault_id: string;
  account_id: string;
  role: LinkRole;
  linked_at: string;
  /**
   * NEAR time (ns) from which the link is active. Absent on links made before link codes were
   * signed: such a link still receives alerts but has no say (no Confirm, Reject or Approve).
   */
  activated_at?: U64;
  /** On a pending owner replacement: the chat id of the owner link it replaces. */
  pending_replace_of?: number | null;
  /** On the owner link in force: the chat id of its pending replacement. */
  replaced_by?: number | null;
  /**
   * The Telegram user who redeemed the code. Owner links are made only in private chats, and
   * only this user's button presses and replies count for them.
   */
  user_id?: number;
  /** Chats still to be told about this new link (R4); each is removed once a send succeeds. */
  announce_to?: number[];
  /** Whether the link's activation (maturity, approval or promotion) was already queued. */
  activation_noted?: boolean;
  /** Chats still to be told that this owner link became active. */
  active_announce_to?: number[];
  /** On an owner link that took over: the chat of the owner link it replaced. */
  replaced_chat?: number | null;
  /** On a link made before signed codes: the one-time re-link notice was sent. */
  legacy_notified?: boolean;
}

interface PendingCode {
  vault_id: string;
  account_id: string;
  role: LinkRole;
  /** NEAR time (ns). */
  expires_at: U64;
}

export type CallbackAction = "confirm" | "reject" | "approve_link" | "cancel_link";

/**
 * What one inline button may do. The button's callback data is only a random token that names
 * the grant; the grant itself never leaves the watcher.
 */
export interface CallbackGrant {
  action: CallbackAction;
  vault_id: string;
  /** The chat the button was sent to; a press from any other chat is refused. */
  chat_id: number;
  /** Confirm and Reject: the Policy Change. */
  change_id: U64 | null;
  /** Approve and Cancel: the chat of the pending owner link. */
  link_chat_id: number | null;
  /** NEAR time (ns) after which the token is pruned. */
  expires_at: U64;
}

/** An open "type the last 6 characters" step of a Confirm. */
export interface Prompt {
  chat_id: number;
  vault_id: string;
  change_id: U64;
  /** The last 6 characters of the new Recovery Address, lowercase. */
  suffix: string;
  /** NEAR time (ns) the window closes; fixed when Confirm is pressed, never extended. */
  expires_at: U64;
  /** Wrong answers so far; at `MAX_PROMPT_ATTEMPTS` the chat is locked out until `expires_at`. */
  attempts: number;
}

/** Wrong answers allowed in one typed-confirmation window. */
export const MAX_PROMPT_ATTEMPTS = 3;

interface State {
  links: Link[];
  codes: Record<string, PendingCode>;
  /** Used link requests (`<vault>:<role>:<account>:<ts>`) → NEAR time (ns) they can be dropped. */
  nonces: Record<string, U64>;
  callbacks: Record<string, CallbackGrant>;
  prompts: Prompt[];
}

export const CODE_TTL_NS = 10n * MINUTE_NS;
/** A new owner link has a say only this long after it was linked, unless the chat in force approves. */
export const OWNER_LINK_MATURITY_NS = 7n * DAY_NS;
/** Callback tokens outlive the longest Policy Change Delay (90 days). */
export const CALLBACK_TTL_NS = 100n * DAY_NS;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const iso = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString();

/** Signed links only: those made from a signed link code carry `activated_at`. */
export const isSigned = (link: Link): boolean => typeof link.activated_at === "string";

const isOwnerOf = (link: Link, vaultId: string) =>
  link.vault_id === vaultId && link.role === "owner" && isSigned(link);

const unique = (chats: number[]) => [...new Set(chats)];

const guardianChats = (state: State, vaultId: string) =>
  state.links.filter((l) => l.vault_id === vaultId && l.role === "guardian").map((l) => l.chat_id);

/**
 * Queues the activation notice of an owner link: to the link's own chat, the chat it replaced
 * (if any) and every Guardian chat of the Vault.
 */
function noteActivation(state: State, link: Link, replaced: number | null): void {
  link.activation_noted = true;
  link.replaced_chat = replaced;
  link.active_announce_to = unique([
    ...(replaced === null ? [] : [replaced]),
    link.chat_id,
    ...guardianChats(state, link.vault_id),
  ]);
}

/**
 * Whether `byChat` may approve or cancel `pendingChat`: it is the owner link in force, already
 * active, and `pendingChat` is its pending replacement. An immature link in force has no say.
 */
function replacementDecider(
  current: Link | null,
  pending: Link | null,
  byChat: number,
  pendingChat: number,
  now: bigint,
): boolean {
  return (
    current !== null &&
    pending !== null &&
    current.chat_id === byChat &&
    pending.chat_id === pendingChat &&
    BigInt(current.activated_at as string) <= now
  );
}

/**
 * The one place owner links move with time, run by every read and write: a pending replacement
 * whose `activated_at` has passed takes over (the link it replaced is removed), a pending link
 * whose target is gone stands on its own, and a link that becomes active has its activation
 * announced. Returns whether anything changed, so the caller persists it.
 */
function promote(state: State, now: bigint): boolean {
  let changed = false;
  for (const link of [...state.links]) {
    if (!isSigned(link) || link.role !== "owner") continue;
    if (link.pending_replace_of != null) {
      const target = state.links.find(
        (l) => isOwnerOf(l, link.vault_id) && l.chat_id === link.pending_replace_of,
      );
      if (target && BigInt(link.activated_at as string) > now) continue;
      if (target) state.links = state.links.filter((l) => l !== target);
      link.pending_replace_of = null;
      link.replaced_by = null;
      changed = true;
      if (target) {
        noteActivation(state, link, target.chat_id);
        continue;
      }
    }
    if (!link.activation_noted && BigInt(link.activated_at as string) <= now) {
      noteActivation(state, link, null);
      changed = true;
    }
  }
  return changed;
}

function ownerPair(state: State, vaultId: string): OwnerLinks {
  const owners = state.links.filter((l) => isOwnerOf(l, vaultId));
  return {
    current: owners.find((l) => l.pending_replace_of == null) ?? null,
    pending: owners.find((l) => l.pending_replace_of != null) ?? null,
  };
}

export interface OwnerLinks {
  /** The owner link in force (it may not be active yet). */
  current: Link | null;
  /** A replacement waiting for approval or for its `activated_at`. */
  pending: Link | null;
}

export interface Redeemed {
  link: Link;
  /** The chat was already linked to this role: nothing changed and nothing is announced. */
  relinked: boolean;
  /** The owner link in force that `link` would replace, or null. */
  replaces: Link | null;
  /** An earlier pending replacement that `link` superseded (dropped). */
  superseded: Link | null;
  /** Every other link of the Vault, to be told about the new one. */
  others: Link[];
}

export interface CodeRequest {
  vault_id: string;
  account_id: string;
  role: LinkRole;
}

/** Telegram chat links, kept only in the watcher's own store (never on-chain). */
export abstract class LinkStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<State>;
  protected abstract save(state: State): Promise<void>;

  /** Serializes read-modify-write cycles, so two requests never both use one nonce or code. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<State> {
    return { ...empty(), ...(await this.load()) };
  }

  /**
   * Runs `work` on the state inside the write queue, after `promote` when `now` is given (so
   * every reader sees the same owner links). Saves when `work` says it wrote or promotion
   * changed something.
   */
  private run<T>(
    now: bigint | null,
    work: (state: State) => { result: T; write: boolean } | Promise<{ result: T; write: boolean }>,
  ): Promise<T> {
    return this.exclusive(async () => {
      const state = await this.read();
      const promoted = now !== null && promote(state, now);
      const { result, write } = await work(state);
      if (write || promoted) await this.save(state);
      return result;
    });
  }

  /**
   * A single-use 8-character code that links the chat that sends it to this Vault role, or null
   * when `nonce` (a signed request) was already used. The caller has checked the signature.
   */
  createCode(
    request: CodeRequest,
    nonce: { key: string; expiresAt: bigint },
    now: bigint,
  ): Promise<string | null> {
    return this.exclusive(async () => {
      const state = await this.read();
      state.nonces = Object.fromEntries(
        Object.entries(state.nonces).filter(([, expires]) => BigInt(expires) >= now),
      );
      if (Object.hasOwn(state.nonces, nonce.key)) return null;
      state.nonces[nonce.key] = nonce.expiresAt.toString();
      const code = Array.from(
        { length: 8 },
        () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join("");
      state.codes = Object.fromEntries(
        Object.entries(state.codes).filter(([, p]) => BigInt(p.expires_at) >= now),
      );
      state.codes[code] = { ...request, expires_at: (now + CODE_TTL_NS).toString() };
      await this.save(state);
      return code;
    });
  }

  /**
   * Consumes a code and links the chat; null if the code is unknown or expired, and
   * `private_chat_required` (the code is kept) for an owner code sent from a group. A first owner
   * link activates after `OWNER_LINK_MATURITY_NS`; a later one is a pending replacement of the
   * link in force (superseding an earlier pending one), which the chat in force may approve or
   * cancel once it is active. Every other chat of the Vault is queued to be told (R4). Written
   * before the caller answers the chat.
   */
  redeem(
    code: string,
    chatId: number,
    now: bigint,
    from: { userId: number; privateChat: boolean },
  ): Promise<Redeemed | "private_chat_required" | null> {
    return this.run<Redeemed | "private_chat_required" | null>(now, (state) => {
      const key = code.trim().toUpperCase();
      const pending = state.codes[key];
      if (!pending || BigInt(pending.expires_at) < now) return { result: null, write: false };
      if (pending.role === "owner" && !from.privateChat) {
        return { result: "private_chat_required" as const, write: false };
      }
      state.codes = Object.fromEntries(Object.entries(state.codes).filter(([c]) => c !== key));
      const { vault_id: vaultId, role } = pending;
      const mine = (l: Link) => l.chat_id === chatId && l.vault_id === vaultId && l.role === role;
      const same = state.links.find((l) => mine(l) && isSigned(l));
      if (same) {
        const result = { link: same, relinked: true, replaces: null, superseded: null, others: [] };
        return { result, write: true };
      }
      // A link made before signed codes is replaced by the signed one.
      state.links = state.links.filter((l) => !mine(l));
      let replaces: Link | null = null;
      let superseded: Link | null = null;
      if (role === "owner") {
        const owners = ownerPair(state, vaultId);
        replaces = owners.current;
        superseded = owners.pending;
        if (superseded) state.links = state.links.filter((l) => l !== superseded);
        if (replaces) replaces.replaced_by = chatId;
      }
      const others = state.links.filter((l) => l.vault_id === vaultId);
      const link: Link = {
        chat_id: chatId,
        vault_id: vaultId,
        account_id: pending.account_id,
        role,
        linked_at: iso(now),
        activated_at: (role === "owner" ? now + OWNER_LINK_MATURITY_NS : now).toString(),
        pending_replace_of: replaces?.chat_id ?? null,
        replaced_by: null,
        user_id: from.userId,
        // A superseded pending chat is told too: it learns why it no longer counts.
        announce_to: unique([
          ...others.map((l) => l.chat_id),
          ...(superseded ? [superseded.chat_id] : []),
        ]).filter((c) => c !== chatId),
        activation_noted: role === "guardian",
        active_announce_to: [],
        replaced_chat: null,
      };
      state.links.push(link);
      return { result: { link, relinked: false, replaces, superseded, others }, write: true };
    });
  }

  /** The Vault's links as of `now` (promoted); without `now`, as last stored. */
  linksForVault(vaultId: string, now: bigint | null = null): Promise<Link[]> {
    return this.run(now, (state) => ({
      result: state.links.filter((l) => l.vault_id === vaultId),
      write: false,
    }));
  }

  /** The owner link in force and its pending replacement, as of `now`. */
  ownerLinks(vaultId: string, now: bigint): Promise<OwnerLinks> {
    return this.run(now, (state) => ({ result: ownerPair(state, vaultId), write: false }));
  }

  /** Links with chats still to be told about them, as of `now`. */
  announcements(now: bigint): Promise<Link[]> {
    return this.run(now, (state) => ({
      result: state.links.filter((l) => l.announce_to?.length || l.active_announce_to?.length),
      write: false,
    }));
  }

  /** Records that `chat` was told about `link` (`link`: its creation, `active`: its activation). */
  markAnnounced(link: Link, kind: "link" | "active", chat: number): Promise<void> {
    return this.run(null, (state) => {
      const stored = state.links.find(
        (l) => l.vault_id === link.vault_id && l.chat_id === link.chat_id && l.role === link.role,
      );
      if (!stored) return { result: undefined, write: false };
      const field = kind === "link" ? "announce_to" : "active_announce_to";
      stored[field] = (stored[field] ?? []).filter((c) => c !== chat);
      return { result: undefined, write: true };
    });
  }

  /** Owner links made before signed codes that have not had the re-link notice. */
  legacyOwnerLinks(): Promise<Link[]> {
    return this.run(null, (state) => ({
      result: state.links.filter((l) => l.role === "owner" && !isSigned(l) && !l.legacy_notified),
      write: false,
    }));
  }

  markLegacyNotified(link: Link): Promise<void> {
    return this.run(null, (state) => {
      for (const l of state.links) {
        if (l.vault_id === link.vault_id && l.chat_id === link.chat_id && !isSigned(l)) {
          l.legacy_notified = true;
        }
      }
      return { result: undefined, write: true };
    });
  }

  /**
   * The chat in force, once active, approves its pending replacement: the new link takes over at
   * once with the old link's `activated_at`, the old link is removed, and the change is queued
   * for announcement. Null when there is nothing to approve or the chat in force is not active.
   */
  approveReplacement(
    vaultId: string,
    byChat: number,
    pendingChat: number,
    now: bigint,
  ): Promise<{ link: Link; replaced: Link } | null> {
    return this.run(now, (state) => {
      const { current, pending } = ownerPair(state, vaultId);
      if (!replacementDecider(current, pending, byChat, pendingChat, now)) {
        return { result: null, write: false };
      }
      const [old, next] = [current as Link, pending as Link];
      next.activated_at = old.activated_at as string;
      next.pending_replace_of = null;
      next.replaced_by = null;
      state.links = state.links.filter((l) => l !== old);
      noteActivation(state, next, old.chat_id);
      return { result: { link: next, replaced: old }, write: true };
    });
  }

  /** The chat in force, once active, cancels its pending replacement; returns the dropped link. */
  cancelReplacement(
    vaultId: string,
    byChat: number,
    pendingChat: number,
    now: bigint,
  ): Promise<Link | null> {
    return this.run(now, (state) => {
      const { current, pending } = ownerPair(state, vaultId);
      if (!replacementDecider(current, pending, byChat, pendingChat, now)) {
        return { result: null, write: false };
      }
      state.links = state.links.filter((l) => l !== pending);
      (current as Link).replaced_by = null;
      return { result: pending, write: true };
    });
  }

  /** Stores the grants and returns one fresh random token per grant, in order. */
  issueCallbacks(grants: Omit<CallbackGrant, "expires_at">[], now: bigint): Promise<string[]> {
    return this.exclusive(async () => {
      const state = await this.read();
      state.callbacks = Object.fromEntries(
        Object.entries(state.callbacks).filter(([, g]) => BigInt(g.expires_at) >= now),
      );
      const tokens = grants.map((grant) => {
        // 16 random bytes: 22 characters, well under Telegram's 64-byte callback data limit.
        const token = randomBytes(16).toString("base64url");
        state.callbacks[token] = { ...grant, expires_at: (now + CALLBACK_TTL_NS).toString() };
        return token;
      });
      await this.save(state);
      return tokens;
    });
  }

  async callback(token: string): Promise<CallbackGrant | null> {
    const callbacks = (await this.read()).callbacks;
    return Object.hasOwn(callbacks, token) ? (callbacks[token] ?? null) : null;
  }

  /** Whether any stored token's grant matches. */
  async hasCallback(match: (grant: CallbackGrant) => boolean): Promise<boolean> {
    return Object.values((await this.read()).callbacks).some(match);
  }

  /** Voids every token whose grant matches (all buttons of an answered request). */
  voidCallbacks(match: (grant: CallbackGrant) => boolean): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read();
      state.callbacks = Object.fromEntries(
        Object.entries(state.callbacks).filter(([, g]) => !match(g)),
      );
      await this.save(state);
    });
  }

  /** Opens (or reopens) the chat's typed-confirmation step; one per chat. */
  openPrompt(prompt: Prompt): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read();
      state.prompts = [...state.prompts.filter((p) => p.chat_id !== prompt.chat_id), prompt];
      await this.save(state);
    });
  }

  async prompt(chatId: number): Promise<Prompt | null> {
    return (await this.read()).prompts.find((p) => p.chat_id === chatId) ?? null;
  }

  closePrompts(match: (prompt: Prompt) => boolean): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read();
      state.prompts = state.prompts.filter((p) => !match(p));
      await this.save(state);
    });
  }
}

const empty = (): State => ({ links: [], codes: {}, nonces: {}, callbacks: {}, prompts: [] });

export class InMemoryLinkStore extends LinkStore {
  private state = empty();

  protected async load(): Promise<State> {
    return structuredClone(this.state);
  }

  protected async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class FileLinkStore extends LinkStore {
  constructor(private readonly path: string) {
    super();
  }

  protected async load(): Promise<State> {
    try {
      return { ...empty(), ...(JSON.parse(await readFile(this.path, "utf8")) as Partial<State>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }

  protected async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
