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
  /** NEAR time (ns) the window closes. */
  expires_at: U64;
}

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

/**
 * Lets every pending owner replacement whose `activated_at` has passed take over: the link it
 * replaced is removed. A pending link whose target is gone stands on its own.
 */
function promote(state: State, now: bigint): void {
  for (const link of [...state.links]) {
    if (!isSigned(link) || link.role !== "owner" || link.pending_replace_of == null) continue;
    const target = state.links.find(
      (l) => isOwnerOf(l, link.vault_id) && l.chat_id === link.pending_replace_of,
    );
    if (target && BigInt(link.activated_at as string) > now) continue;
    if (target) state.links = state.links.filter((l) => l !== target);
    link.pending_replace_of = null;
    link.replaced_by = null;
  }
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
   * Consumes a code and links the chat; null if the code is unknown or expired. A first owner
   * link activates after `OWNER_LINK_MATURITY_NS`; a later one is a pending replacement of the
   * link in force (superseding an earlier pending one), which the chat in force may approve or
   * cancel. Written before the caller answers the chat.
   */
  redeem(code: string, chatId: number, now: bigint): Promise<Redeemed | null> {
    return this.exclusive(async () => {
      const state = await this.read();
      const key = code.trim().toUpperCase();
      const pending = state.codes[key];
      if (!pending || BigInt(pending.expires_at) < now) return null;
      state.codes = Object.fromEntries(Object.entries(state.codes).filter(([c]) => c !== key));
      promote(state, now);
      const { vault_id: vaultId, role } = pending;
      const mine = (l: Link) => l.chat_id === chatId && l.vault_id === vaultId && l.role === role;
      const same = state.links.find((l) => mine(l) && isSigned(l));
      if (same) {
        await this.save(state);
        return { link: same, relinked: true, replaces: null, superseded: null, others: [] };
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
      const link: Link = {
        chat_id: chatId,
        vault_id: vaultId,
        account_id: pending.account_id,
        role,
        linked_at: iso(now),
        activated_at: (role === "owner" ? now + OWNER_LINK_MATURITY_NS : now).toString(),
        pending_replace_of: replaces?.chat_id ?? null,
        replaced_by: null,
      };
      const others = state.links.filter((l) => l.vault_id === vaultId);
      state.links.push(link);
      await this.save(state);
      return { link, relinked: false, replaces, superseded, others };
    });
  }

  async linksForVault(vaultId: string): Promise<Link[]> {
    return (await this.read()).links.filter((l) => l.vault_id === vaultId);
  }

  /** The owner link in force and its pending replacement, as of `now`. */
  async ownerLinks(vaultId: string, now: bigint): Promise<OwnerLinks> {
    const state = await this.read();
    promote(state, now);
    return ownerPair(state, vaultId);
  }

  /**
   * The chat in force approves its pending replacement: the new link takes over at once with the
   * old link's `activated_at`, and the old link is removed. Null when there is nothing to approve.
   */
  approveReplacement(
    vaultId: string,
    byChat: number,
    pendingChat: number,
    now: bigint,
  ): Promise<{ link: Link; replaced: Link } | null> {
    return this.exclusive(async () => {
      const state = await this.read();
      promote(state, now);
      const { current, pending } = ownerPair(state, vaultId);
      if (!current || !pending || current.chat_id !== byChat || pending.chat_id !== pendingChat) {
        return null;
      }
      pending.activated_at = current.activated_at as string;
      pending.pending_replace_of = null;
      pending.replaced_by = null;
      state.links = state.links.filter((l) => l !== current);
      await this.save(state);
      return { link: pending, replaced: current };
    });
  }

  /** The chat in force cancels its pending replacement; returns the dropped link. */
  cancelReplacement(
    vaultId: string,
    byChat: number,
    pendingChat: number,
    now: bigint,
  ): Promise<Link | null> {
    return this.exclusive(async () => {
      const state = await this.read();
      promote(state, now);
      const { current, pending } = ownerPair(state, vaultId);
      if (!current || !pending || current.chat_id !== byChat || pending.chat_id !== pendingChat) {
        return null;
      }
      state.links = state.links.filter((l) => l !== pending);
      current.replaced_by = null;
      await this.save(state);
      return pending;
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
